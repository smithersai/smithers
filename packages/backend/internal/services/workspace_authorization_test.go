package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ownerUserID is Alice, the workspace owner.
const ownerUserID int64 = 10

// otherUserID is Bob, a collaborator on the repo but not the workspace owner.
const otherUserID int64 = 99

// makeWorkspaceOwnedBy returns a db.Workspace owned by the specified user.
func makeWorkspaceOwnedBy(id string, userID int64) db.Workspace {
	ws := sampleDBWorkspace(id)
	ws.UserID = userID
	return ws
}

// makeSessionOwnedBy returns a db.WorkspaceSession owned by the specified user.
func makeSessionOwnedBy(id, workspaceID string, userID int64) db.WorkspaceSession {
	return db.WorkspaceSession{
		ID:           id,
		WorkspaceID:  workspaceID,
		RepositoryID: 101,
		UserID:       userID,
		Status:       "running",
	}
}

// makeSnapshotOwnedBy returns a db.WorkspaceSnapshot owned by the specified user.
func makeSnapshotOwnedBy(id, workspaceID string, userID int64) db.WorkspaceSnapshot {
	snap := sampleDBWorkspaceSnapshot(id, workspaceID, "test-snap", "fs-1")
	snap.UserID = userID
	return snap
}

// requireAPIStatus asserts that err is an *pkgerrors.APIError with the given HTTP status.
func requireAPIStatus(t *testing.T, err error, wantStatus int) {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *pkgerrors.APIError, got %T: %v", err, err)
	assert.Equal(t, wantStatus, apiErr.Status,
		"expected HTTP %d, got %d: %s", wantStatus, apiErr.Status, apiErr.Message)
}

// --- GetWorkspace cross-user tests ---

func TestWorkspaceService_GetWorkspace_Owner_Allowed(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			assert.Equal(t, "ws-1", arg.ID)
			return makeWorkspaceOwnedBy("ws-1", ownerUserID), nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	ws, err := svc.GetWorkspace(context.Background(), "ws-1", 101, ownerUserID)
	require.NoError(t, err)
	assert.Equal(t, "ws-1", ws.ID)
}

func TestWorkspaceService_GetWorkspace_NonOwner_NoShare_Returns403(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy("ws-alice", ownerUserID), nil
		},
		// Default getWorkspaceShareFn returns pgx.ErrNoRows (no share).
	}
	svc := newWorkspaceServiceForTests(q)

	_, err := svc.GetWorkspace(context.Background(), "ws-alice", 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)
}

func TestWorkspaceService_GetWorkspace_NonOwner_WriteShare_Allowed(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy("ws-alice", ownerUserID), nil
		},
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			assert.Equal(t, "ws-alice", arg.WorkspaceID)
			assert.Equal(t, otherUserID, arg.GranteeUserID)
			return db.WorkspaceShare{WorkspaceID: "ws-alice", GranteeUserID: otherUserID, Level: "write"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	ws, err := svc.GetWorkspace(context.Background(), "ws-alice", 101, otherUserID)
	require.NoError(t, err)
	assert.Equal(t, "ws-alice", ws.ID)
}

func TestWorkspaceService_GetWorkspace_NonOwner_ReadShare_Allowed(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy("ws-alice", ownerUserID), nil
		},
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: "ws-alice", GranteeUserID: otherUserID, Level: "read"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	// Viewing workspace status is read-level: a read share (pair viewer) is
	// sufficient. Mutations still require a write share (tested above).
	ws, err := svc.GetWorkspace(context.Background(), "ws-alice", 101, otherUserID)
	require.NoError(t, err)
	assert.Equal(t, "ws-alice", ws.ID)
}

// --- SuspendWorkspace cross-user tests ---

func TestWorkspaceService_SuspendWorkspace_NonOwner_NoShare_Returns403(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy("ws-alice", ownerUserID), nil
		},
		// No share — default returns pgx.ErrNoRows.
	}
	svc := newWorkspaceServiceForTests(q)

	_, err := svc.SuspendWorkspace(context.Background(), "ws-alice", 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)
}

