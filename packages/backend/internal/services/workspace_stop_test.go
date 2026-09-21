package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type stopWorkspaceStore struct {
	*mockWorkspaceQuerier
	stop func(context.Context, string) (db.StopWorkspaceRetainingRowRow, error)
}

func (q *stopWorkspaceStore) StopWorkspaceRetainingRow(ctx context.Context, id string) (db.StopWorkspaceRetainingRowRow, error) {
	return q.stop(ctx, id)
}

func TestWorkspaceStopFailuresRemainRetryable(t *testing.T) {
	for _, failure := range []string{"credentials", "sandbox", "status"} {
		t.Run(failure, func(t *testing.T) {
			row := sampleDBWorkspace("workspace")
			row.Status, row.VmID = "running", "vm"
			row.HeadPushTokenID = pgtype.Int8{Int64: 12, Valid: true}
			fail := true
			deletes, transitions := 0, 0
			metrics := newObserveV2Metrics()
			q := &stopWorkspaceStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
			q.getWorkspaceByRepoFn = func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return row, nil }
			q.deleteAccessTokenFn = func(context.Context, db.DeleteAccessTokenParams) error {
				if fail && failure == "credentials" {
					return errors.New("token store unavailable")
				}
				row.HeadPushTokenID = pgtype.Int8{}
				return nil
			}
			q.suspendRunningWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
				if row.Status != "running" {
					return db.Workspace{}, pgx.ErrNoRows
				}
				row.Status = "suspended"
				return row, nil
			}
			q.softDeleteWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
				t.Fatal("stop must never tombstone the workspace")
				return db.Workspace{}, nil
			}
			q.stop = func(context.Context, string) (db.StopWorkspaceRetainingRowRow, error) {
				if fail && failure == "status" {
					return db.StopWorkspaceRetainingRowRow{}, errors.New("status store unavailable")
				}
				row.Status = "stopped"
				transitions++
				return db.StopWorkspaceRetainingRowRow(row), nil
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{deleteVMFn: func(context.Context, string) error {
				deletes++
				if fail && failure == "sandbox" {
					return errors.New("provider unavailable")
				}
				if !fail {
					return &sandbox.StatusError{StatusCode: 404, Message: "already gone"}
				}
				return nil
			}}), WithWorkspaceSandboxMetrics(metrics))
			_, err := svc.StopWorkspace(context.Background(), row.ID, row.RepositoryID, row.UserID)
			require.Error(t, err)
			require.Equal(t, 1.0, testutil.ToFloat64(metrics.lifecycle.WithLabelValues("stop", "failure")))
			require.Zero(t, testutil.ToFloat64(metrics.lifecycle.WithLabelValues("stop", "success")))
			require.False(t, row.DeletedAt.Valid)
			require.NotEqual(t, "stopped", row.Status)
			require.Zero(t, transitions)
			if failure == "credentials" {
				require.Zero(t, deletes)
			}
			fail = false
			result, err := svc.StopWorkspace(context.Background(), row.ID, row.RepositoryID, row.UserID)
			require.NoError(t, err)
			require.Equal(t, "stopped", result.Status)
			require.False(t, row.DeletedAt.Valid)
			require.False(t, row.HeadPushTokenID.Valid)
			require.Equal(t, 1, transitions)
			require.Equal(t, float64(-1), testutil.ToFloat64(metrics.active.WithLabelValues("workspace")))
			require.Equal(t, 1.0, testutil.ToFloat64(metrics.lifecycle.WithLabelValues("stop", "failure")))
			require.Equal(t, 1.0, testutil.ToFloat64(metrics.lifecycle.WithLabelValues("stop", "success")))
		})
	}
}
