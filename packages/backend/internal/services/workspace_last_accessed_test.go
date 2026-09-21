package services

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Ticket 0136: server-side last_accessed_at must fire from real
// workspace-entry flows (CreateSession, session SSH info,
// workspace SSH info) and MUST NOT fire from passive reads like
// ListSessions / GetSession / ListWorkspaces. These tests are mocks
// of the querier — the "did it fire" assertion is a simple counter.

type touchCounter struct {
	activity     atomic.Int64
	lastAccessed atomic.Int64
}

func newTouchTrackingQuerier(t *testing.T, counters *touchCounter) *mockWorkspaceQuerier {
	t.Helper()
	q := &mockWorkspaceQuerier{}
	q.touchWorkspaceActivityFn = func(ctx context.Context, id string) error {
		counters.activity.Add(1)
		return nil
	}
	q.touchWorkspaceLastAccessedFn = func(ctx context.Context, id string) error {
		counters.lastAccessed.Add(1)
		return nil
	}
	return q
}

func TestCreateSession_TouchesLastAccessed(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)

	// Route CreateSession through an active pre-existing workspace (skips the
	// create-new branch so we isolate the attach-moment touch).
	existing := sampleDBWorkspace("ws-123")
	existing.UserID = 10 // matches the CreateSession caller below
	existing.Status = "running"
	existing.VmID = "vm-abc"
	q.getWorkspaceByRepoFn = func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		return existing, nil
	}
	q.createWorkspaceSessionFn = func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
		return db.WorkspaceSession{ID: "sess-1", WorkspaceID: arg.WorkspaceID, RepositoryID: arg.RepositoryID, UserID: arg.UserID, Status: "pending"}, nil
	}
	q.updateWorkspaceSessionStatusFn = func(ctx context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
		return db.WorkspaceSession{ID: arg.ID, Status: arg.Status}, nil
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	_, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 1,
		UserID:       10,
		WorkspaceID:  "ws-123",
		Cols:         80,
		Rows:         24,
	})
	require.NoError(t, err)

	assert.Equal(t, int64(1), counters.lastAccessed.Load(), "CreateSession must bump last_accessed_at exactly once")
}

func TestGetSSHConnectionInfo_TouchesLastAccessed(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)

	q.getWorkspaceSessionByRepoFn = func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
		return db.WorkspaceSession{
			ID:           arg.ID,
			WorkspaceID:  "ws-ssh-session",
			RepositoryID: arg.RepositoryID,
			UserID:       10, // matches the GetSSHConnectionInfo caller below
			Status:       "running",
			Cols:         80,
			Rows:         24,
		}, nil
	}
	q.getWorkspaceByRepoFn = func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		workspace := sampleDBWorkspace(arg.ID)
		workspace.UserID = 10 // matches the session owner and caller
		workspace.VmID = "vm-session-ssh"
		workspace.Status = "running"
		return workspace, nil
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	_, err := svc.GetSSHConnectionInfo(context.Background(), "sess-ssh", 1, 10)
	require.NoError(t, err)

	assert.Equal(t, int64(1), counters.lastAccessed.Load(), "GetSSHConnectionInfo must bump last_accessed_at exactly once")
}

func TestGetWorkspaceSSHConnectionInfo_TouchesLastAccessed(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)

	q.getWorkspaceByRepoFn = func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		workspace := sampleDBWorkspace(arg.ID)
		workspace.UserID = 10 // matches the GetWorkspaceSSHConnectionInfo caller below
		workspace.VmID = "vm-workspace-ssh"
		workspace.Status = "running"
		return workspace, nil
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	_, err := svc.GetWorkspaceSSHConnectionInfo(context.Background(), "ws-ssh", 1, 10)
	require.NoError(t, err)

	assert.Equal(t, int64(1), counters.lastAccessed.Load(), "GetWorkspaceSSHConnectionInfo must bump last_accessed_at exactly once")
}