func TestWorkspaceService_SuspendWorkspace_NonOwner_WriteShare_Returns403_SandboxUnavailable(t *testing.T) {
	t.Parallel()
	// With a write share, SuspendWorkspace proceeds past the auth check but
	// fails when no sandbox client is wired in. We verify auth passes
	// (returns "microsandbox client unavailable", not 403).

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := makeWorkspaceOwnedBy("ws-alice", ownerUserID)
			ws.Status = "running"
			ws.VmID = "vm-1"
			return ws, nil
		},
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: "ws-alice", GranteeUserID: otherUserID, Level: "write"}, nil
		},
	}
	// No sandbox client — SuspendWorkspace will pass auth but proceed with the
	// suspension logic.  suspendWorkspace returns nil when sandbox is nil.
	svc := newWorkspaceServiceForTests(q)

	_, err := svc.SuspendWorkspace(context.Background(), "ws-alice", 101, otherUserID)
	// Auth passed — if error it must NOT be a 403.
	if err != nil {
		apiErr, ok := err.(*pkgerrors.APIError)
		if ok {
			assert.NotEqual(t, http.StatusForbidden, apiErr.Status, "shared write access should not produce a 403")
		}
	}
}

// --- DeleteWorkspace cross-user tests ---

func TestWorkspaceService_DeleteWorkspace_NonOwner_NoShare_Returns403(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy("ws-alice", ownerUserID), nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	err := svc.DeleteWorkspace(context.Background(), "ws-alice", 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)
}

// --- GetSession cross-user tests ---

func TestWorkspaceService_GetSession_NonOwner_NoShare_Returns403(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-alice"
	const workspaceID = "ws-alice"

	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			assert.Equal(t, sessionID, arg.ID)
			return makeSessionOwnedBy(sessionID, workspaceID, ownerUserID), nil
		},
		// Share lookup returns no rows — non-owner has no share.
		getWorkspaceShareFn: func(_ context.Context, _ db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{}, pgx.ErrNoRows
		},
	}
	svc := newWorkspaceServiceForTests(q)

	_, err := svc.GetSession(context.Background(), sessionID, 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)
}

func TestWorkspaceService_GetSession_Owner_Allowed(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-alice"
	const workspaceID = "ws-alice"

	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return makeSessionOwnedBy(sessionID, workspaceID, ownerUserID), nil
		},
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy(workspaceID, ownerUserID), nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	sess, err := svc.GetSession(context.Background(), sessionID, 101, ownerUserID)
	require.NoError(t, err)
	assert.Equal(t, sessionID, sess.ID)
}

// TestWorkspaceService_GetSession_WorkspaceOwner_CollaboratorSession_Allowed
// covers issue #52: authorization resolves against the workspace owner, so the
// owner is never locked out of a session a write-share collaborator created in
// the owner's workspace.
func TestWorkspaceService_GetSession_WorkspaceOwner_CollaboratorSession_Allowed(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-by-bob"
	const workspaceID = "ws-alice"

	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			// Session created by Bob (collaborator) in Alice's workspace.
			return makeSessionOwnedBy(sessionID, workspaceID, otherUserID), nil
		},
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy(workspaceID, ownerUserID), nil
		},
		// Alice holds no share row for her own workspace; ownership must be
		// enough (default getWorkspaceShareFn returns pgx.ErrNoRows).
	}
	svc := newWorkspaceServiceForTests(q)

	sess, err := svc.GetSession(context.Background(), sessionID, 101, ownerUserID)
	require.NoError(t, err)
	assert.Equal(t, sessionID, sess.ID)

	require.NoError(t, svc.DestroySession(context.Background(), sessionID, 101, ownerUserID))
}

// TestWorkspaceService_GetSession_RevokedCreator_Returns403 covers issue #51:
// a collaborator whose workspace share was revoked must not retain access to
// sessions they created — creator identity never short-circuits the share check.
func TestWorkspaceService_GetSession_RevokedCreator_Returns403(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-by-bob"
	const workspaceID = "ws-alice"

	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			// Session created by Bob while he still held a write share.
			return makeSessionOwnedBy(sessionID, workspaceID, otherUserID), nil
		},
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy(workspaceID, ownerUserID), nil
		},
		// Bob's share row was deleted (revocation): default returns pgx.ErrNoRows.
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	_, err := svc.GetSession(context.Background(), sessionID, 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)

	err = svc.DestroySession(context.Background(), sessionID, 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)

	_, err = svc.GetSSHConnectionInfo(context.Background(), sessionID, 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)
}

