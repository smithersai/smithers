package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workflowSchedulerCovQuerier struct {
	specs    []db.WorkflowScheduleSpec
	claimErr error
	updates  []db.UpdateWorkflowScheduleFireTimesParams
}

func (q *workflowSchedulerCovQuerier) ClaimDueWorkflowScheduleSpecs(context.Context, int32) ([]db.WorkflowScheduleSpec, error) {
	return q.specs, q.claimErr
}

func (q *workflowSchedulerCovQuerier) UpdateWorkflowScheduleFireTimes(_ context.Context, arg db.UpdateWorkflowScheduleFireTimesParams) error {
	q.updates = append(q.updates, arg)
	return nil
}

type workflowSchedulerCovDispatcher struct {
	err   error
	calls int
}

func (d *workflowSchedulerCovDispatcher) DispatchForEvent(context.Context, DispatchForEventInput) ([]WorkflowRunResult, error) {
	d.calls++
	return nil, d.err
}

func TestWorkflowScheduler_Cov_StartAndPollBranches(t *testing.T) {
	q := &workflowSchedulerCovQuerier{}
	dispatcher := &workflowSchedulerCovDispatcher{}
	worker := NewCronSchedulerWorker(q, dispatcher)
	if worker.claimLimit != 50 || worker.interval != 30*time.Second {
		t.Fatalf("worker defaults = %+v", worker)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	worker.Start(ctx)

	q.claimErr = errors.New("claim failed")
	if err := worker.PollOnce(context.Background()); err == nil || err.Error() != "claim failed" {
		t.Fatalf("claim err = %v", err)
	}
}

func TestWorkflowScheduler_Cov_PollOnceContinuesOnDispatchAndCronErrors(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)

	// (a) Dispatch succeeds for both specs. The cron-error spec's update is
	// skipped (unreachable in practice: crons are validated at sync time),
	// while the valid-cron spec's fire time is advanced.
	q := &workflowSchedulerCovQuerier{specs: []db.WorkflowScheduleSpec{
		{ID: 1, RepositoryID: 10, WorkflowDefinitionID: 20, CronExpression: "*/5 * * * *"},
		{ID: 2, RepositoryID: 11, WorkflowDefinitionID: 21, CronExpression: "bad cron"},
	}}
	dispatcher := &workflowSchedulerCovDispatcher{}
	worker := NewCronSchedulerWorker(q, dispatcher)
	if err := worker.pollOnce(context.Background(), now); err != nil {
		t.Fatalf("pollOnce returned error: %v", err)
	}
	if dispatcher.calls != 2 {
		t.Fatalf("dispatch calls = %d", dispatcher.calls)
	}
	if len(q.updates) != 1 || q.updates[0].ID != 1 || !q.updates[0].PrevFireAt.Valid || !q.updates[0].NextFireAt.After(now) {
		t.Fatalf("updates = %+v", q.updates)
	}

	// (b) Dispatch fails: the occurrence must not be acknowledged, so no
	// fire-time update is written and the spec's claim lease is left to
	// expire and retry (regression coverage for issue 319).
	q2 := &workflowSchedulerCovQuerier{specs: []db.WorkflowScheduleSpec{
		{ID: 3, RepositoryID: 12, WorkflowDefinitionID: 22, CronExpression: "*/5 * * * *"},
	}}
	failDispatcher := &workflowSchedulerCovDispatcher{err: errors.New("dispatch failed")}
	if err := NewCronSchedulerWorker(q2, failDispatcher).pollOnce(context.Background(), now); err != nil {
		t.Fatalf("pollOnce returned error: %v", err)
	}
	if failDispatcher.calls != 1 {
		t.Fatalf("dispatch calls = %d", failDispatcher.calls)
	}
	if len(q2.updates) != 0 {
		t.Fatalf("updates = %+v, want none", q2.updates)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	q3 := &workflowSchedulerCovQuerier{specs: []db.WorkflowScheduleSpec{{ID: 4, CronExpression: "* * * * *"}}}
	err := NewCronSchedulerWorker(q3, &workflowSchedulerCovDispatcher{}).pollOnce(ctx, now)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled poll err = %v", err)
	}
}
