package services

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	defaultGitHubGitBaseURL = "https://github.com"
	gitMirrorSyncTimeout    = 10 * time.Minute

	gitMirrorRunSucceeded = "succeeded"
	gitMirrorRunFailed    = "failed"

	gitMirrorRefPending   = "pending"
	gitMirrorRefSucceeded = "succeeded"
	gitMirrorRefFailed    = "failed"

	gitMirrorActiveRunConstraint = "uq_github_mirror_sync_runs_active"
)

// GitMirrorSyncQuerier is the durable run and per-ref result store used by the
// mirror sync service. The repository-scoped lookup prevents a run ID from
// being read through a different repository URL.
type GitMirrorSyncQuerier interface {
	CreateGithubMirrorSyncRun(context.Context, db.CreateGithubMirrorSyncRunParams) (db.GithubMirrorSyncRun, error)
	GetGithubMirrorSyncRun(context.Context, db.GetGithubMirrorSyncRunParams) (db.GithubMirrorSyncRun, error)
	MarkGithubMirrorSyncRunRunning(context.Context, int64) (int64, error)
	FinishGithubMirrorSyncRun(context.Context, db.FinishGithubMirrorSyncRunParams) error
	FinishSuccessfulGithubMirrorSyncRun(context.Context, db.FinishSuccessfulGithubMirrorSyncRunParams) (int64, error)
	UpsertGithubMirrorSyncRefResult(context.Context, db.UpsertGithubMirrorSyncRefResultParams) error
	ListGithubMirrorSyncRefResults(context.Context, int64) ([]db.GithubMirrorSyncRefResult, error)
	GetLatestGithubMirrorSyncRefResult(context.Context, db.GetLatestGithubMirrorSyncRefResultParams) (db.GithubMirrorSyncRefResult, error)
}

type GitMirrorSyncService struct {
	queries        GitMirrorSyncQuerier
	resolveRemotes func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error)

	runGitSync     func(ctx context.Context, args ...string) error
	runGitRefSync  func(ctx context.Context, sourceURL, targetURL, ref, targetRevision string) error
	listRemoteRefs func(ctx context.Context, remote string) (map[string]string, error)
	launch         func(name string, fn func())
}

type GitMirrorSyncRefResult struct {
	Name   string `json:"name"`
	From   string `json:"from"`
	To     string `json:"to"`
	Status string `json:"status"`
	Error  string `json:"error"`
}

type GitMirrorSyncRunResult struct {
	ID         int64                    `json:"id"`
	State      string                   `json:"state"`
	BehindRefs int                      `json:"behind_refs"`
	FailedRefs int                      `json:"failed_refs"`
	StartedAt  *time.Time               `json:"started_at"`
	FinishedAt *time.Time               `json:"finished_at"`
	Refs       []GitMirrorSyncRefResult `json:"refs"`
}

// GitHubReconcileResult preserves the pollable mirror-run fields while also
// exposing the run_id alias used by mirror-sync trigger responses.
type GitHubReconcileResult struct {
	RunID int64 `json:"run_id"`
	GitMirrorSyncRunResult
}

func NewGitMirrorSyncService(queries GitMirrorSyncQuerier, options ...GitMirrorSyncOption) *GitMirrorSyncService {
	s := &GitMirrorSyncService{
		queries:        queries,
		resolveRemotes: legacyMirrorRemotes,
		runGitSync: func(ctx context.Context, args ...string) error {
			cmd := mirrorCommand(ctx, "git-sync", args...)
			out, err := cmd.CombinedOutput()
			if err != nil {
				trimmed := strings.TrimSpace(string(out))
				if trimmed == "" {
					return fmt.Errorf("git-sync failed: %w", err)
				}
				return fmt.Errorf("git-sync failed: %w: %s", err, trimmed)
			}
			return nil
		},
		runGitRefSync:  defaultRunGitRefSync,
		listRemoteRefs: defaultListRemoteRefs,
		launch:         SafeGo,
	}
	for _, option := range options {
		option(s)
	}
	return s
}

