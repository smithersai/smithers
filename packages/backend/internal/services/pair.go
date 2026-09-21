package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// PairService backs the realtime multiplayer pair-coding feature. Room state
// (shared doc, conversation, presence with cursors/drafts, and the prompt
// collab buffer) lives in a single jsonb row mutated under a row lock. Current
// clients subscribe to that row through the realtime `pair_state` stream; writes
// still emit Postgres NOTIFY for the legacy /api/pair/stream endpoint.
//
// The shared model is Codex (ChatGPT subscription) run in a sandbox provider sandbox
// VM through the platform's own sandbox client.

const pairSeedDoc = "# shared.md\n\n" +
	"This document is edited by two people **and** one shared AI (Codex), live.\n\n" +
	"- Type in the editor — your collaborator sees every keystroke and cursor.\n" +
	"- Prompt the shared model — the reply lands in both consoles and edits this doc.\n"

// PairSandbox is the narrow slice of the sandbox provider client the service needs.
type PairSandbox interface {
	Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
}

// PairService coordinates room state + the shared model.
type PairService struct {
	pool        *pgxpool.Pool
	q           pairQuerier
	sandbox     PairSandbox
	landing     pairLandingCreator
	vmID        string
	workdir     string
	repoDir     string
	provider    string
	localAgents bool
}

type pairQuerier interface {
	GetPairState(ctx context.Context, roomID string) (db.GetPairStateRow, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}

type pairLandingCreator interface {
	CreateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, req CreateLandingRequestInput) (LandingRequestResponse, error)
}

// NewPairService constructs the service. sandbox may be nil (the model is then
// unavailable but realtime editing still works).
func NewPairService(pool *pgxpool.Pool, sandbox PairSandbox, landing *LandingService) *PairService {
	workdir := os.Getenv("SMITHERS_PAIR_CODEX_WORKDIR")
	if workdir == "" {
		workdir = "/opt/pair/workspace"
	}
	repoDir := strings.TrimSpace(os.Getenv("SMITHERS_PAIR_REPO_DIR"))
	if repoDir == "" {
		if wd, err := os.Getwd(); err == nil {
			repoDir = wd
		}
	}
	s := &PairService{
		pool:    pool,
		q:       db.New(pool),
		vmID:    strings.TrimSpace(os.Getenv("SMITHERS_PAIR_VM_ID")),
		workdir: workdir,
		repoDir: repoDir,
	}
	if landing != nil {
		s.landing = landing
	}
	if sandbox != nil {
		s.sandbox = sandbox
	}

	// Dispatcher selection. By default (no new env set) Pair uses the
	// sandbox provider/VM path. When SMITHERS_PAIR_LOCAL_AGENTS=true, run real
	// subscription CLIs on the host instead. The differences between the two are
	// the injected sandbox, vmID, and the local flag (which gates the VM-only
	// HOME/PATH prefix).
	provider := strings.TrimSpace(os.Getenv("SMITHERS_PAIR_PROVIDER"))
	if provider == "" {
		provider = "codex"
	}
	s.provider = provider
	s.localAgents = strings.EqualFold(strings.TrimSpace(os.Getenv("SMITHERS_PAIR_LOCAL_AGENTS")), "true")
	return s
}

type PairLandingResult struct {
	Available bool   `json:"available"`
	Number    int64  `json:"number,omitempty"`
	URL       string `json:"url,omitempty"`
	Message   string `json:"message,omitempty"`
}

var ErrUnsupportedPairProvider = errors.New("unsupported pair provider")

const pairRoomEditsNotAppliedMessage = "Pair room edits are not yet applied to the writable workspace, so they cannot be landed."

type PairTreeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

const pairMaxFileBytes = 512 * 1024

