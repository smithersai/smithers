package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestPair_Cov_TreeFileAndRepoPathBranches(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "src"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "docs"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("hello\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "src", "app.go"), []byte("package main\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "node_modules", "pkg", "skip.js"), []byte("skip\n"), 0o644))

	svc := &PairService{repoDir: root, q: mockPairQuerier{}}
	entries, err := svc.Tree(context.Background())
	require.NoError(t, err)
	assert.Contains(t, entries, PairTreeEntry{Path: "README.md", Type: "file"})
	assert.Contains(t, entries, PairTreeEntry{Path: "src", Type: "directory"})
	assert.Contains(t, entries, PairTreeEntry{Path: "src/app.go", Type: "file"})
	assert.NotContains(t, entries, PairTreeEntry{Path: "node_modules/pkg/skip.js", Type: "file"})

	content, size, err := svc.File(context.Background(), " README.md ")
	require.NoError(t, err)
	assert.Equal(t, "hello\n", content)
	assert.Equal(t, int64(len("hello\n")), size)

	_, _, err = svc.File(context.Background(), "docs")
	assert.True(t, errors.Is(err, fs.ErrInvalid))
	_, _, err = svc.File(context.Background(), "../escape")
	assert.True(t, errors.Is(err, fs.ErrInvalid))

	large := strings.Repeat("x", pairMaxFileBytes+1)
	require.NoError(t, os.WriteFile(filepath.Join(root, "large.txt"), []byte(large), 0o644))
	_, gotSize, err := svc.File(context.Background(), "large.txt")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "file too large")
	assert.Equal(t, int64(len(large)), gotSize)

	_, err = (&PairService{}).repoRoot()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not configured")

	notDir := filepath.Join(root, "README.md")
	_, err = (&PairService{repoDir: notDir}).repoRoot()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not a directory")
}

func TestPair_Cov_DiffPairStateAndAppendBranches(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(root, "old.txt"), []byte("old\n"), 0o644))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "nested"), 0o755))

	st := newPairRoomState()
	st.Files["old.txt"] = pairFile{Content: "new\n", Version: 1, UpdatedBy: "pair"}
	st.Files["added.txt"] = pairFile{Content: "added\n", Version: 1, UpdatedBy: "pair"}
	st.Files["../escape"] = pairFile{Content: "bad\n", Version: 1, UpdatedBy: "pair"}
	st.Files["too-big.txt"] = pairFile{Content: strings.Repeat("x", pairMaxFileBytes+1), Version: 1, UpdatedBy: "pair"}
	raw, err := json.Marshal(st)
	require.NoError(t, err)

	svc := &PairService{repoDir: root, q: mockPairQuerier{stateJSON: raw}}
	diff, note, err := svc.Diff(context.Background(), "room")
	require.NoError(t, err)
	assert.Contains(t, note, "directory snapshot")
	assert.Contains(t, diff, "diff --git a/old.txt b/old.txt")
	assert.Contains(t, diff, "-old")
	assert.Contains(t, diff, "+new")
	assert.Contains(t, diff, "new file mode 100644")
	assert.Contains(t, diff, "+added")
	assert.NotContains(t, diff, "escape")
	assert.NotContains(t, diff, "too-big")

	noStateSvc := &PairService{repoDir: root, q: mockPairQuerier{}}
	roomDiff, err := noStateSvc.pairStateFilesDiff(context.Background(), "missing")
	require.NoError(t, err)
	assert.Empty(t, roomDiff)

	badStateSvc := &PairService{repoDir: root, q: mockPairQuerier{stateJSON: json.RawMessage(`{`)}}
	_, err = badStateSvc.pairStateFilesDiff(context.Background(), "bad")
	require.Error(t, err)

	var b strings.Builder
	appendPairDiff(&b, "")
	assert.Empty(t, b.String())
	b.WriteString("workspace")
	appendPairDiff(&b, "room")
	assert.Equal(t, "workspace\nroom\n", b.String())
}

