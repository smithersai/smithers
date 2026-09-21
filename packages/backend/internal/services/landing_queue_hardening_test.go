package services

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// --- change_ids cap (input exhaustion) ---

func TestNormalizeChangeIDs_CapsStackSize(t *testing.T) {
	t.Parallel()

	atCap := make([]string, maxLandingStackChanges)
	for i := range atCap {
		atCap[i] = fmt.Sprintf("change-%d", i)
	}
	normalized, err := normalizeChangeIDs(atCap)
	require.NoError(t, err)
	assert.Len(t, normalized, maxLandingStackChanges)

	overCap := append(atCap, "one-too-many")
	_, err = normalizeChangeIDs(overCap)
	assert.Equal(t, 422, landingAPIStatus(t, err))
	_, err = normalizeChangeIDs([]string{strings.Repeat("a", 256)})
	assert.Equal(t, 422, landingAPIStatus(t, err))
}

// --- required status checks gate landings ---

func landingStatusGateQuerier(actor *db.User, repository db.Repository, rules []db.ProtectedBookmark, statuses []db.GetLatestCommitStatusesByChangeIDsAndContextsRow) *mockLandingQuerier {
	return &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(88, repository.ID, arg.Number, actor.ID, []string{"k-a", "k-b"}), nil
		},
		listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
			return rules, nil
		},
		getLatestCommitStatusesFn: func(ctx context.Context, arg db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error) {
			return statuses, nil
		},
	}
}

func TestLandingService_LandLandingRequest_RequiredStatusChecks(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "owner")
	baseRepo := landingRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	tests := []struct {
		name         string
		repoChecks   []string
		rules        []db.ProtectedBookmark
		statuses     []db.GetLatestCommitStatusesByChangeIDsAndContextsRow
		expectStatus int
	}{
		{
			name:         "protected bookmark status contexts block when status missing",
			rules:        []db.ProtectedBookmark{{Pattern: "main", RequireStatusChecks: true, RequiredStatusContexts: []string{"ci/build"}}},
			statuses:     nil,
			expectStatus: 422,
		},
		{
			name:         "protected bookmark status contexts block when status pending",
			rules:        []db.ProtectedBookmark{{Pattern: "main", RequireStatusChecks: true, RequiredStatusContexts: []string{"ci/build"}}},
			statuses:     []db.GetLatestCommitStatusesByChangeIDsAndContextsRow{{Context: "ci/build", Status: "pending"}},
			expectStatus: 422,
		},
		{
			name:         "protected bookmark status contexts block when status failure",
			rules:        []db.ProtectedBookmark{{Pattern: "main", RequireStatusChecks: true, RequiredStatusContexts: []string{"ci/build"}}},
			statuses:     []db.GetLatestCommitStatusesByChangeIDsAndContextsRow{{Context: "ci/build", Status: "failure"}},
			expectStatus: 422,
		},
		{
			name:         "legacy required_checks are enforced",
			rules:        []db.ProtectedBookmark{{Pattern: "main", RequiredChecks: []string{"ci/legacy"}}},
			statuses:     []db.GetLatestCommitStatusesByChangeIDsAndContextsRow{{Context: "ci/legacy", Status: "error"}},
			expectStatus: 422,
		},
		{
			name:         "repo-level landing queue required checks are enforced",
			repoChecks:   []string{"ci/build"},
			statuses:     nil,
			expectStatus: 422,
		},
		{
			name:         "non-matching protected bookmark contexts are ignored",
			rules:        []db.ProtectedBookmark{{Pattern: "release/*", RequireStatusChecks: true, RequiredStatusContexts: []string{"ci/build"}}},
			statuses:     nil,
			expectStatus: 0,
		},
		{
			name:       "landing proceeds when all required checks succeed",
			repoChecks: []string{"ci/build"},
			rules:      []db.ProtectedBookmark{{Pattern: "main", RequireStatusChecks: true, RequiredStatusContexts: []string{"ci/lint"}}},
			statuses: []db.GetLatestCommitStatusesByChangeIDsAndContextsRow{
				{Context: "ci/build", Status: "success"},
				{Context: "ci/lint", Status: "success"},
			},
			expectStatus: 0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			repository := baseRepo
			repository.LandingQueueRequiredChecks = tc.repoChecks
			q := landingStatusGateQuerier(actor, repository, tc.rules, tc.statuses)
			svc := NewLandingService(q, &mockLandingRepoHostClient{})

			_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
			if tc.expectStatus == 0 {
				require.NoError(t, err)
				assert.True(t, q.enqueueLandingRequestCalled)
				assert.True(t, q.createLandingTaskCalled)
			} else {
				assert.Equal(t, tc.expectStatus, landingAPIStatus(t, err))
				assert.False(t, q.enqueueLandingRequestCalled)
			}
		})
	}
}