// StartMirrorSync creates the durable run before launching detached work. The
// request context is deliberately not inherited by the worker: it is cancelled
// as soon as the POST response has been written.
func (s *GitMirrorSyncService) StartMirrorSync(ctx context.Context, userID, repositoryID int64, owner, repo string) (int64, error) {
	run, err := s.startMirrorSync(ctx, userID, repositoryID, owner, repo)
	if err != nil {
		return 0, err
	}
	return run.ID, nil
}

// StartGitHubReconcile enqueues a repository-scoped mirror reconciliation and
// returns the durable run DTO that callers use for subsequent polling.
func (s *GitMirrorSyncService) StartGitHubReconcile(ctx context.Context, userID, repositoryID int64, owner, repo string) (GitHubReconcileResult, error) {
	run, err := s.startMirrorSync(ctx, userID, repositoryID, owner, repo)
	if err != nil {
		return GitHubReconcileResult{}, err
	}
	return GitHubReconcileResult{
		RunID:                  run.ID,
		GitMirrorSyncRunResult: gitMirrorSyncRunResult(run, nil),
	}, nil
}

func (s *GitMirrorSyncService) startMirrorSync(ctx context.Context, userID, repositoryID int64, owner, repo string) (db.GithubMirrorSyncRun, error) {
	if userID <= 0 {
		return db.GithubMirrorSyncRun{}, pkgerrors.Unauthorized("authentication required")
	}
	if repositoryID <= 0 {
		return db.GithubMirrorSyncRun{}, pkgerrors.BadRequest("repository is required")
	}

	normalizedOwner := strings.TrimSpace(owner)
	normalizedRepo := strings.TrimSpace(repo)
	if normalizedOwner == "" {
		return db.GithubMirrorSyncRun{}, pkgerrors.BadRequest("owner is required")
	}
	if normalizedRepo == "" {
		return db.GithubMirrorSyncRun{}, pkgerrors.BadRequest("repository name is required")
	}
	if s == nil || s.queries == nil {
		return db.GithubMirrorSyncRun{}, pkgerrors.Internal("git mirror sync store not configured")
	}
	if s.runGitSync == nil || s.listRemoteRefs == nil || s.launch == nil || s.resolveRemotes == nil {
		return db.GithubMirrorSyncRun{}, pkgerrors.Internal("git mirror sync runner not configured")
	}

	remotes, err := s.resolveRemotes(ctx, userID, repositoryID, normalizedOwner, normalizedRepo)
	if err != nil {
		return db.GithubMirrorSyncRun{}, err
	}

	run, err := s.queries.CreateGithubMirrorSyncRun(ctx, db.CreateGithubMirrorSyncRunParams{
		RepositoryID: repositoryID,
		RequestedBy:  pgtype.Int8{Int64: userID, Valid: true},
	})
	if err != nil {
		remotes.close()
		if isGitMirrorActiveRunConflict(err) {
			return db.GithubMirrorSyncRun{}, pkgerrors.Conflict("git mirror sync already running")
		}
		return db.GithubMirrorSyncRun{}, pkgerrors.Internal("failed to create git mirror sync run")
	}

	s.launch("git-mirror-sync", func() {
		defer remotes.close()
		s.runMirrorSyncDetached(run.ID, remotes.sourceURL, remotes.targetURL)
	})
	return run, nil
}

func (s *GitMirrorSyncService) GetMirrorSyncRun(ctx context.Context, repositoryID, runID int64) (GitMirrorSyncRunResult, error) {
	if repositoryID <= 0 {
		return GitMirrorSyncRunResult{}, pkgerrors.BadRequest("repository is required")
	}
	if runID <= 0 {
		return GitMirrorSyncRunResult{}, pkgerrors.BadRequest("invalid mirror sync run id")
	}
	if s == nil || s.queries == nil {
		return GitMirrorSyncRunResult{}, pkgerrors.Internal("git mirror sync store not configured")
	}

	run, err := s.queries.GetGithubMirrorSyncRun(ctx, db.GetGithubMirrorSyncRunParams{
		ID:           runID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GitMirrorSyncRunResult{}, pkgerrors.NotFound("mirror sync run not found")
		}
		return GitMirrorSyncRunResult{}, pkgerrors.Internal("failed to get git mirror sync run")
	}
	refs, err := s.queries.ListGithubMirrorSyncRefResults(ctx, run.ID)
	if err != nil {
		return GitMirrorSyncRunResult{}, pkgerrors.Internal("failed to list git mirror sync ref results")
	}

	return gitMirrorSyncRunResult(run, refs), nil
}

