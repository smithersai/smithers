package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type pairHQuerier struct {
	user     db.User
	userErr  error
	state    json.RawMessage
	stateErr error
}

func (q pairHQuerier) GetPairState(context.Context, string) (db.GetPairStateRow, error) {
	if q.stateErr != nil {
		return db.GetPairStateRow{}, q.stateErr
	}
	if len(q.state) == 0 {
		return db.GetPairStateRow{}, pgx.ErrNoRows
	}
	return db.GetPairStateRow{State: q.state, Version: 1}, nil
}

func (q pairHQuerier) GetUserByID(context.Context, int64) (db.User, error) {
	if q.userErr != nil {
		return db.User{}, q.userErr
	}
	if q.user.ID != 0 {
		return q.user, nil
	}
	return db.User{ID: 42, Username: "pair-h", LowerUsername: "pair-h"}, nil
}

type pairHLandingCreator struct {
	err error
	req CreateLandingRequestInput
}

func (l *pairHLandingCreator) CreateLandingRequest(_ context.Context, _ *db.User, _, _ string, req CreateLandingRequestInput) (LandingRequestResponse, error) {
	l.req = req
	if l.err != nil {
		return LandingRequestResponse{}, l.err
	}
	return LandingRequestResponse{Number: 88}, nil
}

func pairHPrependFakeBin(t *testing.T, name, script string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(path, []byte(script), 0o755))
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return path
}