// --- enqueue must not strand a queued request without a task ---

func TestLandingService_LandLandingRequest_TaskFailureRevertsEnqueue(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "owner")
	repository := landingRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	q := landingStatusGateQuerier(actor, repository, nil, nil)
	q.createLandingTaskFn = func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
		return db.LandingTask{}, fmt.Errorf("transient insert failure")
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
	assert.Equal(t, 500, landingAPIStatus(t, err))
	assert.True(t, q.enqueueLandingRequestCalled)
	assert.True(t, q.revertLandingRequestToOpenCalled,
		"a failed task write must revert the landing request so it is not stranded in 'queued'")
}

type mockLandingLandTx struct {
	enqueueFn    func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error)
	resetOrAddFn func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error)
	committed    bool
	rolledBack   bool
}

func (m *mockLandingLandTx) EnqueueLandingRequest(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
	if m.enqueueFn != nil {
		return m.enqueueFn(ctx, arg)
	}
	row := landingDBRequest(arg.ID, 77, 5, 10, nil)
	row.State = "queued"
	return row, nil
}

func (m *mockLandingLandTx) EnqueueAutoLandRequest(ctx context.Context, arg db.EnqueueAutoLandRequestParams) (db.LandingRequest, error) {
	return m.EnqueueLandingRequest(ctx, db.EnqueueLandingRequestParams(arg))
}

func (m *mockLandingLandTx) ResetOrCreateLandingTask(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
	if m.resetOrAddFn != nil {
		return m.resetOrAddFn(ctx, arg)
	}
	return db.LandingTask{ID: 100, LandingRequestID: arg.LandingRequestID, RepositoryID: arg.RepositoryID, Status: "pending"}, nil
}

func (m *mockLandingLandTx) Commit(ctx context.Context) error {
	m.committed = true
	return nil
}

func (m *mockLandingLandTx) Rollback(ctx context.Context) error {
	m.rolledBack = true
	return nil
}

type mockLandingLandTxManager struct {
	tx *mockLandingLandTx
}

func (m *mockLandingLandTxManager) BeginLandTx(ctx context.Context) (landingLandTx, error) {
	return m.tx, nil
}

func TestLandingService_LandLandingRequest_TransactionalEnqueue(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "owner")
	repository := landingRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	t.Run("commits enqueue and task together", func(t *testing.T) {
		t.Parallel()
		q := landingStatusGateQuerier(actor, repository, nil, nil)
		tx := &mockLandingLandTx{}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		svc.landTxManager = &mockLandingLandTxManager{tx: tx}

		resp, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		require.NoError(t, err)
		assert.Equal(t, int64(100), resp.TaskID)
		assert.True(t, tx.committed)
		assert.False(t, tx.rolledBack)
		assert.False(t, q.createLandingTaskCalled, "tx path must not use the non-transactional task insert")
	})

	t.Run("rolls back enqueue when the task is still active", func(t *testing.T) {
		t.Parallel()
		q := landingStatusGateQuerier(actor, repository, nil, nil)
		tx := &mockLandingLandTx{
			resetOrAddFn: func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
				return db.LandingTask{}, pgx.ErrNoRows
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		svc.landTxManager = &mockLandingLandTxManager{tx: tx}

		_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, 409, landingAPIStatus(t, err))
		assert.True(t, tx.rolledBack)
		assert.False(t, tx.committed)
	})
}

// --- worker: shutdown-safe failure handling ---