func gitMirrorSyncRunResult(run db.GithubMirrorSyncRun, refs []db.GithubMirrorSyncRefResult) GitMirrorSyncRunResult {
	result := GitMirrorSyncRunResult{
		ID:    run.ID,
		State: run.State,
		Refs:  make([]GitMirrorSyncRefResult, 0, len(refs)),
	}
	if run.StartedAt.Valid {
		startedAt := run.StartedAt.Time
		result.StartedAt = &startedAt
	}
	if run.FinishedAt.Valid {
		finishedAt := run.FinishedAt.Time
		result.FinishedAt = &finishedAt
	}
	for _, ref := range refs {
		result.Refs = append(result.Refs, GitMirrorSyncRefResult{
			Name:   ref.Name,
			From:   ref.FromRevision,
			To:     ref.ToRevision,
			Status: ref.Status,
			Error:  ref.Error,
		})
		if ref.Status != gitMirrorRefSucceeded {
			result.BehindRefs++
		}
		if ref.Status == gitMirrorRefFailed {
			result.FailedRefs++
		}
	}
	return result
}

func isGitMirrorActiveRunConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) &&
		pgErr.Code == "23505" &&
		pgErr.ConstraintName == gitMirrorActiveRunConstraint
}

// RetryMirrorRef creates a new durable run containing only the named ref. The
// latest recorded outcome must still be failed so a stale card cannot replay a
// ref that a newer run has already repaired.
func (s *GitMirrorSyncService) RetryMirrorRef(ctx context.Context, userID, repositoryID int64, owner, repo, ref string) (int64, error) {
	if userID <= 0 {
		return 0, pkgerrors.Unauthorized("authentication required")
	}
	if repositoryID <= 0 {
		return 0, pkgerrors.BadRequest("repository is required")
	}
	owner = strings.TrimSpace(owner)
	repo = strings.TrimSpace(repo)
	ref = strings.TrimSpace(ref)
	if owner == "" || repo == "" {
		return 0, pkgerrors.BadRequest("owner and repository are required")
	}
	if !isMirroredGitRef(ref) || len(ref) > 1024 || strings.ContainsAny(ref, "\x00\r\n") {
		return 0, pkgerrors.BadRequest("invalid git ref")
	}
	if s == nil || s.queries == nil {
		return 0, pkgerrors.Internal("git mirror sync store not configured")
	}
	if s.runGitRefSync == nil || s.listRemoteRefs == nil || s.launch == nil || s.resolveRemotes == nil {
		return 0, pkgerrors.Internal("git mirror sync runner not configured")
	}

	latest, err := s.queries.GetLatestGithubMirrorSyncRefResult(ctx, db.GetLatestGithubMirrorSyncRefResultParams{
		RepositoryID: repositoryID,
		Name:         ref,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, pkgerrors.NotFound("mirror ref result not found")
		}
		return 0, pkgerrors.Internal("failed to get mirror ref result")
	}
	if latest.Status != gitMirrorRefFailed {
		return 0, pkgerrors.Conflict("mirror ref is not failed")
	}
	remotes, err := s.resolveRemotes(ctx, userID, repositoryID, owner, repo)
	if err != nil {
		return 0, err
	}
	run, err := s.queries.CreateGithubMirrorSyncRun(ctx, db.CreateGithubMirrorSyncRunParams{
		RepositoryID: repositoryID,
		RequestedBy:  pgtype.Int8{Int64: userID, Valid: true},
	})
	if err != nil {
		remotes.close()
		return 0, pkgerrors.Internal("failed to create git mirror sync run")
	}
	s.launch("git-mirror-ref-retry", func() {
		defer remotes.close()
		s.runMirrorRefRetryDetached(run.ID, ref, latest, remotes.sourceURL, remotes.targetURL)
	})
	return run.ID, nil
}