func TestPair_Cov_CreateLandingConfigurationAndTextHelpers(t *testing.T) {
	t.Run("early configuration messages", func(t *testing.T) {
		noLanding := &PairService{q: mockPairQuerier{}}
		result, err := noLanding.CreateLandingRequest(context.Background(), "room")
		require.NoError(t, err)
		assert.Contains(t, result.Message, "workspace-backed room")

		withLanding := &PairService{q: mockPairQuerier{}, landing: &mockPairLandingCreator{}}
		t.Setenv("SMITHERS_PAIR_LANDING_ACTOR_ID", "not-a-number")
		result, err = withLanding.CreateLandingRequest(context.Background(), "room")
		require.NoError(t, err)
		assert.Contains(t, result.Message, "positive user id")

		t.Setenv("SMITHERS_PAIR_LANDING_ACTOR_ID", "42")
		result, err = withLanding.CreateLandingRequest(context.Background(), "room")
		require.NoError(t, err)
		assert.Contains(t, result.Message, "workspace-backed room")
	})

	t.Run("repo and url defaults and overrides", func(t *testing.T) {
		t.Setenv("SMITHERS_PAIR_LANDING_REPO", "")
		owner, repo := pairLandingRepo()
		assert.Equal(t, "jjhub", owner)
		assert.Equal(t, "plue", repo)

		t.Setenv("SMITHERS_PAIR_LANDING_REPO", "bad")
		owner, repo = pairLandingRepo()
		assert.Equal(t, "jjhub", owner)
		assert.Equal(t, "plue", repo)

		t.Setenv("SMITHERS_PAIR_LANDING_REPO", " acme/widgets ")
		owner, repo = pairLandingRepo()
		assert.Equal(t, "acme", owner)
		assert.Equal(t, "widgets", repo)

		t.Setenv("SMITHERS_PUBLIC_URL", "")
		assert.Equal(t, "https://jjhub.tech/acme/widgets/landings/12", pairLandingURL("acme", "widgets", 12))
		t.Setenv("SMITHERS_PUBLIC_URL", "https://smithers.test/")
		assert.Equal(t, "https://smithers.test/acme/widgets/landings/12", pairLandingURL("acme", "widgets", 12))
	})

	t.Run("landing text from env, snapshot, and fallback", func(t *testing.T) {
		svc := &PairService{q: mockPairQuerier{}}
		t.Setenv("SMITHERS_PAIR_LANDING_TITLE", "Env title")
		t.Setenv("SMITHERS_PAIR_LANDING_BODY", "Env body")
		title, body := svc.landingText(context.Background(), "room-a")
		assert.Equal(t, "Env title", title)
		assert.Equal(t, "Env body", body)

		t.Setenv("SMITHERS_PAIR_LANDING_TITLE", "")
		t.Setenv("SMITHERS_PAIR_LANDING_BODY", "")
		st := newPairRoomState()
		st.Doc.Content = "# Snapshot title\n\nSnapshot body."
		raw, err := json.Marshal(st)
		require.NoError(t, err)
		svc = &PairService{q: mockPairQuerier{stateJSON: raw}}
		title, body = svc.landingText(context.Background(), "room-b")
		assert.Equal(t, "Snapshot title", title)
		assert.Equal(t, "# Snapshot title\n\nSnapshot body.", body)

		svc = &PairService{q: mockPairQuerier{stateJSON: json.RawMessage(`{`)}}
		title, body = svc.landingText(context.Background(), "room-c")
		assert.Equal(t, "shared.md", title)
		assert.Contains(t, body, "This document is edited")
	})
}

func TestPair_Cov_StateMutationsWithPool(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n"), 0o644))

	svc := NewPairService(pool, nil, nil)
	svc.repoDir = root
	require.NoError(t, svc.EnsureSchema(ctx))
	room := "pair-cov-" + uuid.NewString()

	snapshot, err := svc.Snapshot(ctx, room)
	require.NoError(t, err)
	initial := snapshot["state"].(pairRoomState)
	assert.Equal(t, pairSeedDoc, initial.Doc.Content)

	require.NoError(t, svc.EditDoc(ctx, room, "# updated\n", "alice"))
	require.NoError(t, svc.EditFile(ctx, room, "main.go", "package main\n\nfunc main() {}\n", "alice"))
	cursor := 4
	require.NoError(t, svc.UpdatePresence(ctx, room, MakePresence("client-1", "Alice", "#123456", &cursor, "main.go", "draft", true)))
	require.NoError(t, svc.SetCollab(ctx, room, true))
	require.NoError(t, svc.EditDraft(ctx, room, "shared prompt", "alice"))

	snapshot, err = svc.Snapshot(ctx, room)
	require.NoError(t, err)
	state := snapshot["state"].(pairRoomState)
	assert.Equal(t, "# updated\n", state.Doc.Content)
	assert.Equal(t, "package main\n\nfunc main() {}\n", state.Files["main.go"].Content)
	assert.True(t, state.Prompt.Collab)
	assert.Equal(t, "shared prompt", state.Prompt.Content)
	require.Contains(t, state.Presence, "client-1")
	assert.True(t, state.Presence["client-1"].PromptFocus)

	require.NoError(t, svc.Leave(ctx, room, "client-1"))
	snapshot, err = svc.Snapshot(ctx, room)
	require.NoError(t, err)
	state = snapshot["state"].(pairRoomState)
	assert.NotContains(t, state.Presence, "client-1")

	err = svc.SubmitPrompt(ctx, room, "please edit", "alice", "#123456", false, "claude")
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrUnsupportedPairProvider))

	var localState pairRoomState
	localState.normalize()
	for i := 0; i < 205; i++ {
		svc.appendMessage(&localState, "alice", "#123456", "user", "message")
	}
	assert.Len(t, localState.Messages, 200)
	assert.Equal(t, int64(205), localState.MsgSeq)
}

