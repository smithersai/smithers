package services

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestPair_Z_FileDiffAndEditBranches(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	resolvedRoot, err := filepath.EvalSymlinks(root)
	require.NoError(t, err)
	root = resolvedRoot
	require.NoError(t, os.WriteFile(filepath.Join(root, "same.txt"), []byte("same\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "large.txt"), []byte(strings.Repeat("x", pairMaxFileBytes+1)), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "read.txt"), []byte("read\n"), 0o644))

	_, size, err := (&PairService{repoDir: root}).File(ctx, "large.txt")
	require.ErrorContains(t, err, "file too large")
	assert.Greater(t, size, int64(pairMaxFileBytes))

	oldRead := pairReadFile
	t.Cleanup(func() { pairReadFile = oldRead })
	pairReadFile = func(string) ([]byte, error) { return nil, errors.New("read failed") }
	_, _, err = (&PairService{repoDir: root}).File(ctx, "read.txt")
	require.ErrorContains(t, err, "read failed")
	pairReadFile = oldRead

	st := newPairRoomState()
	st.Files["same.txt"] = pairFile{Content: "same\n", Version: 1}
	st.Files["read.txt"] = pairFile{Content: "changed\n", Version: 1}
	raw, err := json.Marshal(st)
	require.NoError(t, err)
	diff, err := (&PairService{repoDir: root, q: pairHQuerier{state: raw}}).pairStateFilesDiff(ctx, "room")
	require.NoError(t, err)
	assert.Contains(t, diff, "read.txt")
	assert.NotContains(t, diff, "same.txt")

	pairReadFile = func(string) ([]byte, error) { return nil, errors.New("read failed") }
	diff, err = (&PairService{repoDir: root, q: pairHQuerier{state: raw}}).pairStateFilesDiff(ctx, "room")
	require.NoError(t, err)
	assert.Empty(t, diff)
	pairReadFile = oldRead

	svc := &PairService{repoDir: root}
	err = svc.EditFile(ctx, "room", "missing.txt", "x", "alice")
	require.ErrorIs(t, err, fs.ErrNotExist)
	require.NoError(t, os.Mkdir(filepath.Join(root, "dir"), 0o755))
	err = svc.EditFile(ctx, "room", "dir", "x", "alice")
	require.ErrorIs(t, err, fs.ErrInvalid)
	err = svc.EditFile(ctx, "room", "read.txt", strings.Repeat("x", pairMaxFileBytes+1), "alice")
	require.ErrorContains(t, err, "file too large")
}

func TestPair_Z_MutateGetStateErrorBranch(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	svc := &PairService{pool: pool, q: db.New(pool)}
	require.NoError(t, svc.EnsureSchema(ctx))

	room := "pair-z-" + uuid.NewString()
	raw, err := json.Marshal(newPairRoomState())
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO pair_state (room_id, state, version) VALUES ($1, $2, 1)`, room, raw)
	require.NoError(t, err)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `SELECT 1 FROM pair_state WHERE room_id = $1 FOR UPDATE`, room)
	require.NoError(t, err)

	blockedCtx, cancel := context.WithTimeout(ctx, 25*time.Millisecond)
	defer cancel()
	err = svc.mutate(blockedCtx, room, func(*pairRoomState) map[string]any { return nil })
	require.Error(t, err)
}