// Read shares view sessions but never mint SSH credentials (write-level).
func TestWorkspaceService_GetSession_ReadShare_ViewAllowed_SSHDenied(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-alice"
	const workspaceID = "ws-alice"

	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return makeSessionOwnedBy(sessionID, workspaceID, ownerUserID), nil
		},
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return makeWorkspaceOwnedBy(workspaceID, ownerUserID), nil
		},
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: workspaceID, GranteeUserID: otherUserID, Level: "read"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	sess, err := svc.GetSession(context.Background(), sessionID, 101, otherUserID)
	require.NoError(t, err)
	assert.Equal(t, sessionID, sess.ID)

	_, err = svc.GetSSHConnectionInfo(context.Background(), sessionID, 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)
}

// --- GetWorkspaceSnapshot cross-user tests ---

func TestWorkspaceService_GetWorkspaceSnapshot_NonOwner_NoShare_Returns403(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return makeSnapshotOwnedBy("snap-alice", "ws-alice", ownerUserID), nil
		},
		getWorkspaceShareFn: func(_ context.Context, _ db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{}, pgx.ErrNoRows
		},
	}
	svc := newWorkspaceServiceForTests(q)

	_, err := svc.GetWorkspaceSnapshot(context.Background(), "snap-alice", 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)
}

func TestWorkspaceService_GetWorkspaceSnapshot_Owner_Allowed(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return makeSnapshotOwnedBy("snap-alice", "ws-alice", ownerUserID), nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	snap, err := svc.GetWorkspaceSnapshot(context.Background(), "snap-alice", 101, ownerUserID)
	require.NoError(t, err)
	assert.Equal(t, "snap-alice", snap.ID)
}

// --- DestroySession cross-user tests ---

func TestWorkspaceService_DestroySession_NonOwner_NoShare_Returns403(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return makeSessionOwnedBy("sess-alice", "ws-alice", ownerUserID), nil
		},
		getWorkspaceShareFn: func(_ context.Context, _ db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{}, pgx.ErrNoRows
		},
	}
	svc := newWorkspaceServiceForTests(q)

	err := svc.DestroySession(context.Background(), "sess-alice", 101, otherUserID)
	requireAPIStatus(t, err, http.StatusForbidden)
}

// --- requireWorkspaceAccess unit tests ---

func TestRequireWorkspaceAccess_Owner_AlwaysAllowed(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{} // share fn not called
	svc := newWorkspaceServiceForTests(q)

	err := svc.requireWorkspaceAccess(context.Background(), "ws-1", ownerUserID, ownerUserID, WorkspaceAccessWrite)
	require.NoError(t, err)
}

func TestRequireWorkspaceAccess_NonOwner_NoShare_Returns403(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceShareFn: func(_ context.Context, _ db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{}, pgx.ErrNoRows
		},
	}
	svc := newWorkspaceServiceForTests(q)

	err := svc.requireWorkspaceAccess(context.Background(), "ws-1", ownerUserID, otherUserID, WorkspaceAccessRead)
	requireAPIStatus(t, err, http.StatusForbidden)
}

func TestRequireWorkspaceAccess_NonOwner_ReadShare_ReadLevel_Allowed(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: arg.WorkspaceID, GranteeUserID: arg.GranteeUserID, Level: "read"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	err := svc.requireWorkspaceAccess(context.Background(), "ws-1", ownerUserID, otherUserID, WorkspaceAccessRead)
	require.NoError(t, err)
}

func TestRequireWorkspaceAccess_NonOwner_ReadShare_WriteLevel_Returns403(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: arg.WorkspaceID, GranteeUserID: arg.GranteeUserID, Level: "read"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	err := svc.requireWorkspaceAccess(context.Background(), "ws-1", ownerUserID, otherUserID, WorkspaceAccessWrite)
	requireAPIStatus(t, err, http.StatusForbidden)
}

func TestRequireWorkspaceAccess_NonOwner_WriteShare_WriteLevel_Allowed(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: arg.WorkspaceID, GranteeUserID: arg.GranteeUserID, Level: "write"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	err := svc.requireWorkspaceAccess(context.Background(), "ws-1", ownerUserID, otherUserID, WorkspaceAccessWrite)
	require.NoError(t, err)
}

func TestRequireWorkspaceAccess_NonOwner_WriteShare_ReadLevel_Allowed(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: arg.WorkspaceID, GranteeUserID: arg.GranteeUserID, Level: "write"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q)

	// write share satisfies read-level too.
	err := svc.requireWorkspaceAccess(context.Background(), "ws-1", ownerUserID, otherUserID, WorkspaceAccessRead)
	require.NoError(t, err)
}