func TestListSessions_DoesNotTouchLastAccessed(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)
	q.listWorkspaceSessionsByRepoFn = func(ctx context.Context, arg db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error) {
		return []db.WorkspaceSession{{ID: "s1"}, {ID: "s2"}}, nil
	}
	q.countWorkspaceSessionsByRepoFn = func(ctx context.Context, arg db.CountWorkspaceSessionsByRepoParams) (int64, error) {
		return 2, nil
	}

	svc := newWorkspaceServiceForTests(q)
	_, _, err := svc.ListSessions(context.Background(), 1, 10, 1, 30)
	require.NoError(t, err)

	assert.Equal(t, int64(0), counters.lastAccessed.Load(), "ListSessions (passive read) must NOT bump last_accessed_at")
	assert.Equal(t, int64(0), counters.activity.Load(), "ListSessions (passive read) must NOT bump last_activity_at either")
}

func TestListWorkspaces_DoesNotTouchLastAccessed(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)
	q.listWorkspacesByRepoFn = func(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
		return []db.Workspace{sampleDBWorkspace("a")}, nil
	}
	q.countWorkspacesByRepoFn = func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
		return 1, nil
	}

	svc := newWorkspaceServiceForTests(q)
	_, _, err := svc.ListWorkspaces(context.Background(), 1, 10, 1, 30)
	require.NoError(t, err)

	assert.Equal(t, int64(0), counters.lastAccessed.Load(), "ListWorkspaces (passive read) must NOT bump last_accessed_at")
}

func TestListUserWorkspacesAcrossRepos_DoesNotTouchLastAccessed(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)
	q.listUserWorkspacesAcrossReposFn = func(ctx context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
		return []db.ListUserWorkspacesAcrossReposRow{{WorkspaceID: "ws-1"}}, nil
	}
	q.countUserWorkspacesAcrossReposFn = func(ctx context.Context, userID int64) (int64, error) {
		return 1, nil
	}

	svc := newWorkspaceServiceForTests(q)
	_, err := svc.ListUserWorkspacesAcrossRepos(context.Background(), 10, 1, 30)
	require.NoError(t, err)

	assert.Equal(t, int64(0), counters.lastAccessed.Load(), "cross-repo listing is a read; must NOT bump last_accessed_at")
}

func TestListUserWorkspacesAcrossRepos_CapsLimitAt100(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)

	var observedPageSize int32
	q.listUserWorkspacesAcrossReposFn = func(ctx context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
		observedPageSize = arg.PageSize
		return nil, nil
	}
	q.countUserWorkspacesAcrossReposFn = func(ctx context.Context, userID int64) (int64, error) {
		return 0, nil
	}

	svc := newWorkspaceServiceForTests(q)
	_, err := svc.ListUserWorkspacesAcrossRepos(context.Background(), 10, 1, 500)
	require.NoError(t, err)

	assert.Equal(t, int32(MaxUserWorkspacesPerPage), observedPageSize, "limit must clamp to MaxUserWorkspacesPerPage (100)")
}

func TestListUserWorkspacesAcrossRepos_MapsSwitcherFields(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)

	createdAt := time.Date(2026, 4, 24, 12, 0, 0, 0, time.UTC)
	lastAccessedAt := createdAt.Add(45 * time.Minute)
	lastActivityAt := createdAt.Add(90 * time.Minute)
	suspendedAt := createdAt.Add(15 * time.Minute)
	startedAt := createdAt.Add(30 * time.Minute)

	q.listUserWorkspacesAcrossReposFn = func(ctx context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
		return []db.ListUserWorkspacesAcrossReposRow{
			{
				WorkspaceID:       "ws-1",
				RepositoryID:      101,
				RepositoryOwner:   "alice",
				RepositoryName:    "demo",
				WorkspaceTitle:    "feature/switcher",
				Status:            "running",
				TargetBookmark:    "trunk",
				ProvisioningStage: "ready",
				SuspendedAt:       pgtype.Timestamptz{Time: suspendedAt, Valid: true},
				Kind:              "desktop",
				HeadChangeID:      "change-1",
				HeadCommitID:      "commit-1",
				Ahead:             4,
				Behind:            2,
				StartedAt:         pgtype.Timestamptz{Time: startedAt, Valid: true},
				LastAccessedAt:    pgtype.Timestamptz{Time: lastAccessedAt, Valid: true},
				LastActivityAt:    lastActivityAt,
				CreatedAt:         createdAt,
				SortTimestamp:     lastAccessedAt,
			},
		}, nil
	}
	q.countUserWorkspacesAcrossReposFn = func(ctx context.Context, userID int64) (int64, error) {
		return 1, nil
	}

	svc := newWorkspaceServiceForTests(q)
	result, err := svc.ListUserWorkspacesAcrossRepos(context.Background(), 10, 1, 30)
	require.NoError(t, err)
	require.Len(t, result.Items, 1)

	row := result.Items[0]
	assert.Equal(t, "ws-1", row.WorkspaceID)
	assert.Equal(t, int64(101), row.RepositoryID)
	assert.Equal(t, "alice", row.RepositoryOwner)
	assert.Equal(t, "demo", row.RepositoryName)
	assert.Equal(t, "feature/switcher", row.WorkspaceTitle)
	assert.Equal(t, "running", row.State)
	assert.Equal(t, "trunk", row.TargetBookmark)
	assert.Equal(t, "ready", row.ProvisioningStage)
	require.NotNil(t, row.SuspendedAt)
	assert.Equal(t, suspendedAt, row.SuspendedAt.UTC())
	assert.Equal(t, "desktop", row.Kind)
	assert.Equal(t, WorkspaceHead{ChangeID: "change-1", CommitID: "commit-1"}, row.Head)
	assert.Equal(t, int32(4), row.Ahead)
	assert.Equal(t, int32(2), row.Behind)
	require.NotNil(t, row.StartedAt)
	assert.Equal(t, startedAt, row.StartedAt.UTC())
	require.NotNil(t, row.LastAccessedAt)
	assert.Equal(t, lastAccessedAt, row.LastAccessedAt.UTC())
	assert.Equal(t, lastActivityAt, row.LastActivityAt)
	assert.Equal(t, createdAt, row.CreatedAt)
	assert.Equal(t, lastAccessedAt, row.SortTimestamp)
}

