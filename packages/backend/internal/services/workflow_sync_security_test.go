package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// TestWorkflowSyncService_Security_RejectsInvalidTSXExport ensures that a
// workflow file that does not export a valid (ctx) => <Workflow> factory is
// rejected by the renderer with a descriptive error rather than silently
// succeeding.
//
// With the TSX migration (JJH-125), workflows are imported and rendered by
// Bun's native JSX runtime. The security boundary for untrusted code execution
// is the sandbox VM sandbox — the renderer itself runs inside a sandboxed
// runner pod, not on the API server. The API server only persists the JSON
// output from the renderer.
func TestWorkflowSyncService_Security_RejectsInvalidTSXExport(t *testing.T) {
	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     42,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 7, Username: "alice"}, nil
		},
	}

	repoHost := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
			return []repohost.ChangeFile{
				{Path: ".smithers/workflows/bad.tsx"},
			}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
			// Not a valid TSX workflow — plain object export
			return repohost.FileContent{
				Path:    path,
				Content: `export default { on: { push: {} }, jobs: {} };`,
			}, nil
		},
	}

	// Use a mock runner that returns an error (simulating renderer rejection)
	mockRunner := &mockWorkflowParserRunner{
		runFn: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return nil, assert.AnError
		},
	}

	svc := NewWorkflowSyncService(
		queries,
		repoHost,
		NewWorkflowParser(WithWorkflowParserRunner(mockRunner)),
	)

	result, err := svc.LoadDefinitionsFromCommit(context.Background(), 42, "abc123")
	require.NoError(t, err)

	// The bad file should appear in file errors, not in valid definitions
	assert.Empty(t, result.Definitions)
	assert.Len(t, result.FileErrors, 1)
	assert.Equal(t, ".smithers/workflows/bad.tsx", result.FileErrors[0].Path)
}
