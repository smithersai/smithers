package services

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workflowSchedulerZQuerier struct {
	workflowSchedulerCovQuerier
	updateErr error
}

func (q *workflowSchedulerZQuerier) UpdateWorkflowScheduleFireTimes(ctx context.Context, arg db.UpdateWorkflowScheduleFireTimesParams) error {
	_ = q.workflowSchedulerCovQuerier.UpdateWorkflowScheduleFireTimes(ctx, arg)
	return q.updateErr
}

func TestWorkflowScheduler_Z_StartPanicPollErrorAndUpdateError(t *testing.T) {
	NewCronSchedulerWorker(nil, &workflowSchedulerCovDispatcher{}).Start(context.Background())

	ctx, cancel := context.WithCancel(context.Background())
	q := &workflowSchedulerCovQuerier{claimErr: errors.New("claim failed")}
	worker := NewCronSchedulerWorker(q, &workflowSchedulerCovDispatcher{})
	worker.interval = time.Millisecond
	worker.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	go worker.Start(ctx)
	time.Sleep(5 * time.Millisecond)
	cancel()

	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	zq := &workflowSchedulerZQuerier{
		workflowSchedulerCovQuerier: workflowSchedulerCovQuerier{specs: []db.WorkflowScheduleSpec{{ID: 1, RepositoryID: 2, WorkflowDefinitionID: 3, CronExpression: "* * * * *"}}},
		updateErr:                   errors.New("update failed"),
	}
	require.NoError(t, NewCronSchedulerWorker(zq, &workflowSchedulerCovDispatcher{}).pollOnce(context.Background(), now))
	require.Len(t, zq.updates, 1)
}