var pairHeavyDirs = map[string]bool{
	".git":         true,
	".jj":          true, // jj VCS internals
	".smithers":    true, // dogfood runtime state (execution logs)
	"node_modules": true,
	"dist":         true,
	"build":        true,
	".next":        true,
	".astro":       true,
	"coverage":     true,
	"tmp":          true,
	"vendor":       true,
	"target":       true, // rust build output
	"zig-out":      true, // zig build output
	".zig-cache":   true,
	".turbo":       true,
	".cache":       true,
}

var (
	pairFilepathAbs = filepath.Abs
	pairFilepathRel = filepath.Rel
	pairJSONMarshal = json.Marshal
	pairReadFile    = os.ReadFile
)

func (s *PairService) repoRoot() (string, error) {
	if s.repoDir == "" {
		return "", errors.New("pair repo dir is not configured")
	}
	root, err := pairFilepathAbs(s.repoDir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("pair repo dir is not a directory")
	}
	return root, nil
}

func (s *PairService) Tree(ctx context.Context) ([]PairTreeEntry, error) {
	root, err := s.repoRoot()
	if err != nil {
		return nil, err
	}
	if !hasPairGitDir(root) {
		return walkPairTree(root)
	}
	cmd := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "-co", "--exclude-standard")
	out, err := cmd.Output()
	if err != nil {
		return walkPairTree(root)
	}
	return pairTreeFromFiles(strings.Split(string(out), "\n")), nil
}

func pairTreeFromFiles(files []string) []PairTreeEntry {
	seenDirs := map[string]bool{}
	entries := make([]PairTreeEntry, 0, 256)
	for _, raw := range files {
		rel := strings.TrimSpace(filepath.ToSlash(raw))
		if rel == "" || shouldSkipPairPath(rel) {
			continue
		}
		parts := strings.Split(rel, "/")
		for i := 1; i < len(parts); i++ {
			dir := strings.Join(parts[:i], "/")
			if !seenDirs[dir] {
				seenDirs[dir] = true
				entries = append(entries, PairTreeEntry{Path: dir, Type: "directory"})
			}
		}
		entries = append(entries, PairTreeEntry{Path: rel, Type: "file"})
	}
	sortPairTree(entries)
	return entries
}

func walkPairTree(root string) ([]PairTreeEntry, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		rel, err := pairFilepathRel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if shouldSkipPairPath(rel) {
				return filepath.SkipDir
			}
			return nil
		}
		if shouldSkipPairPath(rel) {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return pairTreeFromFiles(files), nil
}

func sortPairTree(entries []PairTreeEntry) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Path == entries[j].Path {
			return entries[i].Type < entries[j].Type
		}
		return entries[i].Path < entries[j].Path
	})
}

func hasPairGitDir(root string) bool {
	_, err := os.Stat(filepath.Join(root, ".git"))
	return err == nil
}

func shouldSkipPairPath(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if pairHeavyDirs[part] {
			return true
		}
	}
	return false
}

func (s *PairService) File(ctx context.Context, rel string) (string, int64, error) {
	full, err := s.resolveRepoFile(rel)
	if err != nil {
		return "", 0, err
	}
	info, err := os.Stat(full)
	if err != nil {
		return "", 0, err
	}
	if info.IsDir() {
		return "", 0, fs.ErrInvalid
	}
	if info.Size() > pairMaxFileBytes {
		return "", info.Size(), errors.New("file too large")
	}
	data, err := pairReadFile(full)
	if err != nil {
		return "", 0, err
	}
	return string(data), info.Size(), nil
}

func (s *PairService) Diff(ctx context.Context, room string) (string, string, error) {
	root, err := s.repoRoot()
	if err != nil {
		return "", "", err
	}
	workspaceDiff, note := s.workspaceGitDiff(ctx, root)
	var diff strings.Builder
	diff.WriteString(workspaceDiff)
	roomDiff, err := s.pairStateFilesDiff(ctx, room)
	if err != nil {
		return "", "", err
	}
	appendPairDiff(&diff, roomDiff)
	return diff.String(), note, nil
}

