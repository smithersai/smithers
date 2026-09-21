package deploymentdb

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestCountOtherActiveSandboxesForWorkspaceResume_ExactOwnedVM(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	owner := mustCreateUser(t, pool, uniqueTestUsername(t))
	repo := func() int64 { return mustCreateRepo(t, pool, owner, uniqueTestRepoName(t)) }
	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspaces (repository_id, user_id, vm_id, status) VALUES ($1, $2, 'vm-owned', 'running') RETURNING id::text`,
		repo(), owner).Scan(&workspaceID))
	for range 2 {
		_, err := pool.Exec(ctx,
			`INSERT INTO repo_gateways (repository_id, user_id, vm_id, status) VALUES ($1, $2, 'vm-gateway', 'running')`, repo(), owner)
		require.NoError(t, err)
	}
	row, err := q.CountOtherActiveSandboxesForWorkspaceResume(ctx, db.CountOtherActiveSandboxesForWorkspaceResumeParams{UserID: owner, WorkspaceID: workspaceID, VmID: "vm-owned"})
	require.NoError(t, err)
	require.True(t, row.Matches)
	require.Equal(t, int32(2), row.Others, "the already counted VM needs no new slot")

	// The caller still holds its old running DTO. The authoritative row has
	// meanwhile suspended: it no longer contributes a slot, so the unrelated
	// new gateway fills the last one and this resume must be denied at 3/3.
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status = 'suspended' WHERE id = $1`, workspaceID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO repo_gateways (repository_id, user_id, vm_id, status) VALUES ($1, $2, 'vm-new', 'running')`, repo(), owner)
	require.NoError(t, err)
	row, err = q.CountOtherActiveSandboxesForWorkspaceResume(ctx, db.CountOtherActiveSandboxesForWorkspaceResumeParams{UserID: owner, WorkspaceID: workspaceID, VmID: "vm-owned"})
	require.NoError(t, err)
	require.True(t, row.Matches)
	require.Equal(t, int32(3), row.Others)

	row, err = q.CountOtherActiveSandboxesForWorkspaceResume(ctx, db.CountOtherActiveSandboxesForWorkspaceResumeParams{UserID: owner, WorkspaceID: workspaceID, VmID: "vm-replaced"})
	require.NoError(t, err)
	require.False(t, row.Matches)
	otherOwner := mustCreateUser(t, pool, uniqueTestUsername(t))
	row, err = q.CountOtherActiveSandboxesForWorkspaceResume(ctx, db.CountOtherActiveSandboxesForWorkspaceResumeParams{UserID: otherOwner, WorkspaceID: workspaceID, VmID: "vm-owned"})
	require.NoError(t, err)
	require.False(t, row.Matches)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET deleted_at = NOW() WHERE id = $1`, workspaceID)
	require.NoError(t, err)
	row, err = q.CountOtherActiveSandboxesForWorkspaceResume(ctx, db.CountOtherActiveSandboxesForWorkspaceResumeParams{UserID: owner, WorkspaceID: workspaceID, VmID: "vm-owned"})
	require.NoError(t, err)
	require.False(t, row.Matches)
}