func TestListUserWorkspacesAcrossRepos_PreservesFallbackAndTieBreakOrder(t *testing.T) {
	counters := &touchCounter{}
	q := newTouchTrackingQuerier(t, counters)

	newer := time.Date(2026, 4, 24, 14, 0, 0, 0, time.UTC)
	older := newer.Add(-time.Hour)

	q.listUserWorkspacesAcrossReposFn = func(ctx context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error) {
		return []db.ListUserWorkspacesAcrossReposRow{
			// Row 0: newer fallback timestamp should stay first.
			{
				WorkspaceID:     "ws-3",
				RepositoryID:    3,
				RepositoryOwner: "alice",
				RepositoryName:  "repo-c",
				WorkspaceTitle:  "repo-c",
				Status:          "running",
				CreatedAt:       older,
				SortTimestamp:   newer,
			},
			// Rows 1-2: equal fallback timestamp; deterministic order is tie-break.
			{
				WorkspaceID:     "ws-2",
				RepositoryID:    2,
				RepositoryOwner: "alice",
				RepositoryName:  "repo-b",
				WorkspaceTitle:  "repo-b",
				Status:          "running",
				CreatedAt:       older,
				SortTimestamp:   older,
			},
			{
				WorkspaceID:     "ws-1",
				RepositoryID:    1,
				RepositoryOwner: "alice",
				RepositoryName:  "repo-a",
				WorkspaceTitle:  "repo-a",
				Status:          "running",
				CreatedAt:       older,
				SortTimestamp:   older,
			},
		}, nil
	}
	q.countUserWorkspacesAcrossReposFn = func(ctx context.Context, userID int64) (int64, error) {
		return 3, nil
	}

	svc := newWorkspaceServiceForTests(q)
	result, err := svc.ListUserWorkspacesAcrossRepos(context.Background(), 10, 1, 30)
	require.NoError(t, err)
	require.Len(t, result.Items, 3)

	assert.Equal(t, "ws-3", result.Items[0].WorkspaceID)
	assert.Equal(t, "ws-2", result.Items[1].WorkspaceID)
	assert.Equal(t, "ws-1", result.Items[2].WorkspaceID)
	assert.True(t, result.Items[0].SortTimestamp.After(result.Items[1].SortTimestamp))
	assert.Equal(t, result.Items[1].SortTimestamp, result.Items[2].SortTimestamp)
	assert.Nil(t, result.Items[0].LastAccessedAt, "fallback rows should keep last_accessed_at null")
	assert.Nil(t, result.Items[1].LastAccessedAt, "fallback rows should keep last_accessed_at null")
	assert.Nil(t, result.Items[2].LastAccessedAt, "fallback rows should keep last_accessed_at null")
}