func (s *GitMirrorSyncService) runMirrorRefRetryDetached(runID int64, ref string, prior db.GithubMirrorSyncRefResult, sourceURL, targetURL string) {
	ctx, cancel := context.WithTimeout(context.Background(), gitMirrorSyncTimeout)
	defer cancel()
	finished := false
	finish := func(state string) {
		if finished {
			return
		}
		finished = true
		finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer finishCancel()
		if err := s.queries.FinishGithubMirrorSyncRun(finishCtx, db.FinishGithubMirrorSyncRunParams{State: state, ID: runID}); err != nil {
			slog.Error("git mirror ref retry finalization failed", "run_id", runID, "ref", ref, "state", state, "error", err)
		}
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("git mirror ref retry panicked", "run_id", runID, "ref", ref, "panic", recovered)
			finish(gitMirrorRunFailed)
		}
	}()
	claimed, err := s.queries.MarkGithubMirrorSyncRunRunning(ctx, runID)
	if err != nil || claimed != 1 {
		if err != nil {
			slog.Error("git mirror ref retry could not mark run running", "run_id", runID, "ref", ref, "error", err)
			finish(gitMirrorRunFailed)
		}
		return
	}
	priorChange := gitMirrorRefChange{name: ref, from: prior.FromRevision, to: prior.ToRevision}
	if err := s.storeMirrorRefResult(ctx, runID, priorChange, gitMirrorRefPending, ""); err != nil {
		finish(gitMirrorRunFailed)
		return
	}
	sourceRefs, err := s.listRemoteRefs(ctx, sourceURL)
	if err != nil {
		_ = s.storeMirrorRefResult(ctx, runID, priorChange, gitMirrorRefFailed, sanitizeMirrorError(err, sourceURL, targetURL))
		finish(gitMirrorRunFailed)
		return
	}
	targetRefs, err := s.listRemoteRefs(ctx, targetURL)
	if err != nil {
		_ = s.storeMirrorRefResult(ctx, runID, priorChange, gitMirrorRefFailed, sanitizeMirrorError(err, sourceURL, targetURL))
		finish(gitMirrorRunFailed)
		return
	}
	change := gitMirrorRefChange{name: ref, from: targetRefs[ref], to: sourceRefs[ref]}
	if change.from == "" && change.to == "" {
		change = priorChange
	}
	if err := s.storeMirrorRefResult(ctx, runID, change, gitMirrorRefPending, ""); err != nil {
		finish(gitMirrorRunFailed)
		return
	}
	if mirrorRefReached(change, targetRefs) {
		if err := s.storeMirrorRefResult(ctx, runID, change, gitMirrorRefSucceeded, ""); err != nil {
			finish(gitMirrorRunFailed)
			return
		}
		finish(gitMirrorRunSucceeded)
		return
	}
	syncErr := s.runGitRefSync(ctx, sourceURL, targetURL, ref, change.to)
	afterRefs, verifyErr := s.listRemoteRefs(ctx, targetURL)
	if syncErr == nil && verifyErr == nil && mirrorRefReached(change, afterRefs) {
		if err := s.storeMirrorRefResult(ctx, runID, change, gitMirrorRefSucceeded, ""); err != nil {
			finish(gitMirrorRunFailed)
			return
		}
		finish(gitMirrorRunSucceeded)
		return
	}
	message := "GitHub ref did not reach the expected revision"
	if syncErr != nil {
		message = sanitizeMirrorError(syncErr, sourceURL, targetURL)
	} else if verifyErr != nil {
		message = sanitizeMirrorError(verifyErr, sourceURL, targetURL)
	}
	_ = s.storeMirrorRefResult(ctx, runID, change, gitMirrorRefFailed, message)
	finish(gitMirrorRunFailed)
}

type gitMirrorRefChange struct {
	name string
	from string
	to   string
}