func TestLandingWorker_HandleFailure_WritesDespiteCancelledContext(t *testing.T) {
	t.Parallel()

	q := &mockLandingWorkerQuerier{
		markLandingRequestFailedFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			if err := ctx.Err(); err != nil {
				return db.LandingRequest{}, err
			}
			return db.LandingRequest{ID: id, State: "failed"}, nil
		},
		failLandingTaskFn: func(ctx context.Context, arg db.FailLandingTaskParams) (db.LandingTask, error) {
			if err := ctx.Err(); err != nil {
				return db.LandingTask{}, err
			}
			return db.LandingTask{ID: arg.ID, Status: "failed"}, nil
		},
	}
	w := NewLandingWorker(q, &mockWorkerRepoHostClient{})

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // simulate graceful shutdown canceling the worker context mid-land

	w.handleFailure(ctx, workerTask(100, 88, 77), fmt.Errorf("land changes: %w", context.Canceled))

	assert.True(t, q.markLandingRequestFailedCalled)
	assert.True(t, q.failTaskCalled)
	assert.Equal(t, "landed", func() string { // both writes succeeded against the detached context
		if q.lastFailTaskArg.LastError.Valid {
			return "landed"
		}
		return "missing"
	}())
}

// --- worker: post-land DB failures must not mark the landing failed ---

func TestLandingWorker_PostLandMergeFailureDoesNotFailLanding(t *testing.T) {
	t.Parallel()

	mergeAttempts := 0
	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(100, 88, 77), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(id, 77), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{ID: 1, LandingRequestID: arg.LandingRequestID, ChangeID: "k-a", PositionInStack: 1}}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return workerRepo(id), nil
		},
		mergeLandingRequestFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			mergeAttempts++
			return db.LandingRequest{}, fmt.Errorf("connection reset")
		},
	}
	rh := &mockWorkerRepoHostClient{}
	w := NewLandingWorker(q, rh)
	w.finalizeRetryDelay = time.Millisecond

	err := w.PollOnce(context.Background())
	require.NoError(t, err)

	assert.True(t, rh.landCalled)
	assert.Equal(t, landingFinalizeAttempts, mergeAttempts, "merge must be retried before giving up")
	assert.False(t, q.markLandingRequestFailedCalled,
		"a landing whose changes already landed must never be reported as failed")
	assert.False(t, q.failTaskCalled)
}

func TestLandingWorker_PostLandMergeFailureRetriesThenSucceeds(t *testing.T) {
	t.Parallel()

	mergeAttempts := 0
	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(100, 88, 77), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(id, 77), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{ID: 1, LandingRequestID: arg.LandingRequestID, ChangeID: "k-a", PositionInStack: 1}}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return workerRepo(id), nil
		},
		mergeLandingRequestFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			mergeAttempts++
			if mergeAttempts < 3 {
				return db.LandingRequest{}, fmt.Errorf("connection reset")
			}
			return db.LandingRequest{ID: id, State: "merged"}, nil
		},
	}
	w := NewLandingWorker(q, &mockWorkerRepoHostClient{})
	w.finalizeRetryDelay = time.Millisecond

	require.NoError(t, w.PollOnce(context.Background()))
	assert.Equal(t, 3, mergeAttempts)
	assert.True(t, q.markTaskDoneCalled)
	assert.False(t, q.markLandingRequestFailedCalled)
}

// --- worker: reclaimed already-merged tasks must not re-land ---

func TestLandingWorker_AlreadyMergedTaskIsMarkedDoneWithoutRelanding(t *testing.T) {
	t.Parallel()

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(100, 88, 77), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			lr := workerLandingRequest(id, 77)
			lr.State = "merged"
			return lr, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}
	w := NewLandingWorker(q, rh)

	require.NoError(t, w.PollOnce(context.Background()))
	assert.False(t, rh.landCalled, "already-merged changes must not be landed a second time")
	assert.True(t, q.markTaskDoneCalled)
	assert.False(t, q.markLandingRequestFailedCalled)
}

// --- worker: pre-land required status re-check ---

func TestLandingWorker_FailsTaskWhenRequiredChecksRegressed(t *testing.T) {
	t.Parallel()

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(100, 88, 77), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(id, 77), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{ID: 1, LandingRequestID: arg.LandingRequestID, ChangeID: "k-a", PositionInStack: 1}}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			repo := workerRepo(id)
			repo.LandingQueueRequiredChecks = []string{"ci/build"}
			return repo, nil
		},
		getLatestCommitStatusesFn: func(ctx context.Context, arg db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error) {
			return []db.GetLatestCommitStatusesByChangeIDsAndContextsRow{{Context: "ci/build", Status: "failure"}}, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}
	w := NewLandingWorker(q, rh)

	require.NoError(t, w.PollOnce(context.Background()))
	assert.False(t, rh.landCalled, "a landing with regressed required checks must not reach the repo host")
	assert.True(t, q.markLandingRequestFailedCalled)
	assert.True(t, q.failTaskCalled)
	assert.Contains(t, q.lastFailTaskArg.LastError.String, "ci/build")
}

