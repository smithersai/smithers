package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFCov_LandingTasks_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	userInt8 := pgtype.Int8{Int64: userID, Valid: true}

	lr, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{
		RepositoryID: repoID, Title: "land me", Body: "", AuthorID: userID,
		TargetBookmark: "main", SourceBookmark: "feature", StackSize: 1,
	})
	require.NoError(t, err)

	byID, err := q.GetLandingRequestByID(ctx, lr.ID)
	require.NoError(t, err)
	assert.Equal(t, lr.ID, byID.ID)

	enqueued, err := q.EnqueueLandingRequest(ctx, EnqueueLandingRequestParams{
		QueuedBy: userInt8, ID: lr.ID, TargetBookmark: "main", SourceBookmark: "feature",
	})
	require.NoError(t, err)
	assert.Equal(t, "queued", enqueued.State)

	task, err := q.CreateLandingTask(ctx, CreateLandingTaskParams{LandingRequestID: lr.ID, RepositoryID: repoID, Priority: 0})
	require.NoError(t, err)

	taskByLR, err := q.GetLandingTaskByLandingRequestID(ctx, lr.ID)
	require.NoError(t, err)
	assert.Equal(t, task.ID, taskByLR.ID)

	pos, err := q.GetLandingQueuePositionByTaskID(ctx, task.ID)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, pos, int64(1))

	claimed, err := q.ClaimPendingLandingTask(ctx)
	require.NoError(t, err)
	assert.Equal(t, task.ID, claimed.ID)

	started, err := q.MarkLandingStarted(ctx, lr.ID)
	require.NoError(t, err)
	assert.Equal(t, "landing", started.State)

	doneTask, err := q.MarkLandingTaskDone(ctx, task.ID)
	require.NoError(t, err)
	assert.Equal(t, "done", doneTask.Status)

	// A second landing request + task exercised through the failure path
	// (landing_tasks has a UNIQUE(landing_request_id) constraint).
	lr2, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{
		RepositoryID: repoID, Title: "land me 2", Body: "", AuthorID: userID,
		TargetBookmark: "main", SourceBookmark: "feature-2", StackSize: 1,
	})
	require.NoError(t, err)
	failTask, err := q.CreateLandingTask(ctx, CreateLandingTaskParams{LandingRequestID: lr2.ID, RepositoryID: repoID, Priority: 1})
	require.NoError(t, err)
	failedTask, err := q.FailLandingTask(ctx, FailLandingTaskParams{ID: failTask.ID, LastError: pgtype.Text{String: "boom", Valid: true}})
	require.NoError(t, err)
	assert.Equal(t, "failed", failedTask.Status)

	failedLR, err := q.MarkLandingRequestFailed(ctx, lr.ID)
	require.NoError(t, err)
	assert.Equal(t, "failed", failedLR.State)

	revertedLR, err := q.RevertLandingRequestToOpen(ctx, lr.ID)
	require.NoError(t, err)
	assert.Equal(t, "open", revertedLR.State)

	// Review round-trip.
	review, err := q.CreateLandingRequestReview(ctx, CreateLandingRequestReviewParams{
		LandingRequestID: lr.ID, ReviewerID: userInt8, Type: "approve", Body: "lgtm",
	})
	require.NoError(t, err)
	gotReview, err := q.GetLandingRequestReviewByID(ctx, review.ID)
	require.NoError(t, err)
	assert.Equal(t, review.ID, gotReview.ID)

	// Keyset listing must return >= 1 row.
	keyset, err := q.ListLandingRequestsByRepoFilteredKeyset(ctx, ListLandingRequestsByRepoFilteredKeysetParams{
		RepositoryID: repoID, State: "", AfterNumber: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(keyset), 1)
}

func TestFCov_CountsAndSweeps(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	bookmarks, err := q.CountBookmarksByRepo(ctx, repoID)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, bookmarks, int64(0))
	changes, err := q.CountChangesByRepo(ctx, repoID)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, changes, int64(0))
	jjOps, err := q.CountJjOperationsByRepo(ctx, repoID)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, jjOps, int64(0))

	require.NoError(t, q.DeleteAllRateLimits(ctx))
}

func TestFCov_ProtectedBookmarks_ListAll(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	_, err := q.UpsertProtectedBookmark(ctx, UpsertProtectedBookmarkParams{
		RepositoryID: repoID, Pattern: "main", RequireReview: true, RequireHumanApprovals: 1,
		RequiredChecks: []string{"ci"}, RequireStatusChecks: true, RequiredStatusContexts: []string{"build"},
		DismissStaleReviews: false, RestrictPushTeams: []string{},
	})
	require.NoError(t, err)

	all, err := q.ListAllProtectedBookmarksByRepo(ctx, repoID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(all), 1)
}

func TestFCov_RegisterWorkspaceVM_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	ws, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "ws-" + randSlug(t), IsFork: false,
		ParentWorkspaceID: pgtype.UUID{}, SourceSnapshotID: pgtype.UUID{}, TargetBookmark: "main", Status: "pending",
	})
	require.NoError(t, err)

	registered, err := q.RegisterWorkspaceVM(ctx, RegisterWorkspaceVMParams{ID: ws.ID, VmID: "vm-" + randSlug(t), Status: "running"})
	require.NoError(t, err)
	assert.Equal(t, "running", registered.Status)
}
