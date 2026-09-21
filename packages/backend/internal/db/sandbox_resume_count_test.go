package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCountOtherActiveSandboxesForWorkspaceResume_ProductOnly(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	owner := mustCreateUser(t, pool, uniqueTestUsername(t))
	repo := func() int64 { return mustCreateRepo(t, pool, owner, uniqueTestRepoName(t)) }
	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspaces (repository_id, user_id, vm_id, status) VALUES ($1, $2, 'vm-owned', 'running') RETURNING id::text`,
		repo(), owner).Scan(&workspaceID))
	_, err := pool.Exec(ctx,
		`INSERT INTO workspaces (repository_id, user_id, vm_id, status) VALUES ($1, $2, 'vm-other', 'running')`, repo(), owner)
	require.NoError(t, err)
	arg := CountOtherActiveSandboxesForWorkspaceResumeParams{UserID: owner, WorkspaceID: workspaceID, VmID: "vm-owned"}
	row, err := q.CountOtherActiveSandboxesForWorkspaceResume(ctx, arg)
	require.NoError(t, err)
	require.True(t, row.Matches)
	require.Equal(t, int32(1), row.Others)

	// A stale caller cannot exclude a row that no longer occupies a slot.
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status = 'suspended' WHERE id = $1`, workspaceID)
	require.NoError(t, err)
	row, err = q.CountOtherActiveSandboxesForWorkspaceResume(ctx, arg)
	require.NoError(t, err)
	require.True(t, row.Matches)
	require.Equal(t, int32(1), row.Others)

	arg.VmID = "vm-replaced"
	row, err = q.CountOtherActiveSandboxesForWorkspaceResume(ctx, arg)
	require.NoError(t, err)
	require.False(t, row.Matches)
}
