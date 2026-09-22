package clusterservices

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	db "github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

type taskStatusQueries struct {
	RunnerQuerier
	read func(context.Context, db.GetRunnerWorkflowTaskStatusParams) (string, error)
}

func (q taskStatusQueries) GetRunnerWorkflowTaskStatus(ctx context.Context, input db.GetRunnerWorkflowTaskStatusParams) (string, error) {
	return q.read(ctx, input)
}

func TestRunnerTaskStatus_FencesCredentialAndCurrentOwnership(t *testing.T) {
	for _, tc := range []struct {
		name         string
		task, runner int64
		readError    error
		wantCode     int
		wantRead     bool
	}{
		{name: "owner sees cancellation", task: 55, runner: 7, wantRead: true},
		{name: "other runner denied before read", task: 55, runner: 8, wantCode: 403},
		{name: "other task denied before read", task: 56, runner: 7, wantCode: 404},
		{name: "reassigned task is absent", task: 55, runner: 7, readError: pgx.ErrNoRows, wantCode: 404, wantRead: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			read := false
			q := taskStatusQueries{read: func(_ context.Context, input db.GetRunnerWorkflowTaskStatusParams) (string, error) {
				read = true
				require.EqualValues(t, 55, input.TaskID)
				require.True(t, input.RunnerID.Valid)
				require.EqualValues(t, 7, input.RunnerID.Int64)
				return "cancelled", tc.readError
			}}
			ctx := middleware.ContextWithRunnerTaskToken(context.Background(), middleware.RunnerTaskTokenClaims{TaskID: 55, RunnerID: 7})
			svc := NewRunnerService(q).(interface {
				GetTaskStatus(context.Context, int64, int64) (string, error)
			})
			status, err := svc.GetTaskStatus(ctx, tc.task, tc.runner)
			require.Equal(t, tc.wantRead, read)
			if tc.wantCode == 0 {
				require.NoError(t, err)
				require.Equal(t, "cancelled", status)
			} else {
				var apiError *pkgerrors.APIError
				require.ErrorAs(t, err, &apiError)
				require.Equal(t, tc.wantCode, apiError.Status)
				require.Empty(t, status)
			}
		})
	}
}