// --- worker: serialized claim + stale-task reaper via the task store ---

type mockLandingTaskStore struct {
	claimFn      func(ctx context.Context) (db.LandingTask, error)
	failStaleFn  func(ctx context.Context, lease time.Duration, maxAttempts int32) ([]StaleLandingTask, error)
	requeueFn    func(ctx context.Context, lease time.Duration, maxAttempts int32) (int64, error)
	claimCalled  bool
	failCalled   bool
	requeueCalls int
}

func (m *mockLandingTaskStore) ClaimPendingLandingTask(ctx context.Context) (db.LandingTask, error) {
	m.claimCalled = true
	if m.claimFn != nil {
		return m.claimFn(ctx)
	}
	return db.LandingTask{}, pgx.ErrNoRows
}

func (m *mockLandingTaskStore) FailStaleLandingTasks(ctx context.Context, lease time.Duration, maxAttempts int32) ([]StaleLandingTask, error) {
	m.failCalled = true
	if m.failStaleFn != nil {
		return m.failStaleFn(ctx, lease, maxAttempts)
	}
	return nil, nil
}

func (m *mockLandingTaskStore) RequeueStaleLandingTasks(ctx context.Context, lease time.Duration, maxAttempts int32) (int64, error) {
	m.requeueCalls++
	if m.requeueFn != nil {
		return m.requeueFn(ctx, lease, maxAttempts)
	}
	return 0, nil
}

func TestLandingWorker_UsesTaskStoreForClaimAndReapsStaleTasks(t *testing.T) {
	t.Parallel()

	q := &mockLandingWorkerQuerier{}
	store := &mockLandingTaskStore{
		failStaleFn: func(ctx context.Context, lease time.Duration, maxAttempts int32) ([]StaleLandingTask, error) {
			assert.Equal(t, landingTaskLease, lease)
			assert.Equal(t, int32(landingTaskMaxAttempts), maxAttempts)
			return []StaleLandingTask{{TaskID: 7, LandingRequestID: 88}}, nil
		},
	}
	w := NewLandingWorker(q, &mockWorkerRepoHostClient{}, WithLandingWorkerTaskStore(store))

	require.NoError(t, w.PollOnce(context.Background()))

	assert.True(t, store.claimCalled, "claim must go through the serialized task store")
	assert.False(t, q.claimCalled, "the raw racy claim must not be used when a task store is wired")
	assert.True(t, store.failCalled)
	assert.Equal(t, 1, store.requeueCalls)
	assert.True(t, q.markLandingRequestFailedCalled,
		"an exhausted stale task must fail its landing request so the queue can drain")

	// The reap sweep is throttled: an immediate second poll must not re-run it.
	require.NoError(t, w.PollOnce(context.Background()))
	assert.Equal(t, 1, store.requeueCalls)
}

// --- worker: oversized legacy stacks must not land partially ---

func TestLandingWorker_RefusesPartialStack(t *testing.T) {
	t.Parallel()

	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return workerTask(100, 88, 77), nil
		},
		getLandingRequestByIDFn: func(ctx context.Context, id int64) (db.LandingRequest, error) {
			return workerLandingRequest(id, 77), nil
		},
		listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			changes := make([]db.LandingRequestChange, maxLandingStackChanges+1)
			for i := range changes {
				changes[i] = db.LandingRequestChange{ID: int64(i + 1), LandingRequestID: arg.LandingRequestID, ChangeID: fmt.Sprintf("k-%d", i), PositionInStack: int64(i + 1)}
			}
			return changes, nil
		},
	}
	rh := &mockWorkerRepoHostClient{}
	w := NewLandingWorker(q, rh)

	require.NoError(t, w.PollOnce(context.Background()))
	assert.False(t, rh.landCalled)
	assert.True(t, q.failTaskCalled)
}
