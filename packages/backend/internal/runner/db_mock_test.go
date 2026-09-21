package runner

import (
	"context"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockStore struct {
	mu sync.Mutex

	upsertRunnerFn        func(ctx context.Context, arg db.UpsertRunnerParams) (db.RunnerPool, error)
	touchRunnerHeartbeat  func(ctx context.Context, id int64) (db.RunnerPool, error)
	claimIdleRunnerFn     func(ctx context.Context, runnerID int64) (db.RunnerPool, error)
	claimPendingTaskFn    func(ctx context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error)
	releaseRunnerFn       func(ctx context.Context, runnerID int64) (int64, error)
	terminateRunnerFn     func(ctx context.Context, runnerID int64) (db.RunnerPool, error)
	requeueTasksForRunner func(ctx context.Context, runnerID pgtype.Int8) (int64, error)
	markTaskRunningFn     func(ctx context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error)
	markTaskDoneFn        func(ctx context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error)
	getTerminalTaskFn     func(ctx context.Context, arg db.GetTerminalWorkflowTaskForRunnerParams) (int64, error)
	clearTerminalTaskFn   func(ctx context.Context, arg db.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error)
	listStaleRunnersFn    func(ctx context.Context, cutoffAt pgtype.Timestamptz) ([]db.RunnerPool, error)

	releaseCalls int
}

func (m *mockStore) UpsertRunner(ctx context.Context, arg db.UpsertRunnerParams) (db.RunnerPool, error) {
	if m.upsertRunnerFn != nil {
		return m.upsertRunnerFn(ctx, arg)
	}
	return db.RunnerPool{}, nil
}

func (m *mockStore) TouchRunnerHeartbeat(ctx context.Context, id int64) (db.RunnerPool, error) {
	if m.touchRunnerHeartbeat != nil {
		return m.touchRunnerHeartbeat(ctx, id)
	}
	return db.RunnerPool{}, nil
}

func (m *mockStore) ClaimIdleRunner(ctx context.Context, runnerID int64) (db.RunnerPool, error) {
	if m.claimIdleRunnerFn != nil {
		return m.claimIdleRunnerFn(ctx, runnerID)
	}
	return db.RunnerPool{}, nil
}

func (m *mockStore) ClaimPendingTask(ctx context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
	if m.claimPendingTaskFn != nil {
		return m.claimPendingTaskFn(ctx, runnerID)
	}
	return db.WorkflowTask{}, nil
}

func (m *mockStore) ReleaseRunner(ctx context.Context, runnerID int64) (int64, error) {
	m.mu.Lock()
	m.releaseCalls++
	m.mu.Unlock()

	if m.releaseRunnerFn != nil {
		return m.releaseRunnerFn(ctx, runnerID)
	}
	return 0, nil
}

func (m *mockStore) TerminateRunner(ctx context.Context, runnerID int64) (db.RunnerPool, error) {
	if m.terminateRunnerFn != nil {
		return m.terminateRunnerFn(ctx, runnerID)
	}
	return db.RunnerPool{}, nil
}

func (m *mockStore) RequeueTasksForRunner(ctx context.Context, runnerID pgtype.Int8) (int64, error) {
	if m.requeueTasksForRunner != nil {
		return m.requeueTasksForRunner(ctx, runnerID)
	}
	return 0, nil
}

func (m *mockStore) MarkWorkflowTaskRunning(ctx context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error) {
	if m.markTaskRunningFn != nil {
		return m.markTaskRunningFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockStore) MarkWorkflowTaskDone(ctx context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
	if m.markTaskDoneFn != nil {
		return m.markTaskDoneFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockStore) GetTerminalWorkflowTaskForRunner(ctx context.Context, arg db.GetTerminalWorkflowTaskForRunnerParams) (int64, error) {
	if m.getTerminalTaskFn != nil {
		return m.getTerminalTaskFn(ctx, arg)
	}
	return 0, pgx.ErrNoRows
}

func (m *mockStore) ClearTerminalWorkflowTaskRunnerOwnership(ctx context.Context, arg db.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error) {
	if m.clearTerminalTaskFn != nil {
		return m.clearTerminalTaskFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockStore) ListStaleRunners(ctx context.Context, cutoffAt pgtype.Timestamptz) ([]db.RunnerPool, error) {
	if m.listStaleRunnersFn != nil {
		return m.listStaleRunnersFn(ctx, cutoffAt)
	}
	return nil, nil
}

func (m *mockStore) GetWorkflowTaskStepID(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *mockStore) UpdateWorkflowStepStatusRunning(_ context.Context, _ int64) (int64, error) {
	return 0, nil
}

func (m *mockStore) UpdateWorkflowStepStatusTerminal(_ context.Context, _ db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
	return 0, nil
}

func (m *mockStore) ReleaseCallCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.releaseCalls
}