func (s *PairService) workspaceGitDiff(ctx context.Context, root string) (string, string) {
	var diff strings.Builder
	if !hasPairGitDir(root) {
		return "", "Diff includes Pair room edits only because this room is backed by a directory snapshot, not a writable git workspace."
	}
	out, err := exec.CommandContext(ctx, "git", "-C", root, "diff", "--no-ext-diff", "main", "--").Output()
	if err != nil {
		return "", "Diff includes Pair room edits only because git diff could not run for this room."
	}
	diff.Write(out)
	untracked, err := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "--others", "--exclude-standard").Output()
	if err != nil {
		return diff.String(), "Diff may omit untracked workspace files because git untracked-file discovery could not run for this room."
	}
	for _, raw := range strings.Split(string(untracked), "\n") {
		rel := strings.TrimSpace(filepath.ToSlash(raw))
		if rel == "" || shouldSkipPairPath(rel) {
			continue
		}
		fileDiff, _ := exec.CommandContext(ctx, "git", "-C", root, "diff", "--no-ext-diff", "--no-index", "--", "/dev/null", rel).CombinedOutput()
		if len(fileDiff) == 0 {
			continue
		}
		diff.Write(fileDiff)
		if !strings.HasSuffix(diff.String(), "\n") {
			diff.WriteString("\n")
		}
	}
	return diff.String(), ""
}

func appendPairDiff(b *strings.Builder, part string) {
	if strings.TrimSpace(part) == "" {
		return
	}
	if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
		b.WriteString("\n")
	}
	b.WriteString(part)
	if !strings.HasSuffix(part, "\n") {
		b.WriteString("\n")
	}
}

func (s *PairService) pairStateFilesDiff(ctx context.Context, room string) (string, error) {
	row, err := s.q.GetPairState(ctx, room)
	var st pairRoomState
	switch {
	case err == nil:
		if e := json.Unmarshal(row.State, &st); e != nil {
			return "", e
		}
		st.normalize()
	case errors.Is(err, pgx.ErrNoRows):
		return "", nil
	default:
		return "", err
	}

	paths := make([]string, 0, len(st.Files))
	contentByPath := map[string]string{}
	for rel, file := range st.Files {
		clean, ok := cleanPairMaterializedPath(rel)
		if !ok || len(file.Content) > pairMaxFileBytes {
			continue
		}
		if _, exists := contentByPath[clean]; !exists {
			paths = append(paths, clean)
		}
		contentByPath[clean] = file.Content
	}
	sort.Strings(paths)

	var diff strings.Builder
	for _, clean := range paths {
		next := contentByPath[clean]
		prev, _, err := s.File(ctx, clean)
		added := false
		switch {
		case err == nil:
			if prev == next {
				continue
			}
		case errors.Is(err, fs.ErrNotExist):
			added = true
		case errors.Is(err, fs.ErrInvalid), strings.Contains(err.Error(), "file too large"):
			continue
		default:
			continue
		}
		diff.WriteString(pairUnifiedFileDiff(clean, prev, next, added))
	}
	return diff.String(), nil
}