func (s *GitMirrorSyncService) runMirrorSyncDetached(runID int64, sourceURL, targetURL string) {
	ctx, cancel := context.WithTimeout(context.Background(), gitMirrorSyncTimeout)
	defer cancel()

	var verifiedRefs map[string]string
	finished := false
	finish := func(state string) {
		if finished {
			return
		}
		finished = true
		finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer finishCancel()
		if state == gitMirrorRunSucceeded {
			refs, _ := json.Marshal(verifiedRefs)
			rows, err := s.queries.FinishSuccessfulGithubMirrorSyncRun(finishCtx, db.FinishSuccessfulGithubMirrorSyncRunParams{ID: runID, VerifiedRefs: refs})
			if err != nil || rows != 1 {
				slog.Error("git mirror health finalization failed", "run_id", runID, "rows", rows, "error", err)
			}
			return
		}
		if err := s.queries.FinishGithubMirrorSyncRun(finishCtx, db.FinishGithubMirrorSyncRunParams{State: state, ID: runID}); err != nil {
			slog.Error("git mirror sync finalization failed", "run_id", runID, "state", state, "error", err)
		}
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("git mirror sync panicked", "run_id", runID, "panic", recovered)
			finish(gitMirrorRunFailed)
		}
	}()

	claimed, err := s.queries.MarkGithubMirrorSyncRunRunning(ctx, runID)
	if err != nil {
		slog.Error("git mirror sync could not mark run running", "run_id", runID, "error", err)
		finish(gitMirrorRunFailed)
		return
	}
	if claimed != 1 {
		return
	}

	sourceRefs, err := s.listRemoteRefs(ctx, sourceURL)
	if err != nil {
		slog.Error("git mirror sync could not list source refs", "run_id", runID, "error", sanitizeMirrorError(err, sourceURL, targetURL))
		finish(gitMirrorRunFailed)
		return
	}
	targetRefs, err := s.listRemoteRefs(ctx, targetURL)
	if err != nil {
		message := sanitizeMirrorError(err, sourceURL, targetURL)
		for _, change := range mirrorRefChanges(sourceRefs, nil) {
			_ = s.storeMirrorRefResult(ctx, runID, change, gitMirrorRefFailed, message)
		}
		finish(gitMirrorRunFailed)
		return
	}

	changes := mirrorRefChanges(sourceRefs, targetRefs)
	for _, change := range changes {
		if err := s.storeMirrorRefResult(ctx, runID, change, gitMirrorRefPending, ""); err != nil {
			slog.Error("git mirror sync could not record pending ref", "run_id", runID, "ref", change.name, "error", err)
			finish(gitMirrorRunFailed)
			return
		}
	}

	syncArgs := []string{"sync", "--prune", "--tags", "--all-refs"}
	for _, prefix := range excludedMirrorRefPrefixes {
		syncArgs = append(syncArgs, "--exclude-ref-prefix", prefix)
	}
	syncArgs = append(syncArgs, sourceURL, targetURL)
	syncErr := s.runGitSync(ctx, syncArgs...)
	afterRefs, listErr := s.listRemoteRefs(ctx, targetURL)
	if listErr != nil {
		message := sanitizeMirrorError(listErr, sourceURL, targetURL)
		if syncErr != nil {
			message = sanitizeMirrorError(syncErr, sourceURL, targetURL) + "; verification failed: " + message
		}
		for _, change := range changes {
			_ = s.storeMirrorRefResult(ctx, runID, change, gitMirrorRefFailed, message)
		}
		finish(gitMirrorRunFailed)
		return
	}

	failed := syncErr != nil || len(mirrorRefChanges(sourceRefs, afterRefs)) != 0
	for _, change := range changes {
		status := gitMirrorRefSucceeded
		message := ""
		if !mirrorRefReached(change, afterRefs) {
			failed = true
			status = gitMirrorRefFailed
			if syncErr != nil {
				message = sanitizeMirrorError(syncErr, sourceURL, targetURL)
			} else {
				message = "GitHub ref did not reach the expected revision"
			}
		}
		if err := s.storeMirrorRefResult(ctx, runID, change, status, message); err != nil {
			slog.Error("git mirror sync could not record ref result", "run_id", runID, "ref", change.name, "error", err)
			failed = true
		}
	}

	if failed {
		finish(gitMirrorRunFailed)
		return
	}
	verifiedRefs = afterRefs
	finish(gitMirrorRunSucceeded)
}