func TestPair_H_RepoTreeFileAndDiffBranches(t *testing.T) {
	ctx := context.Background()
	oldAbs := pairFilepathAbs
	oldRel := pairFilepathRel
	oldReadFile := pairReadFile
	t.Cleanup(func() {
		pairFilepathAbs = oldAbs
		pairFilepathRel = oldRel
		pairReadFile = oldReadFile
	})

	t.Run("abs error from deleted cwd", func(t *testing.T) {
		dir := t.TempDir()
		t.Chdir(dir)
		require.NoError(t, os.RemoveAll(dir))
		_, err := (&PairService{repoDir: "relative"}).repoRoot()
		require.Error(t, err)
	})

	pairFilepathAbs = func(string) (string, error) { return "", errors.New("abs failed") }
	_, err := (&PairService{repoDir: "relative"}).repoRoot()
	require.Error(t, err)
	pairFilepathAbs = oldAbs

	_, err = (&PairService{repoDir: filepath.Join(t.TempDir(), "missing")}).repoRoot()
	require.Error(t, err)
	_, err = (&PairService{repoDir: ""}).Tree(ctx)
	require.Error(t, err)

	root := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, ".git"), 0o755))
	pairHPrependFakeBin(t, "git", "#!/bin/sh\ncase \"$*\" in *'ls-files -co'*) printf 'z.go\\ndir/a.go\\nnode_modules/skip.js\\n'; exit 0;; esac\nexit 1\n")
	entries, err := (&PairService{repoDir: root}).Tree(ctx)
	require.NoError(t, err)
	assert.Contains(t, entries, PairTreeEntry{Path: "dir", Type: "directory"})
	assert.Contains(t, entries, PairTreeEntry{Path: "dir/a.go", Type: "file"})
	assert.NotContains(t, entries, PairTreeEntry{Path: "node_modules/skip.js", Type: "file"})

	root = t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, ".git"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "fallback.txt"), []byte("fallback"), 0o644))
	pairHPrependFakeBin(t, "git", "#!/bin/sh\nexit 1\n")
	entries, err = (&PairService{repoDir: root}).Tree(ctx)
	require.NoError(t, err)
	assert.Contains(t, entries, PairTreeEntry{Path: "fallback.txt", Type: "file"})

	entries = []PairTreeEntry{{Path: "same", Type: "file"}, {Path: "same", Type: "directory"}}
	sortPairTree(entries)
	assert.Equal(t, "directory", entries[0].Type)
	_, err = walkPairTree(filepath.Join(t.TempDir(), "missing"))
	require.Error(t, err)

	pairFilepathRel = func(string, string) (string, error) { return "", errors.New("rel failed") }
	_, err = walkPairTree(root)
	require.Error(t, err)
	pairFilepathRel = oldRel

	root = t.TempDir()
	secret := filepath.Join(t.TempDir(), "secret.txt")
	require.NoError(t, os.WriteFile(secret, []byte("secret"), 0o644))
	require.NoError(t, os.Symlink(secret, filepath.Join(root, "secret-link")))
	_, err = (&PairService{repoDir: root}).resolveRepoFile("secret-link")
	require.ErrorIs(t, err, fs.ErrInvalid)
	_, err = (&PairService{repoDir: root}).resolveRepoFile("/abs")
	require.ErrorIs(t, err, fs.ErrInvalid)

	if runtime.GOOS != "windows" {
		noRead := filepath.Join(root, "no-read.txt")
		require.NoError(t, os.WriteFile(noRead, []byte("x"), 0o000))
		t.Cleanup(func() { _ = os.Chmod(noRead, 0o600) })
		_, _, err = (&PairService{repoDir: root}).File(ctx, "no-read.txt")
		if err == nil {
			t.Log("filesystem permits reading chmod 000 files")
		}
	}
	readErrFile := filepath.Join(root, "read-error.txt")
	require.NoError(t, os.WriteFile(readErrFile, []byte("x"), 0o644))
	pairReadFile = func(string) ([]byte, error) { return nil, errors.New("read failed") }
	_, _, err = (&PairService{repoDir: root}).File(ctx, "read-error.txt")
	require.Error(t, err)
	pairReadFile = oldReadFile

	skipFileRoot := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(skipFileRoot, "coverage"), []byte("skip"), 0o644))
	entries, err = walkPairTree(skipFileRoot)
	require.NoError(t, err)
	assert.Empty(t, entries)

	_, _, err = (&PairService{repoDir: ""}).Diff(ctx, "room")
	require.Error(t, err)
	_, _, err = (&PairService{repoDir: root, q: pairHQuerier{stateErr: errors.New("state failed")}}).Diff(ctx, "room")
	require.Error(t, err)

	root = t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, ".git"), 0o755))
	pairHPrependFakeBin(t, "git", "#!/bin/sh\nexit 1\n")
	diff, note := (&PairService{repoDir: root}).workspaceGitDiff(ctx, root)
	assert.Empty(t, diff)
	assert.Contains(t, note, "git diff could not run")

	root = t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, ".git"), 0o755))
	pairHPrependFakeBin(t, "git", `#!/bin/sh
case "$*" in
*'diff --no-ext-diff main'*) printf 'tracked-diff'; exit 0;;
*'ls-files --others'*) exit 1;;
esac
exit 0
`)
	diff, note = (&PairService{repoDir: root}).workspaceGitDiff(ctx, root)
	assert.Equal(t, "tracked-diff", diff)
	assert.Contains(t, note, "untracked")

	root = t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, ".git"), 0o755))
	pairHPrependFakeBin(t, "git", `#!/bin/sh
case "$*" in
*'diff --no-ext-diff main'*) exit 0;;
*'ls-files --others'*) printf 'empty.txt\n'; exit 0;;
*'diff --no-ext-diff --no-index'*) exit 0;;
esac
exit 0
`)
	diff, note = (&PairService{repoDir: root}).workspaceGitDiff(ctx, root)
	assert.Empty(t, diff)
	assert.Empty(t, note)

	root = t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, ".git"), 0o755))
	pairHPrependFakeBin(t, "git", `#!/bin/sh
case "$*" in
*'diff --no-ext-diff main'*) exit 0;;
*'ls-files --others'*) printf 'new.txt\n'; exit 0;;
*'diff --no-ext-diff --no-index'*) printf 'new-file-diff'; exit 1;;
esac
exit 0
`)
	diff, note = (&PairService{repoDir: root}).workspaceGitDiff(ctx, root)
	assert.Empty(t, note)
	assert.Equal(t, "new-file-diff\n", diff)

	_, err = (&PairService{}).resolveRepoFile("x.txt")
	require.Error(t, err)
}