func pairUnifiedFileDiff(rel, oldContent, newContent string, added bool) string {
	oldLines := pairDiffLines(oldContent)
	newLines := pairDiffLines(newContent)
	var b strings.Builder
	b.WriteString("diff --git a/")
	b.WriteString(rel)
	b.WriteString(" b/")
	b.WriteString(rel)
	b.WriteString("\n")
	if added {
		b.WriteString("new file mode 100644\n")
		b.WriteString("--- /dev/null\n")
	} else {
		b.WriteString("--- a/")
		b.WriteString(rel)
		b.WriteString("\n")
	}
	b.WriteString("+++ b/")
	b.WriteString(rel)
	b.WriteString("\n")
	b.WriteString(fmt.Sprintf("@@ -1,%d +1,%d @@\n", len(oldLines), len(newLines)))
	for _, line := range oldLines {
		b.WriteByte('-')
		b.WriteString(line)
		b.WriteByte('\n')
	}
	for _, line := range newLines {
		b.WriteByte('+')
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}

func pairDiffLines(content string) []string {
	if content == "" {
		return nil
	}
	lines := strings.Split(content, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func (s *PairService) CreateLandingRequest(ctx context.Context, room string) (PairLandingResult, error) {
	if s.landing == nil {
		return PairLandingResult{Message: "Landing requests require a workspace-backed room."}, nil
	}
	actorIDRaw := strings.TrimSpace(os.Getenv("SMITHERS_PAIR_LANDING_ACTOR_ID"))
	if actorIDRaw == "" {
		return PairLandingResult{Message: "Landing requests require a workspace-backed room."}, nil
	}
	actorID, err := strconv.ParseInt(actorIDRaw, 10, 64)
	if err != nil || actorID <= 0 {
		return PairLandingResult{Message: "Landing creation is not configured: SMITHERS_PAIR_LANDING_ACTOR_ID must be a positive user id."}, nil
	}
	actor, err := s.q.GetUserByID(ctx, actorID)
	if err != nil {
		return PairLandingResult{Message: "Landing creation is not available: configured Pair landing actor was not found."}, nil
	}
	root, err := s.repoRoot()
	if err != nil {
		return PairLandingResult{Message: "Landing requests require a workspace-backed room."}, nil
	}
	if !hasPairGitDir(root) {
		return PairLandingResult{Message: "Landing requests require a workspace-backed room."}, nil
	}
	workspaceDiff, _ := s.workspaceGitDiff(ctx, root)
	roomDiff, err := s.pairStateFilesDiff(ctx, room)
	if err != nil {
		return PairLandingResult{Message: "Landing requests require a workspace-backed room."}, nil
	}
	if result, blocked := pairLandingDiffGate(workspaceDiff, roomDiff); blocked {
		return result, nil
	}
	changeID, err := currentPairChangeID(ctx, root)
	if err != nil {
		return PairLandingResult{Message: "Landing requests require a workspace-backed room."}, nil
	}
	owner, repo := pairLandingRepo()
	title, body := s.landingText(ctx, room)
	target := strings.TrimSpace(os.Getenv("SMITHERS_PAIR_LANDING_TARGET"))
	if target == "" {
		target = "main"
	}
	created, err := s.landing.CreateLandingRequest(ctx, &actor, owner, repo, CreateLandingRequestInput{
		Title:          title,
		Body:           body,
		TargetBookmark: target,
		ChangeIDs:      []string{changeID},
	})
	if err != nil {
		return PairLandingResult{Message: "Landing backend rejected the request: " + err.Error()}, nil
	}
	return PairLandingResult{Available: true, Number: created.Number, URL: pairLandingURL(owner, repo, created.Number)}, nil
}

func pairLandingDiffGate(workspaceDiff, roomDiff string) (PairLandingResult, bool) {
	if strings.TrimSpace(roomDiff) != "" {
		return PairLandingResult{Message: pairRoomEditsNotAppliedMessage}, true
	}
	if strings.TrimSpace(workspaceDiff) == "" {
		return PairLandingResult{Message: "No working-tree changes are available to land."}, true
	}
	return PairLandingResult{}, false
}

func currentPairChangeID(ctx context.Context, root string) (string, error) {
	out, err := exec.CommandContext(ctx, "jj", "--repository", root, "log", "-r", "@", "--no-graph", "-T", "change_id").Output()
	if err != nil {
		return "", err
	}
	changeID := strings.TrimSpace(string(out))
	if changeID == "" {
		return "", errors.New("empty change id")
	}
	return changeID, nil
}

func pairLandingRepo() (string, string) {
	ref := strings.TrimSpace(os.Getenv("SMITHERS_PAIR_LANDING_REPO"))
	if ref == "" {
		ref = "jjhub/plue"
	}
	parts := strings.SplitN(ref, "/", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return "jjhub", "plue"
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func pairLandingURL(owner, repo string, number int64) string {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("SMITHERS_PUBLIC_URL")), "/")
	if base == "" {
		base = "https://jjhub.tech"
	}
	return fmt.Sprintf("%s/%s/%s/landings/%d", base, owner, repo, number)
}

func (s *PairService) landingText(ctx context.Context, room string) (string, string) {
	title := strings.TrimSpace(os.Getenv("SMITHERS_PAIR_LANDING_TITLE"))
	body := strings.TrimSpace(os.Getenv("SMITHERS_PAIR_LANDING_BODY"))
	if title != "" && body != "" {
		return title, body
	}
	snap, err := s.Snapshot(ctx, room)
	if err == nil {
		if st, ok := snap["state"].(pairRoomState); ok {
			doc := strings.TrimSpace(st.Doc.Content)
			if title == "" {
				for _, line := range strings.Split(doc, "\n") {
					line = strings.TrimSpace(strings.TrimPrefix(line, "#"))
					if line != "" {
						title = line
						break
					}
				}
			}
			if body == "" {
				body = doc
			}
		}
	}
	if title == "" {
		title = "Pair landing request"
	}
	if body == "" {
		body = "Created from Smithers Pair room " + room + "."
	}
	return title, body
}

func (s *PairService) resolveRepoFile(rel string) (string, error) {
	root, err := s.repoRoot()
	if err != nil {
		return "", err
	}
	rel = filepath.ToSlash(strings.TrimSpace(rel))
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\x00") || shouldSkipPairPath(rel) {
		return "", fs.ErrInvalid
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
		return "", fs.ErrInvalid
	}
	full := filepath.Join(root, clean)
	if resolved, err := filepath.EvalSymlinks(full); err == nil {
		rootWithSep := root + string(filepath.Separator)
		if resolved != root && !strings.HasPrefix(resolved, rootWithSep) {
			return "", fs.ErrInvalid
		}
	}
	return full, nil
}

// EnsureSchema creates the pair_state table if it is missing. Prod migrations
// are applied manually (migration 000079), and the table is small + idempotent,
// so the service self-heals its schema at startup as a safety net.
func (s *PairService) EnsureSchema(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS pair_state (
		room_id    TEXT PRIMARY KEY,
		state      JSONB NOT NULL,
		version    BIGINT NOT NULL DEFAULT 0,
		updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`)
	return err
}

// ---- state model (marshaled into the pair_state.state jsonb column) ----

type pairDoc struct {
	Content   string `json:"content"`
	Version   int64  `json:"version"`
	UpdatedBy string `json:"updated_by"`
}
type pairFile struct {
	Content   string `json:"content"`
	Version   int64  `json:"version"`
	UpdatedBy string `json:"updated_by"`
}
type pairMessage struct {
	ID        string `json:"id"`
	Seq       int64  `json:"seq"`
	Author    string `json:"author"`
	Color     string `json:"color"`
	Role      string `json:"role"`
	Text      string `json:"text"`
	Output    string `json:"output,omitempty"` // full Codex tool output (assistant)
	CreatedAt string `json:"created_at"`
}

// pairAgentRun is a live indicator of an in-flight Codex run (nil when idle).
type pairAgentRun struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Color     string `json:"color"`
	Prompt    string `json:"prompt"`
	Status    string `json:"status"` // running | done | error
	Phase     string `json:"phase"`  // human-readable progress phase
	Output    string `json:"output,omitempty"`
	StartedAt int64  `json:"started_at"`
}
type pairPresence struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Cursor      *int   `json:"cursor"`
	FilePath    string `json:"file_path"`
	Draft       string `json:"draft"`
	PromptFocus bool   `json:"prompt_focus"`
	LastSeen    int64  `json:"last_seen"`
}
type pairPrompt struct {
	Collab    bool   `json:"collab"`
	Content   string `json:"content"`
	Version   int64  `json:"version"`
	UpdatedBy string `json:"updated_by"`
}
type pairRoomState struct {
	Doc      pairDoc                 `json:"doc"`
	Files    map[string]pairFile     `json:"files"`
	Messages []pairMessage           `json:"messages"`
	Presence map[string]pairPresence `json:"presence"`
	Prompt   pairPrompt              `json:"prompt"`
	Agent    *pairAgentRun           `json:"agent"`
	MsgSeq   int64                   `json:"msg_seq"`
}

func newPairRoomState() pairRoomState {
	return pairRoomState{
		Doc:      pairDoc{Content: pairSeedDoc, Version: 1, UpdatedBy: "smithers"},
		Files:    map[string]pairFile{},
		Messages: []pairMessage{},
		Presence: map[string]pairPresence{},
		Prompt:   pairPrompt{Collab: false, Content: "", Version: 1},
	}
}

func (st *pairRoomState) normalize() {
	if st.Files == nil {
		st.Files = map[string]pairFile{}
	}
	if st.Presence == nil {
		st.Presence = map[string]pairPresence{}
	}
	if st.Messages == nil {
		st.Messages = []pairMessage{}
	}
}

const presenceTTLms = 30_000

func nowMS() int64 { return time.Now().UnixMilli() }

// reap removes presence entries that have not heartbeat within the TTL.
func (st *pairRoomState) reap() {
	cutoff := nowMS() - presenceTTLms
	for id, p := range st.Presence {
		if p.LastSeen < cutoff {
			delete(st.Presence, id)
		}
	}
}

// mutate runs fn against the locked room state, persists it, and emits the
// event fn returns (nil event = no notify).
func (s *PairService) mutate(ctx context.Context, room string, fn func(st *pairRoomState) map[string]any) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)

	var st pairRoomState
	var version int64
	row, err := q.GetPairStateForUpdate(ctx, room)
	switch {
	case err == nil:
		version = row.Version
		if e := json.Unmarshal(row.State, &st); e != nil {
			st = newPairRoomState()
		}
		st.normalize()
	case errors.Is(err, pgx.ErrNoRows):
		st = newPairRoomState()
	default:
		return err
	}

	event := fn(&st)

	raw, err := pairJSONMarshal(&st)
	if err != nil {
		return err
	}
	if err := q.UpsertPairState(ctx, db.UpsertPairStateParams{RoomID: room, State: raw, Version: version + 1}); err != nil {
		return err
	}
	if event != nil {
		payload, err := pairJSONMarshal(event)
		if err != nil {
			return err
		}
		if err := q.NotifyPairRoom(ctx, db.NotifyPairRoomParams{RoomID: room, Payload: string(payload)}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Snapshot returns the current room state (creating a default if absent) for
// the SSE OnConnect replay.
func (s *PairService) Snapshot(ctx context.Context, room string) (map[string]any, error) {
	row, err := s.q.GetPairState(ctx, room)
	var st pairRoomState
	switch {
	case err == nil:
		if e := json.Unmarshal(row.State, &st); e != nil {
			st = newPairRoomState()
		}
		st.normalize()
	case errors.Is(err, pgx.ErrNoRows):
		st = newPairRoomState()
	default:
		return nil, err
	}
	st.reap()
	return map[string]any{"kind": "snapshot", "state": st}, nil
}

// ---- mutations ----

func (s *PairService) EditDoc(ctx context.Context, room, content, author string) error {
	return s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		st.Doc.Version++
		st.Doc.Content = content
		st.Doc.UpdatedBy = author
		return map[string]any{"kind": "doc", "doc": st.Doc}
	})
}

func (s *PairService) EditFile(ctx context.Context, room, rel, content, author string) error {
	full, err := s.resolveRepoFile(rel)
	if err != nil {
		return err
	}
	info, err := os.Stat(full)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fs.ErrInvalid
	}
	if len(content) > pairMaxFileBytes {
		return errors.New("file too large")
	}
	// Best-effort disk write: prod may serve the Pair repo from a read-only
	// volume, so a failed write must not block the collaborative edit. The
	// authoritative copy is the room state in Postgres; the agent run
	// materializes that state into its workdir before executing.
	_ = os.WriteFile(full, []byte(content), info.Mode().Perm())
	rel = filepath.ToSlash(strings.TrimSpace(rel))
	return s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		file := st.Files[rel]
		file.Version++
		file.Content = content
		file.UpdatedBy = author
		st.Files[rel] = file
		return map[string]any{"kind": "file", "path": rel, "file": file}
	})
}

func (s *PairService) UpdatePresence(ctx context.Context, room string, p pairPresence) error {
	return s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		p.LastSeen = nowMS()
		st.Presence[p.ID] = p
		st.reap()
		return map[string]any{"kind": "presence", "presence": p}
	})
}

func (s *PairService) Leave(ctx context.Context, room, clientID string) error {
	return s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		delete(st.Presence, clientID)
		return map[string]any{"kind": "presence_leave", "id": clientID}
	})
}

func (s *PairService) SetCollab(ctx context.Context, room string, collab bool) error {
	return s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		st.Prompt.Collab = collab
		st.Prompt.Version++
		return map[string]any{"kind": "prompt", "prompt": st.Prompt}
	})
}

func (s *PairService) EditDraft(ctx context.Context, room, content, author string) error {
	return s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		st.Prompt.Content = content
		st.Prompt.Version++
		st.Prompt.UpdatedBy = author
		return map[string]any{"kind": "prompt", "prompt": st.Prompt}
	})
}

// SubmitPrompt appends the user message immediately and kicks off the model
// out-of-band; the reply + doc edit reach clients via NOTIFY when ready.
func (s *PairService) SubmitPrompt(ctx context.Context, room, prompt, author, color string, clearShared bool, provider string) error {
	effProvider, err := normalizePairAgentProvider(provider, s.provider)
	if err != nil {
		return err
	}
	var runID string
	if err := s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		if clearShared {
			st.Prompt.Content = ""
			st.Prompt.Version++
		}
		msg := s.appendMessage(st, author, color, "user", prompt)
		runID = "run-" + msg.ID
		st.Agent = &pairAgentRun{
			ID: runID, Author: author, Color: color, Prompt: prompt,
			Status: "running", Phase: "starting " + effProvider + "…", StartedAt: nowMS(),
		}
		return map[string]any{"kind": "message", "message": msg, "prompt": st.Prompt, "agent": st.Agent}
	}); err != nil {
		return err
	}
	go s.runModel(room, prompt, runID, effProvider)
	return nil
}

func normalizePairAgentProvider(requested, fallback string) (string, error) {
	provider := strings.ToLower(strings.TrimSpace(requested))
	if provider == "" {
		provider = strings.ToLower(strings.TrimSpace(fallback))
	}
	if provider == "" {
		provider = "codex"
	}
	if provider != "codex" {
		return "", fmt.Errorf("%w: %s", ErrUnsupportedPairProvider, provider)
	}
	return "codex", nil
}

func (s *PairService) appendMessage(st *pairRoomState, author, color, role, text string) pairMessage {
	st.MsgSeq++
	msg := pairMessage{
		ID: fmt.Sprintf("m%d", st.MsgSeq), Seq: st.MsgSeq,
		Author: author, Color: color, Role: role, Text: text,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	st.Messages = append(st.Messages, msg)
	if len(st.Messages) > 200 {
		st.Messages = st.Messages[len(st.Messages)-200:]
	}
	return msg
}

// dispatcherFor builds the per-run agent dispatcher for a provider, choosing the
// local-CLI path or the sandbox provider/VM path. Built per run so the configured
// provider, sandbox, vmID, and local flag are captured at dispatch time.
func (s *PairService) dispatcherFor(provider string) execDispatcher {
	if strings.TrimSpace(provider) == "" {
		provider = s.provider
	}
	if s.localAgents {
		return execDispatcher{sandbox: localExec{provider: provider}, vmID: "", workdir: s.repoDir, local: true, provider: provider}
	}
	return execDispatcher{sandbox: s.sandbox, vmID: s.vmID, workdir: s.workdir, local: false, provider: provider}
}

// runModel runs the shared coding agent for `provider` and applies the result,
// clearing the live agent indicator and attaching the full tool output.
func (s *PairService) runModel(room, prompt, runID, provider string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Read the authoritative room state and materialize it into the agent
	// workdir before the command runs. The checkout is a convenience for tree,
	// diff, and landing operations; it is not the source of truth for live edits.
	snap, err := s.Snapshot(ctx, room)
	snapshot := pairAgentSnapshot{Doc: pairSeedDoc, Files: map[string]string{}}
	if err == nil {
		if state, ok := snap["state"].(pairRoomState); ok {
			snapshot = pairAgentSnapshotFromState(state)
		}
	}

	_ = s.updateAgent(ctx, room, runID, "running "+provider+" in repo…", "")
	result, runErr := s.dispatcherFor(provider).Run(ctx, prompt, snapshot)
	reply, output, newDoc, changedFiles := result.Reply, result.Output, result.NewDoc, result.ChangedFiles
	_ = s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		if st.Agent != nil && st.Agent.ID == runID {
			st.Agent = nil // the run is finished; the assistant message carries the result
		}
		if runErr != nil {
			msg := s.appendMessage(st, "Smithers AI", "#F05252", "assistant", "⚠️ "+truncate(runErr.Error(), 200))
			msg.Output = output
			st.Messages[len(st.Messages)-1].Output = output
			return map[string]any{"kind": "message", "message": st.Messages[len(st.Messages)-1], "agent": nil}
		}
		msg := s.appendMessage(st, "Smithers AI", "#9061F9", "assistant", reply)
		st.Messages[len(st.Messages)-1].Output = output
		msg.Output = output
		ev := map[string]any{"kind": "message", "message": st.Messages[len(st.Messages)-1], "agent": nil}
		if newDoc != "" && newDoc != st.Doc.Content {
			st.Doc.Version++
			st.Doc.Content = newDoc
			st.Doc.UpdatedBy = "Smithers AI"
			ev["doc"] = st.Doc
		}
		changed := map[string]pairFile{}
		for _, rel := range changedFiles {
			content, ok := result.ChangedFileContents[rel]
			if !ok {
				var ferr error
				content, _, ferr = s.File(ctx, rel)
				if ferr != nil {
					continue
				}
			}
			file := st.Files[rel]
			file.Version++
			file.Content = content
			file.UpdatedBy = "Smithers AI"
			st.Files[rel] = file
			changed[rel] = file
		}
		if len(changed) > 0 {
			ev["files"] = changed
		}
		return ev
	})
}

func pairAgentSnapshotFromState(st pairRoomState) pairAgentSnapshot {
	snap := pairAgentSnapshot{Doc: st.Doc.Content, Files: make(map[string]string, len(st.Files))}
	for rel, file := range st.Files {
		snap.Files[rel] = file.Content
	}
	return snap
}

func (s *PairService) updateAgent(ctx context.Context, room, runID, phase, output string) error {
	return s.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		if st.Agent == nil || st.Agent.ID != runID {
			return nil
		}
		st.Agent.Phase = phase
		st.Agent.Output = output
		return map[string]any{"kind": "agent", "agent": st.Agent}
	})
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// MakePresence builds a presence record from request fields.
func MakePresence(id, name, color string, cursor *int, filePath, draft string, promptFocus bool) pairPresence {
	return pairPresence{ID: id, Name: name, Color: color, Cursor: cursor, FilePath: filePath, Draft: draft, PromptFocus: promptFocus}
}