func (s *GitMirrorSyncService) storeMirrorRefResult(ctx context.Context, runID int64, change gitMirrorRefChange, status, message string) error {
	return s.queries.UpsertGithubMirrorSyncRefResult(ctx, db.UpsertGithubMirrorSyncRefResultParams{
		RunID:        runID,
		Name:         change.name,
		FromRevision: change.from,
		ToRevision:   change.to,
		Status:       status,
		Error:        message,
	})
}

// Keep transfer/pruning and verification/retry on the same namespace boundary.
// JJ retention and Smithers workspace/source refs are private control-plane
// state; GitHub owns pull refs. User notes and custom namespaces still mirror.
var excludedMirrorRefPrefixes = [...]string{"refs/jj/", "refs/pull/", "refs/smithers/"}

func isMirroredGitRef(ref string) bool {
	if !strings.HasPrefix(ref, "refs/") {
		return false
	}
	for _, prefix := range excludedMirrorRefPrefixes {
		if strings.HasPrefix(ref, prefix) {
			return false
		}
	}
	return true
}

func mirrorRefChanges(source, target map[string]string) []gitMirrorRefChange {
	names := make(map[string]struct{}, len(source)+len(target))
	for name := range source {
		names[name] = struct{}{}
	}
	for name := range target {
		names[name] = struct{}{}
	}

	changes := make([]gitMirrorRefChange, 0, len(names))
	for name := range names {
		if !isMirroredGitRef(name) {
			continue
		}
		from, to := target[name], source[name]
		if from == to {
			continue
		}
		changes = append(changes, gitMirrorRefChange{name: name, from: from, to: to})
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].name < changes[j].name })
	return changes
}

func mirrorRefReached(change gitMirrorRefChange, refs map[string]string) bool {
	actual, exists := refs[change.name]
	if change.to == "" {
		return !exists
	}
	return exists && actual == change.to
}

// Credentials stay out of argv and repository config files. Git uses URL-scoped
// HTTP headers; git-sync uses its own endpoint auth environment variables.
func mirrorCommand(ctx context.Context, binary string, args ...string) *exec.Cmd {
	safeArgs := append([]string(nil), args...)
	config := []string{}
	count := 0
	for i, arg := range safeArgs {
		remote, err := url.Parse(arg)
		if err != nil || remote.User == nil || (remote.Scheme != "https" && remote.Scheme != "http") {
			continue
		}
		password, _ := remote.User.Password()
		if binary == "git-sync" {
			// sync's final two arguments are source and target. Its go-git
			// transport does not consume Git's GIT_CONFIG_* HTTP headers.
			endpoint := ""
			if i == len(safeArgs)-2 {
				endpoint = "SOURCE"
			} else if i == len(safeArgs)-1 {
				endpoint = "TARGET"
			}
			if endpoint != "" {
				config = append(config, "GITSYNC_"+endpoint+"_TOKEN="+password, "GITSYNC_"+endpoint+"_USERNAME="+remote.User.Username())
			}
		}
		authorization := base64.StdEncoding.EncodeToString([]byte(remote.User.Username() + ":" + password))
		remote.User = nil
		safeArgs[i] = remote.String()
		config = append(config, "GIT_CONFIG_KEY_"+strconv.Itoa(count)+"=http."+remote.String()+".extraHeader", "GIT_CONFIG_VALUE_"+strconv.Itoa(count)+"=Authorization: Basic "+authorization)
		count++
	}
	cmd := exec.CommandContext(ctx, binary, safeArgs...)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "GITSYNC_") || strings.HasPrefix(entry, "GIT_CONFIG_COUNT=") || strings.HasPrefix(entry, "GIT_CONFIG_KEY_") || strings.HasPrefix(entry, "GIT_CONFIG_VALUE_") || strings.HasPrefix(entry, "GIT_TERMINAL_PROMPT=") {
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, config...)
	cmd.Env = append(cmd.Env, "GIT_CONFIG_COUNT="+strconv.Itoa(count), "GIT_TERMINAL_PROMPT=0")
	return cmd
}

