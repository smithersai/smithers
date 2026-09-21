package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

func TestLandingWorker_Cov_StartExecuteAndOwnerErrorBranches(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(ctx context.Context) (db.LandingTask, error) {
			return db.LandingTask{}, ctx.Err()
		},
	}
	w := NewLandingWorker(q, &mockWorkerRepoHostClient{})
	w.interval = time.Millisecond
	w.Start(ctx)
	assert.True(t, q.claimCalled)

	_, err := w.resolveRepoOwner(context.Background(), db.Repository{ID: 99})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "neither user nor org owner")

	erringOwner := workerRepo(77)
	erringOwner.UserID = pgtype.Int8{Int64: 123, Valid: true}
	q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
		return db.User{}, assert.AnError
	}
	_, err = w.resolveRepoOwner(context.Background(), erringOwner)
	require.Error(t, err)
}

func TestLandingWorker_Cov_HandleFailureAndFailedDispatchFallback(t *testing.T) {
	task := workerTask(1, 2, 3)

	t.Run("failure recording errors are swallowed after attempts", func(t *testing.T) {
		q := &mockLandingWorkerQuerier{
			markLandingRequestFailedFn: func(context.Context, int64) (db.LandingRequest, error) {
				return db.LandingRequest{}, assert.AnError
			},
			failLandingTaskFn: func(context.Context, db.FailLandingTaskParams) (db.LandingTask, error) {
				return db.LandingTask{}, assert.AnError
			},
			getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
				return db.LandingRequest{}, assert.AnError
			},
		}
		w := NewLandingWorker(q, &mockWorkerRepoHostClient{}, WithLandingWorkerWebhookDispatcher(&mockWorkerWebhookDispatcher{}))

		w.handleFailure(context.Background(), task, fmt.Errorf("land failed"))
		assert.True(t, q.markLandingRequestFailedCalled)
		assert.True(t, q.failTaskCalled)
		assert.Equal(t, "land failed", q.lastFailTaskArg.LastError.String)
	})

	t.Run("failed webhook loads landing request when revert did not return it", func(t *testing.T) {
		q := &mockLandingWorkerQuerier{
			getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
				lr := workerLandingRequest(2, 3)
				lr.State = "failed"
				return lr, nil
			},
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return workerRepo(3), nil
			},
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return db.User{ID: 10, Username: "alice"}, nil
			},
			listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
				return []db.LandingRequestChange{{ChangeID: "k1"}}, nil
			},
		}
		dispatcher := &mockWorkerWebhookDispatcher{}
		w := NewLandingWorker(q, &mockWorkerRepoHostClient{}, WithLandingWorkerWebhookDispatcher(dispatcher))

		w.dispatchFailedEvent(context.Background(), task, db.LandingRequest{})
		require.Len(t, dispatcher.calls, 1)
		payload := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
		assert.Equal(t, "failed", payload.Action)
		assert.Equal(t, []string{"k1"}, payload.LandingRequest.ChangeIDs)
	})
}

func TestLandingWorker_Cov_ExecuteTaskIntermediateFailures(t *testing.T) {
	baseTask := workerTask(10, 20, 30)
	for _, tc := range []struct {
		name    string
		mutate  func(*mockLandingWorkerQuerier)
		wantErr string
	}{
		{
			name: "mark started",
			mutate: func(q *mockLandingWorkerQuerier) {
				q.markLandingStartedFn = func(context.Context, int64) (db.LandingRequest, error) {
					return db.LandingRequest{}, assert.AnError
				}
			},
			wantErr: "mark landing started",
		},
		{
			name: "merge",
			mutate: func(q *mockLandingWorkerQuerier) {
				q.mergeLandingRequestFn = func(context.Context, int64) (db.LandingRequest, error) {
					return db.LandingRequest{}, assert.AnError
				}
			},
			wantErr: "merge landing request",
		},
		{
			name: "mark done",
			mutate: func(q *mockLandingWorkerQuerier) {
				q.markLandingTaskDoneFn = func(context.Context, int64) (db.LandingTask, error) {
					return db.LandingTask{}, assert.AnError
				}
			},
			wantErr: "mark task done",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return workerLandingRequest(20, 30), nil
				},
				listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
					return []db.LandingRequestChange{{ChangeID: "k1"}}, nil
				},
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return workerRepo(30), nil
				},
				getUserByIDFn: func(context.Context, int64) (db.User, error) {
					return db.User{ID: 1, Username: "alice"}, nil
				},
			}
			tc.mutate(q)
			w := NewLandingWorker(q, &mockWorkerRepoHostClient{})
			w.finalizeRetryDelay = 0 // Exercise every retry without production backoff.

			err := w.executeTask(context.Background(), baseTask)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}