func TestPair_Cov_RunModelAppliesSandboxResult(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	room := "pair-run-" + uuid.NewString()
	docB64 := base64.StdEncoding.EncodeToString([]byte("# model doc\n"))
	fileB64 := base64.StdEncoding.EncodeToString([]byte("package main\n"))
	status := int32(0)

	sandbox := pairSandboxFunc(func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		assert.Equal(t, "vm-1", vmID)
		assert.Contains(t, req.Command, "make the change")
		return sandbox.ExecResult{
			Stdout: strings.Join([]string{
				"===REPLY===",
				"Applied the requested change.",
				"===OUTPUT===",
				"tool output",
				"===FILES===",
				"src/model.go",
				"===FILE_CONTENTS===",
				"src/model.go\t" + fileB64,
				"===STATUS===",
				"0",
				"===DOC===",
				docB64,
			}, "\n"),
			StatusCode: &status,
		}, nil
	})

	svc := &PairService{
		pool:     pool,
		q:        db.New(pool),
		sandbox:  sandbox,
		vmID:     "vm-1",
		workdir:  root,
		repoDir:  root,
		provider: "codex",
	}
	require.NoError(t, svc.EnsureSchema(ctx))
	require.NoError(t, svc.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		st.Doc.Content = "# old doc\n"
		st.Agent = &pairAgentRun{ID: "run-1", Author: "alice", Color: "#123456", Prompt: "make the change", Status: "running", Phase: "starting"}
		return map[string]any{"kind": "agent", "agent": st.Agent}
	}))

	svc.runModel(room, "make the change", "run-1", "codex")
	snapshot, err := svc.Snapshot(ctx, room)
	require.NoError(t, err)
	state := snapshot["state"].(pairRoomState)
	assert.Nil(t, state.Agent)
	assert.Equal(t, "# model doc\n", state.Doc.Content)
	require.NotEmpty(t, state.Messages)
	assert.Equal(t, "assistant", state.Messages[len(state.Messages)-1].Role)
	assert.Equal(t, "Applied the requested change.", state.Messages[len(state.Messages)-1].Text)
	assert.Equal(t, "package main\n", state.Files["src/model.go"].Content)
}

func TestPair_Cov_ConstructorsDispatcherAndStateHelpers(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	sandbox := pairSandboxFunc(func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{}, nil
	})

	t.Setenv("SMITHERS_PAIR_CODEX_WORKDIR", "/vm/work")
	t.Setenv("SMITHERS_PAIR_REPO_DIR", root)
	t.Setenv("SMITHERS_PAIR_VM_ID", "vm-cov")
	t.Setenv("SMITHERS_PAIR_PROVIDER", " codex ")
	t.Setenv("SMITHERS_PAIR_LOCAL_AGENTS", "true")
	svc := NewPairService(nil, sandbox, &LandingService{})
	assert.Equal(t, "/vm/work", svc.workdir)
	assert.Equal(t, root, svc.repoDir)
	assert.Equal(t, "vm-cov", svc.vmID)
	assert.Equal(t, "codex", svc.provider)
	assert.True(t, svc.localAgents)
	assert.NotNil(t, svc.landing)

	dispatcher := svc.dispatcherFor("")
	assert.True(t, dispatcher.local)
	assert.Equal(t, root, dispatcher.workdir)
	assert.Equal(t, "codex", dispatcher.provider)

	st := pairRoomState{}
	st.normalize()
	assert.NotNil(t, st.Files)
	assert.NotNil(t, st.Presence)
	assert.NotNil(t, st.Messages)
	st.Files["a.txt"] = pairFile{Content: "a"}
	st.Doc.Content = "doc"
	snap := pairAgentSnapshotFromState(st)
	assert.Equal(t, "doc", snap.Doc)
	assert.Equal(t, "a", snap.Files["a.txt"])

	presence := MakePresence("id", "Name", "#abcdef", nil, "a.txt", "draft", true)
	assert.Equal(t, "id", presence.ID)
	assert.True(t, presence.PromptFocus)
}