func TestPair_H_StateDiffLandingAndChangeIDBranches(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(root, "same.txt"), []byte("same\n"), 0o644))
	st := newPairRoomState()
	st.Files["same.txt"] = pairFile{Content: "same\n", Version: 1}
	raw, err := json.Marshal(st)
	require.NoError(t, err)
	diff, err := (&PairService{repoDir: root, q: pairHQuerier{state: raw}}).pairStateFilesDiff(ctx, "room")
	require.NoError(t, err)
	assert.Empty(t, diff)

	st.Files["missing.txt"] = pairFile{Content: "new\n", Version: 1}
	raw, err = json.Marshal(st)
	require.NoError(t, err)
	diff, err = (&PairService{repoDir: root, q: pairHQuerier{state: raw}}).pairStateFilesDiff(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, diff, "new file mode")

	pairReadFile = func(string) ([]byte, error) { return nil, errors.New("read failed") }
	diff, err = (&PairService{repoDir: root, q: pairHQuerier{state: raw}}).pairStateFilesDiff(ctx, "room")
	require.NoError(t, err)
	assert.NotContains(t, diff, "same.txt")
	pairReadFile = os.ReadFile

	pairHPrependFakeBin(t, "jj", "#!/bin/sh\nprintf 'change-h\\n'\n")
	changeID, err := currentPairChangeID(ctx, root)
	require.NoError(t, err)
	assert.Equal(t, "change-h", changeID)

	pairHPrependFakeBin(t, "jj", "#!/bin/sh\nexit 1\n")
	_, err = currentPairChangeID(ctx, root)
	require.Error(t, err)

	pairHPrependFakeBin(t, "jj", "#!/bin/sh\nexit 0\n")
	_, err = currentPairChangeID(ctx, root)
	require.Error(t, err)

	landing := &pairHLandingCreator{}
	t.Setenv("SMITHERS_PAIR_LANDING_ACTOR_ID", "")
	res, err := (&PairService{repoDir: root, q: pairHQuerier{}, landing: landing}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, res.Message, "workspace-backed")

	t.Setenv("SMITHERS_PAIR_LANDING_ACTOR_ID", "42")
	res, err = (&PairService{repoDir: root, q: pairHQuerier{userErr: pgx.ErrNoRows}, landing: landing}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, res.Message, "actor was not found")

	res, err = (&PairService{repoDir: filepath.Join(root, "missing"), q: pairHQuerier{}, landing: landing}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, res.Message, "workspace-backed")

	plainDir := t.TempDir()
	res, err = (&PairService{repoDir: plainDir, q: pairHQuerier{}, landing: landing}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, res.Message, "workspace-backed")

	requireGitRepo(t, root)
	require.NoError(t, os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("old\n"), 0o644))
	runGit(t, root, "add", "tracked.txt")
	runGit(t, root, "-c", "user.email=pair-h@example.com", "-c", "user.name=Pair H", "commit", "-m", "initial")
	require.NoError(t, os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("new\n"), 0o644))
	pairHPrependFakeBin(t, "jj", "#!/bin/sh\nprintf 'change-success\\n'\n")
	t.Setenv("SMITHERS_PAIR_LANDING_TARGET", "")
	landing = &pairHLandingCreator{}
	res, err = (&PairService{repoDir: root, q: pairHQuerier{user: db.User{ID: 42, Username: "pair"}}, landing: landing}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.True(t, res.Available)
	assert.Equal(t, int64(88), res.Number)
	assert.Equal(t, []string{"change-success"}, landing.req.ChangeIDs)
	assert.Equal(t, "main", landing.req.TargetBookmark)

	pairHPrependFakeBin(t, "jj", "#!/bin/sh\nexit 1\n")
	res, err = (&PairService{repoDir: root, q: pairHQuerier{user: db.User{ID: 42, Username: "pair"}}, landing: landing}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, res.Message, "workspace-backed")

	landing = &pairHLandingCreator{err: errors.New("backend failed")}
	pairHPrependFakeBin(t, "jj", "#!/bin/sh\nprintf 'change-success\\n'\n")
	res, err = (&PairService{repoDir: root, q: pairHQuerier{user: db.User{ID: 42, Username: "pair"}}, landing: landing}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, res.Message, "backend rejected")

	badState := newPairRoomState()
	badState.Files["room.txt"] = pairFile{Content: "room edit"}
	badRaw, err := json.Marshal(badState)
	require.NoError(t, err)
	res, err = (&PairService{repoDir: root, q: pairHQuerier{user: db.User{ID: 42, Username: "pair"}, state: badRaw}, landing: &pairHLandingCreator{}}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.Equal(t, pairRoomEditsNotAppliedMessage, res.Message)

	res, err = (&PairService{repoDir: root, q: pairHQuerier{user: db.User{ID: 42, Username: "pair"}, stateErr: errors.New("state failed")}, landing: &pairHLandingCreator{}}).CreateLandingRequest(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, res.Message, "workspace-backed")

	t.Setenv("SMITHERS_PAIR_LANDING_TITLE", "")
	t.Setenv("SMITHERS_PAIR_LANDING_BODY", "")
	title, body := (&PairService{q: pairHQuerier{stateErr: errors.New("state failed")}}).landingText(ctx, "room-x")
	assert.Equal(t, "Pair landing request", title)
	assert.Equal(t, "Created from Smithers Pair room room-x.", body)
}

func TestPair_H_MutateSnapshotEditSubmitAndRunModelBranches(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	root := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(root, "readme.md"), []byte("from disk\n"), 0o644))

	svc := &PairService{pool: pool, q: db.New(pool), repoDir: root, workdir: root, provider: "codex"}
	require.NoError(t, svc.EnsureSchema(ctx))
	room := "pair-h-" + uuid.NewString()

	ctxCanceled, cancel := context.WithCancel(ctx)
	cancel()
	require.Error(t, svc.mutate(ctxCanceled, room, func(*pairRoomState) map[string]any { return nil }))

	badJSONRoom := "pair-h-bad-json-" + uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO pair_state (room_id, state, version) VALUES ($1, $2, 1)`, badJSONRoom, []byte(`[]`))
	require.NoError(t, err)
	require.NoError(t, svc.mutate(ctx, badJSONRoom, func(st *pairRoomState) map[string]any {
		assert.Equal(t, pairSeedDoc, st.Doc.Content)
		return nil
	}))

	cancelDuringRoom := "pair-h-cancel-during-" + uuid.NewString()
	ctxDuring, cancelDuring := context.WithCancel(ctx)
	err = svc.mutate(ctxDuring, cancelDuringRoom, func(*pairRoomState) map[string]any {
		cancelDuring()
		return nil
	})
	require.Error(t, err)

	err = svc.mutate(ctx, "pair-h-bad-event-"+uuid.NewString(), func(*pairRoomState) map[string]any {
		return map[string]any{"bad": make(chan int)}
	})
	require.Error(t, err)

	err = svc.mutate(ctx, "pair-h-large-event-"+uuid.NewString(), func(*pairRoomState) map[string]any {
		return map[string]any{"big": strings.Repeat("x", 9000)}
	})
	require.Error(t, err)

	require.NoError(t, svc.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		st.Presence["old"] = pairPresence{ID: "old", LastSeen: nowMS() - presenceTTLms - 1000}
		return nil
	}))
	snap, err := svc.Snapshot(ctx, room)
	require.NoError(t, err)
	state := snap["state"].(pairRoomState)
	assert.NotContains(t, state.Presence, "old")

	require.NoError(t, pool.QueryRow(ctx, `SELECT 1`).Scan(new(int)))
	_, err = (&PairService{q: pairHQuerier{stateErr: errors.New("snapshot failed")}}).Snapshot(ctx, "room")
	require.Error(t, err)

	require.Error(t, svc.EditFile(ctx, room, "missing.txt", "x", "alice"))
	require.ErrorIs(t, svc.EditFile(ctx, room, "../escape", "x", "alice"), fs.ErrInvalid)
	require.NoError(t, os.Mkdir(filepath.Join(root, "dir"), 0o755))
	err = svc.EditFile(ctx, room, "dir", "x", "alice")
	require.ErrorIs(t, err, fs.ErrInvalid)
	err = svc.EditFile(ctx, room, "readme.md", strings.Repeat("x", pairMaxFileBytes+1), "alice")
	require.Error(t, err)

	status := int32(0)
	docB64 := base64.StdEncoding.EncodeToString([]byte(pairSeedDoc))
	svc.sandbox = pairSandboxFunc(func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{
			Stdout: strings.Join([]string{
				"===REPLY===",
				"Done.",
				"===OUTPUT===",
				"output",
				"===FILES===",
				"readme.md",
				"missing.txt",
				"===FILE_CONTENTS===",
				"===STATUS===",
				"0",
				"===DOC===",
				docB64,
			}, "\n"),
			StatusCode: &status,
		}, nil
	})
	svc.vmID = "vm-h"
	require.NoError(t, svc.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		st.Agent = &pairAgentRun{ID: "run-h", Status: "running"}
		return nil
	}))
	svc.runModel(room, "prompt", "run-h", "codex")
	snap, err = svc.Snapshot(ctx, room)
	require.NoError(t, err)
	state = snap["state"].(pairRoomState)
	assert.NotContains(t, state.Files, "missing.txt")

	svc.sandbox = pairSandboxFunc(func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{}, errors.New("agent failed")
	})
	require.NoError(t, svc.mutate(ctx, room, func(st *pairRoomState) map[string]any {
		st.Agent = &pairAgentRun{ID: "run-error", Status: "running"}
		return nil
	}))
	svc.runModel(room, "prompt", "run-error", "codex")
	snap, err = svc.Snapshot(ctx, room)
	require.NoError(t, err)
	state = snap["state"].(pairRoomState)
	require.NotEmpty(t, state.Messages)
	assert.Contains(t, state.Messages[len(state.Messages)-1].Text, "agent failed")

	svc.sandbox = pairSandboxFunc(func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{Stdout: strings.Join([]string{
			"===REPLY===",
			"Submitted.",
			"===OUTPUT===",
			"output",
			"===FILES===",
			"===FILE_CONTENTS===",
			"===STATUS===",
			"0",
			"===DOC===",
			docB64,
		}, "\n"), StatusCode: &status}, nil
	})
	require.NoError(t, svc.EditDraft(ctx, room, "draft prompt", "alice"))
	require.NoError(t, svc.SubmitPrompt(ctx, room, "draft prompt", "alice", "#123", true, "codex"))
	require.Eventually(t, func() bool {
		snap, err := svc.Snapshot(ctx, room)
		if err != nil {
			return false
		}
		state := snap["state"].(pairRoomState)
		return state.Agent == nil && state.Prompt.Content == ""
	}, time.Second, 10*time.Millisecond)

	ctxSubmit, cancelSubmit := context.WithCancel(ctx)
	cancelSubmit()
	require.Error(t, svc.SubmitPrompt(ctxSubmit, "pair-h-submit-canceled", "prompt", "alice", "#123", false, "codex"))
}

func TestPair_H_UpdateAgentNoopBranch(t *testing.T) {
	pool := getAgentTestPool(t)
	svc := &PairService{pool: pool, q: db.New(pool)}
	require.NoError(t, svc.EnsureSchema(context.Background()))
	require.NoError(t, svc.updateAgent(context.Background(), "pair-h-"+uuid.NewString(), "missing-run", "phase", "output"))
}

func TestPair_H_RemainingFileDiffAndMutateBranches(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(root, "same.txt"), []byte("same\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "read.txt"), []byte("read\n"), 0o644))
	require.NoError(t, os.Mkdir(filepath.Join(root, "dir"), 0o755))

	oldRead := pairReadFile
	pairReadFile = func(string) ([]byte, error) { return nil, errors.New("forced read") }
	_, _, err := (&PairService{repoDir: root}).File(ctx, "read.txt")
	require.Error(t, err)
	pairReadFile = oldRead

	st := newPairRoomState()
	st.Files["same.txt"] = pairFile{Content: "same\n", Version: 1}
	raw, err := json.Marshal(st)
	require.NoError(t, err)
	diff, err := (&PairService{repoDir: root, q: pairHQuerier{state: raw}}).pairStateFilesDiff(ctx, "room")
	require.NoError(t, err)
	assert.Empty(t, diff)

	oldRead = pairReadFile
	pairReadFile = func(string) ([]byte, error) { return nil, errors.New("forced read") }
	diff, err = (&PairService{repoDir: root, q: pairHQuerier{state: raw}}).pairStateFilesDiff(ctx, "room")
	require.NoError(t, err)
	assert.Empty(t, diff)
	pairReadFile = oldRead

	pool := getAgentTestPool(t)
	svc := &PairService{pool: pool, q: db.New(pool), repoDir: root}
	require.NoError(t, svc.EnsureSchema(ctx))

	err = svc.EditFile(ctx, "pair-h-edit-"+uuid.NewString(), "dir", "x", "alice")
	require.ErrorIs(t, err, fs.ErrInvalid)
	err = svc.EditFile(ctx, "pair-h-edit-"+uuid.NewString(), "read.txt", strings.Repeat("x", pairMaxFileBytes+1), "alice")
	require.Error(t, err)

	oldMarshal := pairJSONMarshal
	pairJSONMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal failed") }
	err = svc.mutate(ctx, "pair-h-marshal-"+uuid.NewString(), func(*pairRoomState) map[string]any { return nil })
	require.Error(t, err)
	pairJSONMarshal = oldMarshal
}