func defaultListRemoteRefs(ctx context.Context, remote string) (map[string]string, error) {
	cmd := mirrorCommand(ctx, "git", "ls-remote", "--refs", remote)
	out, err := cmd.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			return nil, fmt.Errorf("git ls-remote failed: %w", err)
		}
		return nil, fmt.Errorf("git ls-remote failed: %w: %s", err, detail)
	}
	return parseRemoteRefs(string(out))
}

func defaultRunGitRefSync(ctx context.Context, sourceURL, targetURL, ref, targetRevision string) error {
	dir, err := os.MkdirTemp("", "smithers-git-ref-sync-")
	if err != nil {
		return fmt.Errorf("create git ref sync directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	if err := runMirrorGitCommand(ctx, "", "init", "--bare", dir); err != nil {
		return err
	}
	if targetRevision != "" {
		if err := runMirrorGitCommand(ctx, dir, "fetch", "--no-tags", sourceURL, "+"+ref+":"+ref); err != nil {
			return err
		}
		return runMirrorGitCommand(ctx, dir, "push", targetURL, ref+":"+ref)
	}
	return runMirrorGitCommand(ctx, dir, "push", targetURL, ":"+ref)
}

func runMirrorGitCommand(ctx context.Context, dir string, args ...string) error {
	cmd := mirrorCommand(ctx, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(string(out))
	if detail == "" {
		return fmt.Errorf("git command failed: %w", err)
	}
	return fmt.Errorf("git command failed: %w: %s", err, detail)
}

func parseRemoteRefs(output string) (map[string]string, error) {
	refs := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || !strings.HasPrefix(fields[1], "refs/") {
			return nil, fmt.Errorf("invalid git ls-remote output")
		}
		refs[fields[1]] = fields[0]
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read git ls-remote output: %w", err)
	}
	return refs, nil
}

func mirrorRemoteURLs(owner, repo string) (string, string, error) {
	sourceURL, err := gitMirrorURL(os.Getenv("SMITHERS_GIT_BASE_URL"), os.Getenv("SMITHERS_TOKEN"), owner, repo)
	if err != nil {
		return "", "", err
	}
	targetBaseURL := strings.TrimSpace(os.Getenv("SMITHERS_GITHUB_GIT_BASE_URL"))
	if targetBaseURL == "" {
		targetBaseURL = defaultGitHubGitBaseURL
	}
	targetURL, err := gitMirrorURL(targetBaseURL, os.Getenv("SMITHERS_GITHUB_TOKEN"), owner, repo)
	if err != nil {
		return "", "", err
	}
	return sourceURL, targetURL, nil
}

func sanitizeMirrorError(err error, remotes ...string) string {
	message := err.Error()
	for _, remote := range remotes {
		message = strings.ReplaceAll(message, remote, redactMirrorURL(remote))
		if parsed, parseErr := url.Parse(remote); parseErr == nil && parsed.User != nil {
			if secret, ok := parsed.User.Password(); ok && secret != "" {
				message = strings.ReplaceAll(message, secret, "[redacted]")
				message = strings.ReplaceAll(message, url.QueryEscape(secret), "[redacted]")
				basic := base64.StdEncoding.EncodeToString([]byte(parsed.User.Username() + ":" + secret))
				message = strings.ReplaceAll(message, basic, "[redacted]")
			}
		}
	}
	return message
}

func redactMirrorURL(remote string) string {
	parsed, err := url.Parse(remote)
	if err != nil || parsed.User == nil {
		return remote
	}
	parsed.User = url.UserPassword("***", "***")
	return parsed.String()
}

func gitMirrorURL(baseURL, token, owner, repo string) (string, error) {
	trimmedBase := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmedBase == "" {
		return "", fmt.Errorf("base URL is required")
	}
	parsed, err := url.Parse(trimmedBase)
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("base URL must include scheme and host")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + owner + "/" + repo + ".git"
	if trimmedToken := strings.TrimSpace(token); trimmedToken != "" {
		parsed.User = url.UserPassword("x-access-token", trimmedToken)
	}
	return parsed.String(), nil
}
