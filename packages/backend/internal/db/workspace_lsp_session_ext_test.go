package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The hand-written CAS transitions answer the synchronous create response, so
// they must carry kind and language exactly like the generated RETURNING *
// queries do (plue #505: the create response said kind=terminal for an lsp
// session while the row was right).
func TestWorkspaceLSPSession_CASTransitionsCarryKindAndLanguage(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	ownerID, repoID := mustCreateUserAndRepo(t, sharedPool, uniqueTestUsername(t), uniqueTestRepoName(t))
	workspace := workspaceSQLHCreateWorkspace(t, q, repoID, ownerID, "lsp-sessions", "running", false)
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, workspace.ID)
	})

	created, err := q.CreateWorkspaceLSPSession(ctx, CreateWorkspaceLSPSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
		Language: "typescript", IdleTimeoutSecs: 600,
	})
	require.NoError(t, err)
	assert.Equal(t, "lsp", created.Kind)
	assert.Equal(t, "typescript", created.Language)
	assert.Equal(t, int32(600), created.IdleTimeoutSecs)

	running, err := q.MarkWorkspaceSessionRunning(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, "running", running.Status)
	assert.Equal(t, "lsp", running.Kind, "MarkWorkspaceSessionRunning must return kind")
	assert.Equal(t, "typescript", running.Language, "MarkWorkspaceSessionRunning must return language")

	// One live server per workspace and language: the partial unique index
	// refuses a sibling while the first is active, and the lookup finds it.
	_, err = q.CreateWorkspaceLSPSession(ctx, CreateWorkspaceLSPSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
		Language: "typescript", IdleTimeoutSecs: 600,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "idx_workspace_sessions_active_lsp")
	active, err := q.GetActiveWorkspaceLSPSession(ctx, GetActiveWorkspaceLSPSessionParams{WorkspaceID: workspace.ID, Language: "typescript"})
	require.NoError(t, err)
	assert.Equal(t, created.ID, active.ID)

	failed, err := q.FailActiveWorkspaceSession(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, "failed", failed.Status)
	assert.Equal(t, "lsp", failed.Kind)
	assert.Equal(t, "typescript", failed.Language)

	// A stopped or failed row no longer occupies the slot.
	_, err = q.GetActiveWorkspaceLSPSession(ctx, GetActiveWorkspaceLSPSessionParams{WorkspaceID: workspace.ID, Language: "typescript"})
	assert.True(t, errors.Is(err, pgx.ErrNoRows))
	second, err := q.CreateWorkspaceLSPSession(ctx, CreateWorkspaceLSPSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
		Language: "typescript", IdleTimeoutSecs: 600,
	})
	require.NoError(t, err)
	assert.NotEqual(t, created.ID, second.ID)

	// Terminal rows are untouched: kind defaults to terminal, no language.
	terminal, err := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID: workspace.ID, RepositoryID: repoID, UserID: ownerID, Cols: 80, Rows: 24,
	})
	require.NoError(t, err)
	assert.Equal(t, "terminal", terminal.Kind)
	assert.Empty(t, terminal.Language)
	terminalRunning, err := q.MarkWorkspaceSessionRunning(ctx, terminal.ID)
	require.NoError(t, err)
	assert.Equal(t, "terminal", terminalRunning.Kind)
}
