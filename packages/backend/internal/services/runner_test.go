package services

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockRunnerQuerier struct {
	upsertRunnerFn                        func(ctx context.Context, arg db.UpsertRunnerParams) (db.RunnerPool, error)
	touchRunnerHeartbeatFn                func(ctx context.Context, id int64) (db.RunnerPool, error)
	claimIdleRunnerFn                     func(ctx context.Context, id int64) (db.RunnerPool, error)
	claimPendingTaskFn                    func(ctx context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error)
	markWorkflowTaskRunningFn             func(ctx context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error)
	markWorkflowTaskDoneFn                func(ctx context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error)
	releaseRunnerFn                       func(ctx context.Context, id int64) (int64, error)
	terminateRunnerFn                     func(ctx context.Context, id int64) (db.RunnerPool, error)
	requeueTasksForRunnerFn               func(ctx context.Context, runnerID pgtype.Int8) (int64, error)
	updateWorkflowRunStatusBasedOnTasksFn func(ctx context.Context, workflowRunID int64) (string, error)
	getWorkflowRunByRunIDFn               func(ctx context.Context, runID int64) (db.WorkflowRun, error)
	getWorkflowTaskByRunIDFn              func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error)
	getWorkflowTaskFn                     func(ctx context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error)
	getTerminalWorkflowTaskFn             func(ctx context.Context, arg db.GetTerminalWorkflowTaskForRunnerParams) (int64, error)
	clearTerminalTaskOwnershipFn          func(ctx context.Context, arg db.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error)
	getWorkflowTaskRuntimeContextFn       func(ctx context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error)
	insertWorkflowLogFn                   func(ctx context.Context, arg db.InsertWorkflowLogParams) (db.WorkflowLog, error)
	insertWorkflowLogNextSequenceFn       func(ctx context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error)
	notifyWorkflowLogFn                   func(ctx context.Context, arg db.NotifyWorkflowLogParams) error
	notifyWorkflowRunLogFn                func(ctx context.Context, arg db.NotifyWorkflowRunLogParams) error
	notifyWorkflowRunEventFn              func(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	listBlockedTasksFn                    func(ctx context.Context, workflowRunID int64) ([]db.ListBlockedTasksForRunRow, error)
	listTaskStepInfoFn                    func(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error)
	unblockTaskFn                         func(ctx context.Context, id int64) error
	skipBlockedTaskFn                     func(ctx context.Context, id int64) error
	getWorkflowTaskStepIDFn               func(ctx context.Context, id int64) (int64, error)
	updateWorkflowStepStatusRunningFn     func(ctx context.Context, stepID int64) (int64, error)
	updateWorkflowStepStatusTerminalFn    func(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
	updateAgentSessionTerminalStatusFn    func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error)
	notifyAgentSessionFn                  func(ctx context.Context, arg db.NotifyAgentSessionParams) error
	getWorkflowDefinitionNameByRunIDFn    func(ctx context.Context, workflowRunID int64) (string, error)
	listWorkflowLogsSinceFn               func(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error)
	getRepoByIDFn                         func(ctx context.Context, id int64) (db.Repository, error)
	getUserByIDFn                         func(ctx context.Context, id int64) (db.User, error)
	getOrgByIDFn                          func(ctx context.Context, id int64) (db.Organization, error)

	// workflowRunCredentialRevoker methods: only present so tests can opt into
	// asserting on revokeWorkflowRunCredentials' duck-typed call. Left unset in
	// most tests, in which case the type assertion in revokeWorkflowRunCredentials
	// still succeeds (the methods below are always defined on this mock type),
	// but calls simply record into the slices below.
	updateWorkflowRunAgentTokenCalls  []db.UpdateWorkflowRunAgentTokenParams
	getWorkflowRunJJHubTokenIDFn      func(ctx context.Context, id int64) (pgtype.Int8, error)
	clearWorkflowRunJJHubTokenIDCalls []int64
	deleteAccessTokenCalls            []db.DeleteAccessTokenParams
}

func (m *mockRunnerQuerier) UpsertRunner(ctx context.Context, arg db.UpsertRunnerParams) (db.RunnerPool, error) {
	if m.upsertRunnerFn != nil {
		return m.upsertRunnerFn(ctx, arg)
	}
	return db.RunnerPool{}, nil
}

func (m *mockRunnerQuerier) TouchRunnerHeartbeat(ctx context.Context, id int64) (db.RunnerPool, error) {
	if m.touchRunnerHeartbeatFn != nil {
		return m.touchRunnerHeartbeatFn(ctx, id)
	}
	return db.RunnerPool{}, nil
}

func (m *mockRunnerQuerier) ClaimIdleRunner(ctx context.Context, id int64) (db.RunnerPool, error) {
	if m.claimIdleRunnerFn != nil {
		return m.claimIdleRunnerFn(ctx, id)
	}
	return db.RunnerPool{}, nil
}

func (m *mockRunnerQuerier) ClaimPendingTask(ctx context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
	if m.claimPendingTaskFn != nil {
		return m.claimPendingTaskFn(ctx, runnerID)
	}
	return db.WorkflowTask{}, nil
}

func (m *mockRunnerQuerier) MarkWorkflowTaskRunning(ctx context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error) {
	if m.markWorkflowTaskRunningFn != nil {
		return m.markWorkflowTaskRunningFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockRunnerQuerier) MarkWorkflowTaskDone(ctx context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
	if m.markWorkflowTaskDoneFn != nil {
		return m.markWorkflowTaskDoneFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockRunnerQuerier) ReleaseRunner(ctx context.Context, id int64) (int64, error) {
	if m.releaseRunnerFn != nil {
		return m.releaseRunnerFn(ctx, id)
	}
	return 0, nil
}

func (m *mockRunnerQuerier) TerminateRunner(ctx context.Context, id int64) (db.RunnerPool, error) {
	if m.terminateRunnerFn != nil {
		return m.terminateRunnerFn(ctx, id)
	}
	return db.RunnerPool{}, nil
}

func (m *mockRunnerQuerier) RequeueTasksForRunner(ctx context.Context, runnerID pgtype.Int8) (int64, error) {
	if m.requeueTasksForRunnerFn != nil {
		return m.requeueTasksForRunnerFn(ctx, runnerID)
	}
	return 0, nil
}

func (m *mockRunnerQuerier) UpdateWorkflowRunStatusBasedOnTasks(ctx context.Context, workflowRunID int64) (string, error) {
	if m.updateWorkflowRunStatusBasedOnTasksFn != nil {
		return m.updateWorkflowRunStatusBasedOnTasksFn(ctx, workflowRunID)
	}
	return "", nil
}

func (m *mockRunnerQuerier) GetWorkflowRunByRunID(ctx context.Context, runID int64) (db.WorkflowRun, error) {
	if m.getWorkflowRunByRunIDFn != nil {
		return m.getWorkflowRunByRunIDFn(ctx, runID)
	}
	return db.WorkflowRun{}, nil
}

func (m *mockRunnerQuerier) GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
	if m.getWorkflowTaskByRunIDFn != nil {
		return m.getWorkflowTaskByRunIDFn(ctx, workflowRunID)
	}
	return db.WorkflowTask{}, pgx.ErrNoRows
}

func (m *mockRunnerQuerier) GetWorkflowTaskForRunner(ctx context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
	if m.getWorkflowTaskFn != nil {
		return m.getWorkflowTaskFn(ctx, taskID)
	}
	return db.GetWorkflowTaskForRunnerRow{}, nil
}

func (m *mockRunnerQuerier) GetTerminalWorkflowTaskForRunner(ctx context.Context, arg db.GetTerminalWorkflowTaskForRunnerParams) (int64, error) {
	if m.getTerminalWorkflowTaskFn != nil {
		return m.getTerminalWorkflowTaskFn(ctx, arg)
	}
	return 0, pgx.ErrNoRows
}

func (m *mockRunnerQuerier) ClearTerminalWorkflowTaskRunnerOwnership(ctx context.Context, arg db.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error) {
	if m.clearTerminalTaskOwnershipFn != nil {
		return m.clearTerminalTaskOwnershipFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockRunnerQuerier) GetWorkflowTaskRuntimeContext(ctx context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
	if m.getWorkflowTaskRuntimeContextFn != nil {
		return m.getWorkflowTaskRuntimeContextFn(ctx, arg)
	}
	return db.GetWorkflowTaskRuntimeContextRow{}, nil
}

func (m *mockRunnerQuerier) InsertWorkflowLog(ctx context.Context, arg db.InsertWorkflowLogParams) (db.WorkflowLog, error) {
	if m.insertWorkflowLogFn != nil {
		return m.insertWorkflowLogFn(ctx, arg)
	}
	return db.WorkflowLog{}, nil
}

func (m *mockRunnerQuerier) InsertWorkflowLogNextSequence(ctx context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
	if m.insertWorkflowLogNextSequenceFn != nil {
		return m.insertWorkflowLogNextSequenceFn(ctx, arg)
	}
	return db.InsertWorkflowLogNextSequenceRow{}, nil
}

func (m *mockRunnerQuerier) NotifyWorkflowLog(ctx context.Context, arg db.NotifyWorkflowLogParams) error {
	if m.notifyWorkflowLogFn != nil {
		return m.notifyWorkflowLogFn(ctx, arg)
	}
	return nil
}

func (m *mockRunnerQuerier) NotifyWorkflowRunLog(ctx context.Context, arg db.NotifyWorkflowRunLogParams) error {
	if m.notifyWorkflowRunLogFn != nil {
		return m.notifyWorkflowRunLogFn(ctx, arg)
	}
	return nil
}

func (m *mockRunnerQuerier) NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error {
	if m.notifyWorkflowRunEventFn != nil {
		return m.notifyWorkflowRunEventFn(ctx, arg)
	}
	return nil
}

func (m *mockRunnerQuerier) ListBlockedTasksForRun(ctx context.Context, workflowRunID int64) ([]db.ListBlockedTasksForRunRow, error) {
	if m.listBlockedTasksFn != nil {
		return m.listBlockedTasksFn(ctx, workflowRunID)
	}
	return nil, nil
}

func (m *mockRunnerQuerier) ListTaskStepInfoForRun(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error) {
	if m.listTaskStepInfoFn != nil {
		return m.listTaskStepInfoFn(ctx, workflowRunID)
	}
	return nil, nil
}

func (m *mockRunnerQuerier) UnblockWorkflowTask(ctx context.Context, id int64) error {
	if m.unblockTaskFn != nil {
		return m.unblockTaskFn(ctx, id)
	}
	return nil
}

func (m *mockRunnerQuerier) SkipBlockedWorkflowTask(ctx context.Context, id int64) error {
	if m.skipBlockedTaskFn != nil {
		return m.skipBlockedTaskFn(ctx, id)
	}
	return nil
}

func (m *mockRunnerQuerier) GetWorkflowTaskStepID(ctx context.Context, id int64) (int64, error) {
	if m.getWorkflowTaskStepIDFn != nil {
		return m.getWorkflowTaskStepIDFn(ctx, id)
	}
	return 0, nil
}

func (m *mockRunnerQuerier) UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error) {
	if m.updateWorkflowStepStatusRunningFn != nil {
		return m.updateWorkflowStepStatusRunningFn(ctx, stepID)
	}
	return 0, nil
}

func (m *mockRunnerQuerier) UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
	if m.updateWorkflowStepStatusTerminalFn != nil {
		return m.updateWorkflowStepStatusTerminalFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockRunnerQuerier) UpdateAgentSessionTerminalStatus(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
	if m.updateAgentSessionTerminalStatusFn != nil {
		return m.updateAgentSessionTerminalStatusFn(ctx, arg)
	}
	return db.AgentSession{}, pgx.ErrNoRows
}

func (m *mockRunnerQuerier) NotifyAgentSession(ctx context.Context, arg db.NotifyAgentSessionParams) error {
	if m.notifyAgentSessionFn != nil {
		return m.notifyAgentSessionFn(ctx, arg)
	}
	return nil
}

func (m *mockRunnerQuerier) GetWorkflowDefinitionNameByRunID(ctx context.Context, workflowRunID int64) (string, error) {
	if m.getWorkflowDefinitionNameByRunIDFn != nil {
		return m.getWorkflowDefinitionNameByRunIDFn(ctx, workflowRunID)
	}
	return "", pgx.ErrNoRows
}

func (m *mockRunnerQuerier) ListWorkflowLogsSince(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
	if m.listWorkflowLogsSinceFn != nil {
		return m.listWorkflowLogsSinceFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockRunnerQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockRunnerQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{}, pgx.ErrNoRows
}

func (m *mockRunnerQuerier) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	if m.getOrgByIDFn != nil {
		return m.getOrgByIDFn(ctx, id)
	}
	return db.Organization{}, pgx.ErrNoRows
}

func (m *mockRunnerQuerier) UpdateWorkflowRunAgentToken(_ context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
	m.updateWorkflowRunAgentTokenCalls = append(m.updateWorkflowRunAgentTokenCalls, arg)
	return db.WorkflowRun{ID: arg.ID}, nil
}

func (m *mockRunnerQuerier) GetWorkflowRunJJHubTokenID(ctx context.Context, id int64) (pgtype.Int8, error) {
	if m.getWorkflowRunJJHubTokenIDFn != nil {
		return m.getWorkflowRunJJHubTokenIDFn(ctx, id)
	}
	return pgtype.Int8{}, nil
}

func (m *mockRunnerQuerier) ClearWorkflowRunJJHubTokenID(_ context.Context, id int64) error {
	m.clearWorkflowRunJJHubTokenIDCalls = append(m.clearWorkflowRunJJHubTokenIDCalls, id)
	return nil
}

func (m *mockRunnerQuerier) DeleteAccessToken(_ context.Context, arg db.DeleteAccessTokenParams) error {
	m.deleteAccessTokenCalls = append(m.deleteAccessTokenCalls, arg)
	return nil
}

type mockRunnerInstallationResolver struct {
	resolveFn func(ctx context.Context, ownerUserID, ownerOrgID int64, owner, repo string) (int64, error)
}

func (m *mockRunnerInstallationResolver) GetGitHubInstallationIDForRepositoryOwner(ctx context.Context, ownerUserID int64, ownerOrgID int64, owner string, repo string) (int64, error) {
	if m.resolveFn != nil {
		return m.resolveFn(ctx, ownerUserID, ownerOrgID, owner, repo)
	}
	return 0, pgx.ErrNoRows
}

func runnerAPIStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	return apiErr.Status
}

type mockRunnerDispatcher struct {
	calls []struct {
		repoID    int64
		eventType string
		payload   any
	}
	dispatchErr error
}

func (m *mockRunnerDispatcher) DispatchEvent(_ context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, struct {
		repoID    int64
		eventType string
		payload   any
	}{
		repoID:    repoID,
		eventType: string(eventType),
		payload:   payload,
	})
	return m.dispatchErr
}

func (m *mockRunnerDispatcher) DispatchOrgEvent(_ context.Context, _ int64, _ webhooks.EventType, _ any) error {
	return nil
}

type mockRunnerCommitStatusWriter struct {
	updateFn    func(ctx context.Context, workflowRunID int64, status string, description string, targetURL string) (db.CommitStatus, error)
	updateCalls []struct {
		workflowRunID int64
		status        string
		description   string
		targetURL     string
	}
}

func (m *mockRunnerCommitStatusWriter) UpdateCommitStatusForWorkflowRun(ctx context.Context, workflowRunID int64, status string, description string, targetURL string) (db.CommitStatus, error) {
	m.updateCalls = append(m.updateCalls, struct {
		workflowRunID int64
		status        string
		description   string
		targetURL     string
	}{
		workflowRunID: workflowRunID,
		status:        status,
		description:   description,
		targetURL:     targetURL,
	})
	if m.updateFn != nil {
		return m.updateFn(ctx, workflowRunID, status, description, targetURL)
	}
	return db.CommitStatus{}, nil
}

type mockRunnerCheckRunService struct {
	updateFn func(
		ctx context.Context,
		installationID int64,
		owner string,
		repo string,
		checkRunID int64,
		update GitHubCheckRunUpdate,
	) (GitHubCheckRunResult, error)

	updateCalls []struct {
		installationID int64
		owner          string
		repo           string
		checkRunID     int64
		update         GitHubCheckRunUpdate
	}
}

func (m *mockRunnerCheckRunService) PostCheckRun(
	ctx context.Context,
	installationID int64,
	owner string,
	repo string,
	input GitHubCheckRunInput,
) (GitHubCheckRunResult, error) {
	return GitHubCheckRunResult{}, nil
}

func (m *mockRunnerCheckRunService) UpdateCheckRun(
	ctx context.Context,
	installationID int64,
	owner string,
	repo string,
	checkRunID int64,
	update GitHubCheckRunUpdate,
) (GitHubCheckRunResult, error) {
	m.updateCalls = append(m.updateCalls, struct {
		installationID int64
		owner          string
		repo           string
		checkRunID     int64
		update         GitHubCheckRunUpdate
	}{
		installationID: installationID,
		owner:          owner,
		repo:           repo,
		checkRunID:     checkRunID,
		update:         update,
	})
	if m.updateFn != nil {
		return m.updateFn(ctx, installationID, owner, repo, checkRunID, update)
	}
	return GitHubCheckRunResult{ID: checkRunID}, nil
}

type mockRunnerWorkflowDispatcher struct {
	dispatchFn func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	calls      []DispatchForEventInput
}

func (m *mockRunnerWorkflowDispatcher) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	m.calls = append(m.calls, input)
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, input)
	}
	return nil, nil
}

func TestRunnerService_Register_ValidatesName(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{})
	_, err := svc.Register(context.Background(), RunnerRegisterInput{Name: "   "})
	assert.Equal(t, 422, runnerAPIStatus(t, err))
}

func TestRunnerService_Register_UpsertsRunner(t *testing.T) {
	t.Parallel()

	var captured db.UpsertRunnerParams
	svc := NewRunnerService(&mockRunnerQuerier{
		upsertRunnerFn: func(_ context.Context, arg db.UpsertRunnerParams) (db.RunnerPool, error) {
			captured = arg
			return db.RunnerPool{ID: 42, Name: arg.Name, Metadata: arg.Metadata}, nil
		},
	})

	metadata := json.RawMessage(`{"region":"us-east-1"}`)
	got, err := svc.Register(context.Background(), RunnerRegisterInput{
		Name:     "runner-1",
		Metadata: metadata,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(42), got.RunnerID)
	assert.Equal(t, "runner-1", captured.Name)
	assert.JSONEq(t, `{"region":"us-east-1"}`, string(captured.Metadata))
}

func TestRunnerService_Register_UpsertError(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		upsertRunnerFn: func(_ context.Context, _ db.UpsertRunnerParams) (db.RunnerPool, error) {
			return db.RunnerPool{}, errors.New("db unavailable")
		},
	})

	_, err := svc.Register(context.Background(), RunnerRegisterInput{Name: "runner-1"})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunnerService_Register_NilQuerier_ReturnsStoreUnavailable(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(nil)
	_, err := svc.Register(context.Background(), RunnerRegisterInput{Name: "runner-1"})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunnerService_ClaimTask_ValidatesRunnerID(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{})
	_, err := svc.ClaimTask(context.Background(), 0)
	assert.Equal(t, 400, runnerAPIStatus(t, err))
}

func TestRunnerService_ClaimTask_ClaimsAndMarksRunning(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		claimIdleRunnerFn: func(_ context.Context, id int64) (db.RunnerPool, error) {
			assert.Equal(t, int64(7), id)
			return db.RunnerPool{ID: id}, nil
		},
		claimPendingTaskFn: func(_ context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
			assert.Equal(t, pgtype.Int8{Int64: 7, Valid: true}, runnerID)
			return db.WorkflowTask{
				ID:             42,
				WorkflowRunID:  99,
				RepositoryID:   123,
				WorkflowStepID: 321,
				Attempt:        3,
				Payload:        []byte(`{"job":"build"}`),
			}, nil
		},
		markWorkflowTaskRunningFn: func(_ context.Context, arg db.MarkWorkflowTaskRunningParams) (int64, error) {
			assert.Equal(t, int64(42), arg.ID)
			assert.Equal(t, pgtype.Int8{Int64: 7, Valid: true}, arg.RunnerID)
			return 1, nil
		},
		getWorkflowTaskStepIDFn: func(_ context.Context, id int64) (int64, error) {
			assert.Equal(t, int64(42), id)
			return 321, nil
		},
		updateWorkflowStepStatusRunningFn: func(_ context.Context, stepID int64) (int64, error) {
			assert.Equal(t, int64(321), stepID)
			return 1, nil
		},
	})

	task, err := svc.ClaimTask(context.Background(), 7)
	require.NoError(t, err)
	require.NotNil(t, task)
	assert.Equal(t, int64(42), task.ID)
	assert.Equal(t, int64(123), task.RepositoryID)
	assert.Equal(t, int64(321), task.WorkflowStepID)
	assert.Equal(t, int32(3), task.Attempt)
}

func TestRunnerService_ClaimTask_ReleasesRunnerWhenNoTaskExists(t *testing.T) {
	t.Parallel()

	released := false
	svc := NewRunnerService(&mockRunnerQuerier{
		claimIdleRunnerFn: func(_ context.Context, id int64) (db.RunnerPool, error) {
			return db.RunnerPool{ID: id}, nil
		},
		claimPendingTaskFn: func(_ context.Context, runnerID pgtype.Int8) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, pgx.ErrNoRows
		},
		releaseRunnerFn: func(_ context.Context, id int64) (int64, error) {
			released = true
			assert.Equal(t, int64(7), id)
			return 1, nil
		},
	})

	task, err := svc.ClaimTask(context.Background(), 7)
	require.NoError(t, err)
	assert.Nil(t, task)
	assert.True(t, released)
}

func TestRunnerService_Heartbeat_TouchesRunner(t *testing.T) {
	t.Parallel()

	called := false
	svc := NewRunnerService(&mockRunnerQuerier{
		touchRunnerHeartbeatFn: func(_ context.Context, id int64) (db.RunnerPool, error) {
			called = true
			assert.Equal(t, int64(9), id)
			return db.RunnerPool{ID: id}, nil
		},
	})

	require.NoError(t, svc.Heartbeat(context.Background(), 9))
	assert.True(t, called)
}

func TestRunnerService_Heartbeat_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		touchRunnerHeartbeatFn: func(_ context.Context, id int64) (db.RunnerPool, error) {
			return db.RunnerPool{}, pgx.ErrNoRows
		},
	})

	err := svc.Heartbeat(context.Background(), 9)
	assert.Equal(t, 404, runnerAPIStatus(t, err))
}

func TestRunnerService_Terminate_RequeuesAssignedTasks(t *testing.T) {
	t.Parallel()

	terminated := false
	requeued := false
	svc := NewRunnerService(&mockRunnerQuerier{
		terminateRunnerFn: func(_ context.Context, id int64) (db.RunnerPool, error) {
			terminated = true
			assert.Equal(t, int64(5), id)
			return db.RunnerPool{ID: id}, nil
		},
		requeueTasksForRunnerFn: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			requeued = true
			assert.Equal(t, pgtype.Int8{Int64: 5, Valid: true}, runnerID)
			return 2, nil
		},
	})

	require.NoError(t, svc.Terminate(context.Background(), 5))
	assert.True(t, terminated)
	assert.True(t, requeued)
}

// Issue #129: requeue must happen before the runner is marked terminated so a
// requeue failure never leaves tasks stranded on an already-terminated runner.
func TestRunnerService_Terminate_RequeueBeforeTerminate(t *testing.T) {
	t.Parallel()

	var callOrder []string
	svc := NewRunnerService(&mockRunnerQuerier{
		terminateRunnerFn: func(_ context.Context, id int64) (db.RunnerPool, error) {
			callOrder = append(callOrder, "terminate")
			return db.RunnerPool{ID: id}, nil
		},
		requeueTasksForRunnerFn: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			callOrder = append(callOrder, "requeue")
			return 2, nil
		},
	})

	require.NoError(t, svc.Terminate(context.Background(), 5))
	assert.Equal(t, []string{"requeue", "terminate"}, callOrder)
}

func TestRunnerService_Terminate_RequeueFailure_DoesNotTerminate(t *testing.T) {
	t.Parallel()

	terminated := false
	svc := NewRunnerService(&mockRunnerQuerier{
		terminateRunnerFn: func(_ context.Context, id int64) (db.RunnerPool, error) {
			terminated = true
			return db.RunnerPool{ID: id}, nil
		},
		requeueTasksForRunnerFn: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			return 0, errors.New("db unavailable")
		},
	})

	err := svc.Terminate(context.Background(), 5)
	require.Error(t, err)
	assert.False(t, terminated, "TerminateRunner must not be called when requeue fails")
}

func TestRunnerService_GetTaskRuntimeEnvironment_ReturnsRepoSecretsAndAgentToken(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
			assert.Equal(t, int64(55), arg.TaskID)
			assert.Equal(t, int64(12), arg.WorkflowRunID)
			return db.GetWorkflowTaskRuntimeContextRow{
				ID:            55,
				WorkflowRunID: 12,
				RepositoryID:  101,
				Status:        "assigned",
			}, nil
		},
	}, WithRunnerSecretInjector(NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
			assert.Equal(t, int64(101), repositoryID)
			return []db.ListSecretValuesRow{
				{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte("smithers_secret_token")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})))

	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12, RepositoryID: 101})
	ctx = middleware.ContextWithAgentToken(ctx, "smithers_agent_0123456789abcdef0123456789abcdef01234567")

	env, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
	require.NoError(t, err)
	assert.Equal(t, "smithers_secret_token", env["ANTHROPIC_AUTH_TOKEN"])
	assert.Equal(t, "smithers_agent_0123456789abcdef0123456789abcdef01234567", env["SMITHERS_AGENT_TOKEN"])
	assert.Equal(t, "ANTHROPIC_AUTH_TOKEN,SMITHERS_AGENT_TOKEN", env["SMITHERS_SECRET_ENV_KEYS"])
}

// The runner redacts pod-log output using the env keys listed in
// SMITHERS_SECRET_ENV_KEYS; only secrets (and the agent token) may be listed,
// never plain variables — masking variables would destroy log debugging value.
func TestRunnerService_GetTaskRuntimeEnvironment_SecretKeysExcludeVariables(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
			return db.GetWorkflowTaskRuntimeContextRow{
				ID:            55,
				WorkflowRunID: 12,
				RepositoryID:  101,
				Status:        "assigned",
			}, nil
		},
	}, WithRunnerSecretInjector(NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, _ int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "ZED_KEY", ValueEncrypted: []byte("zed-value")},
				{Name: "API_KEY", ValueEncrypted: []byte("api-value")},
			}, nil
		},
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: "PLAIN_VAR", Value: "plain"}}, nil
		},
	}, webhook.NoopSecretCodec{})))

	t.Run("without agent token", func(t *testing.T) {
		ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12, RepositoryID: 101})
		env, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
		require.NoError(t, err)
		assert.Equal(t, "plain", env["PLAIN_VAR"])
		assert.Equal(t, "API_KEY,ZED_KEY", env["SMITHERS_SECRET_ENV_KEYS"])
	})

	t.Run("with agent token appended and keys sorted", func(t *testing.T) {
		ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12, RepositoryID: 101})
		ctx = middleware.ContextWithAgentToken(ctx, "smithers_agent_token")
		env, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
		require.NoError(t, err)
		assert.Equal(t, "API_KEY,SMITHERS_AGENT_TOKEN,ZED_KEY", env["SMITHERS_SECRET_ENV_KEYS"])
	})
}

// No secrets and no agent token: the marker must be absent rather than empty
// so execute-step.ts sees no redaction keys instead of a stray empty entry.
func TestRunnerService_GetTaskRuntimeEnvironment_NoSecretsOmitsMarker(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
			return db.GetWorkflowTaskRuntimeContextRow{
				ID:            55,
				WorkflowRunID: 12,
				RepositoryID:  101,
				Status:        "assigned",
			}, nil
		},
	}, WithRunnerSecretInjector(NewSecretInjector(&mockSecretInjectionQuerier{}, webhook.NoopSecretCodec{})))

	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12, RepositoryID: 101})
	env, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
	require.NoError(t, err)
	_, present := env["SMITHERS_SECRET_ENV_KEYS"]
	assert.False(t, present)
}

func TestRunnerService_GetTaskRuntimeEnvironment_UsesOneSecretSnapshotForInjectionAndMarker(t *testing.T) {
	t.Parallel()

	secretLoads := 0
	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
			return db.GetWorkflowTaskRuntimeContextRow{
				ID: arg.TaskID, WorkflowRunID: arg.WorkflowRunID, RepositoryID: 101,
				Status: "running", Payload: json.RawMessage(`{"job":"legacy"}`),
			}, nil
		},
	}, WithRunnerSecretInjector(NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			secretLoads++
			if secretLoads == 1 {
				return []db.ListSecretValuesRow{{Name: "OLD_TOKEN", ValueEncrypted: []byte("old-value")}}, nil
			}
			return []db.ListSecretValuesRow{{Name: "NEW_TOKEN", ValueEncrypted: []byte("new-value")}}, nil
		},
	}, webhook.NoopSecretCodec{})))

	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12, RepositoryID: 101})
	env, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
	require.NoError(t, err)
	assert.Equal(t, 1, secretLoads)
	assert.Equal(t, "old-value", env["OLD_TOKEN"])
	assert.Equal(t, "OLD_TOKEN", env["SMITHERS_SECRET_ENV_KEYS"])
	assert.NotContains(t, env, "NEW_TOKEN")
}

func TestRunnerService_GetTaskRuntimeEnvironment_EnforcesPerTaskSecretPolicy(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name        string
		payload     string
		wantKeys    []string
		wantMarker  string
		wantLookups int
		wantStatus  int
	}{
		{
			name:        "explicit provider allowlist",
			payload:     `{"secret_names":["ANTHROPIC_API_KEY"]}`,
			wantKeys:    []string{"ANTHROPIC_API_KEY", "SMITHERS_AGENT_TOKEN", "SMITHERS_SECRET_ENV_KEYS"},
			wantMarker:  "ANTHROPIC_API_KEY,SMITHERS_AGENT_TOKEN",
			wantLookups: 2,
		},
		{
			name:        "explicit empty policy loads no repository environment",
			payload:     `{"secret_names":[]}`,
			wantKeys:    []string{"SMITHERS_AGENT_TOKEN", "SMITHERS_SECRET_ENV_KEYS"},
			wantMarker:  "SMITHERS_AGENT_TOKEN",
			wantLookups: 0,
		},
		{
			name:        "legacy omitted policy preserves compatibility",
			payload:     `{"job":"legacy"}`,
			wantKeys:    []string{"ANTHROPIC_API_KEY", "GITHUB_TOKEN", "PLAIN_VAR", "SMITHERS_AGENT_TOKEN", "SMITHERS_SECRET_ENV_KEYS"},
			wantMarker:  "ANTHROPIC_API_KEY,GITHUB_TOKEN,SMITHERS_AGENT_TOKEN",
			wantLookups: 2,
		},
		{
			name:       "malformed policy fails closed",
			payload:    `{"secret_names":[""]}`,
			wantStatus: 500,
		},
	} {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			lookups := 0
			svc := NewRunnerService(&mockRunnerQuerier{
				getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
					return db.GetWorkflowTaskRuntimeContextRow{
						ID: 55, WorkflowRunID: arg.WorkflowRunID, RepositoryID: 101,
						Status: "running", Payload: json.RawMessage(tc.payload),
					}, nil
				},
			}, WithRunnerSecretInjector(NewSecretInjector(&mockSecretInjectionQuerier{
				listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
					lookups++
					return []db.ListSecretValuesRow{
						{Name: "ANTHROPIC_API_KEY", ValueEncrypted: []byte("anthropic")},
						{Name: "GITHUB_TOKEN", ValueEncrypted: []byte("github")},
					}, nil
				},
				listVariablesFn: func(context.Context, int64) ([]db.RepositoryVariable, error) {
					lookups++
					return []db.RepositoryVariable{{Name: "PLAIN_VAR", Value: "plain"}}, nil
				},
			}, webhook.NoopSecretCodec{})))

			ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12, RepositoryID: 101})
			ctx = middleware.ContextWithAgentToken(ctx, "task-callback-token")
			env, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
			if tc.wantStatus != 0 {
				require.Error(t, err)
				assert.Equal(t, tc.wantStatus, runnerAPIStatus(t, err))
				assert.Zero(t, lookups)
				return
			}
			require.NoError(t, err)
			keys := make([]string, 0, len(env))
			for key := range env {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			assert.Equal(t, tc.wantKeys, keys)
			assert.Equal(t, tc.wantMarker, env["SMITHERS_SECRET_ENV_KEYS"])
			assert.Equal(t, tc.wantLookups, lookups)
		})
	}
}

// TestRunnerService_GetTaskRuntimeEnvironment_CrossRunCallback verifies that a
// runner authenticated for run A cannot retrieve the environment for a task
// belonging to run B. The DB query is scoped to (task_id, workflow_run_id) so
// a cross-run request returns not-found rather than leaking task data.
func TestRunnerService_GetTaskRuntimeEnvironment_CrossRunCallback(t *testing.T) {
	t.Parallel()

	t.Run("rejects task from different run via db scope", func(t *testing.T) {
		t.Parallel()

		svc := NewRunnerService(&mockRunnerQuerier{
			getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
				// Confirm the DB query is scoped to the run bound by the agent token.
				assert.Equal(t, int64(77), arg.TaskID)
				assert.Equal(t, int64(100), arg.WorkflowRunID)
				// Simulate: task 77 belongs to run 200, not run 100 — DB returns no rows.
				return db.GetWorkflowTaskRuntimeContextRow{}, pgx.ErrNoRows
			},
		})

		// Agent token is scoped to run 100, but the task belongs to run 200.
		ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 100})

		_, err := svc.GetTaskRuntimeEnvironment(ctx, 77)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		// Returns 404 (not 403) to avoid leaking whether the task ID exists for another run.
		assert.Equal(t, 404, apiErr.Status)
	})

	t.Run("allows task from same run", func(t *testing.T) {
		t.Parallel()

		svc := NewRunnerService(&mockRunnerQuerier{
			getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
				assert.Equal(t, int64(77), arg.TaskID)
				assert.Equal(t, int64(100), arg.WorkflowRunID)
				return db.GetWorkflowTaskRuntimeContextRow{
					ID:            77,
					WorkflowRunID: 100,
					RepositoryID:  10,
					Status:        "assigned",
				}, nil
			},
		})

		// Agent token scoped to run 100; task also belongs to run 100.
		ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 100})

		env, err := svc.GetTaskRuntimeEnvironment(ctx, 77)
		require.NoError(t, err)
		assert.NotNil(t, env)
	})
}

func TestRunnerService_CompleteTask_NilQuerier_ReturnsStoreUnavailable(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(nil)
	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   10,
		RunnerID: 20,
		Status:   "done",
	})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunnerService_CompleteTask_UpdatesWorkflowRunStatus(t *testing.T) {
	t.Parallel()

	markCalls := 0
	releaseCalls := 0
	updateCalls := 0

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			markCalls++
			assert.Equal(t, int64(91), arg.ID)
			assert.Equal(t, pgtype.Int8{Int64: 17, Valid: true}, arg.RunnerID)
			assert.Equal(t, "done", arg.Status)
			assert.Equal(t, pgtype.Text{}, arg.LastError)
			return 501, nil
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			releaseCalls++
			assert.Equal(t, int64(17), runnerID)
			return 1, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, workflowRunID int64) (string, error) {
			updateCalls++
			assert.Equal(t, int64(501), workflowRunID)
			return "success", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   91,
		RunnerID: 17,
		Status:   "done",
	})
	require.NoError(t, err)
	assert.Equal(t, 1, markCalls)
	assert.Equal(t, 1, releaseCalls)
	assert.Equal(t, 1, updateCalls)
}

func TestRunnerService_CompleteTask_TerminalStatusRevokesCredentials(t *testing.T) {
	t.Parallel()

	q := &mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 501, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, workflowRunID int64) (string, error) {
			return "success", nil
		},
		getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: runID, RepositoryID: 55, Status: "success"}, nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
		getWorkflowRunJJHubTokenIDFn: func(_ context.Context, _ int64) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: 321, Valid: true}, nil
		},
	}

	svc := NewRunnerService(q)
	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   91,
		RunnerID: 17,
		Status:   "done",
	})
	require.NoError(t, err)

	require.Len(t, q.updateWorkflowRunAgentTokenCalls, 1)
	assert.False(t, q.updateWorkflowRunAgentTokenCalls[0].AgentTokenHash.Valid)
	require.Len(t, q.deleteAccessTokenCalls, 1)
	assert.Equal(t, int64(321), q.deleteAccessTokenCalls[0].ID)
	assert.Equal(t, int64(7), q.deleteAccessTokenCalls[0].UserID)
	require.Len(t, q.clearWorkflowRunJJHubTokenIDCalls, 1)
}

func TestRunnerService_CompleteTask_NonTerminalStatusDoesNotRevokeCredentials(t *testing.T) {
	t.Parallel()

	q := &mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 501, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, workflowRunID int64) (string, error) {
			return "running", nil
		},
		getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: runID, RepositoryID: 55, Status: "running"}, nil
		},
	}

	svc := NewRunnerService(q)
	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   91,
		RunnerID: 17,
		Status:   "done",
	})
	require.NoError(t, err)

	assert.Empty(t, q.updateWorkflowRunAgentTokenCalls)
	assert.Empty(t, q.deleteAccessTokenCalls)
	assert.Empty(t, q.clearWorkflowRunJJHubTokenIDCalls)
}

func TestRunnerService_CompleteTask_AgentTaskFailureTransitionsSessionStatus(t *testing.T) {
	t.Parallel()

	var gotSessionStatus db.UpdateAgentSessionTerminalStatusParams
	var gotNotify db.NotifyAgentSessionParams
	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			assert.Equal(t, "failed", arg.Status)
			return 501, nil
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			assert.Equal(t, int64(17), runnerID)
			return 1, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, workflowRunID int64) (string, error) {
			assert.Equal(t, int64(501), workflowRunID)
			return "failure", nil
		},
		getWorkflowTaskByRunIDFn: func(_ context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			assert.Equal(t, int64(501), workflowRunID)
			return db.WorkflowTask{
				ID:      91,
				Payload: json.RawMessage(`{"kind":"agent","session_id":"7dc95321-1516-45a9-939e-1cfb859b0525"}`),
			}, nil
		},
		updateAgentSessionTerminalStatusFn: func(_ context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			gotSessionStatus = arg
			return db.AgentSession{ID: arg.ID, Status: arg.Status}, nil
		},
		notifyAgentSessionFn: func(_ context.Context, arg db.NotifyAgentSessionParams) error {
			gotNotify = arg
			return nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   91,
		RunnerID: 17,
		Status:   "failed",
		Error:    "agent process exited",
	})
	require.NoError(t, err)
	assert.Equal(t, "7dc95321-1516-45a9-939e-1cfb859b0525", gotSessionStatus.ID)
	assert.Equal(t, "failed", gotSessionStatus.Status)
	assert.True(t, gotSessionStatus.FinishedAt.Valid)
	assert.Equal(t, "7dc95321151645a9939e1cfb859b0525", gotNotify.SessionID)
	assert.JSONEq(t, `{"session_id":"7dc95321-1516-45a9-939e-1cfb859b0525","action":"status","status":"failed"}`, gotNotify.Payload)
}

func TestRunnerService_CompleteTask_ReleaseRunnerError_ReturnsInternal(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 5002, nil
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			assert.Equal(t, int64(5), runnerID)
			return 0, errors.New("release failed")
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   9,
		RunnerID: 5,
		Status:   "done",
	})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunnerService_CompleteTask_UpdatesCommitStatusForTerminalRun(t *testing.T) {
	t.Parallel()

	statusWriter := &mockRunnerCommitStatusWriter{}
	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 501, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, workflowRunID int64) (string, error) {
			return "success", nil
		},
	}, WithRunnerCommitStatusWriter(statusWriter))

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   91,
		RunnerID: 17,
		Status:   "done",
	})
	require.NoError(t, err)
	require.Len(t, statusWriter.updateCalls, 1)
	assert.Equal(t, int64(501), statusWriter.updateCalls[0].workflowRunID)
	assert.Equal(t, "success", statusWriter.updateCalls[0].status)
	assert.Equal(t, "Workflow completed successfully", statusWriter.updateCalls[0].description)
}

func TestRunnerService_CompleteTask_UpdatesGitHubCheckRunForTerminalRun(t *testing.T) {
	t.Parallel()

	checkRunService := &mockRunnerCheckRunService{}
	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 501, nil
		},
		releaseRunnerFn: func(_ context.Context, id int64) (int64, error) {
			return 1, nil
		},
		getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           runID,
				RepositoryID: 77,
				Status:       "running",
				CheckRunID:   pgtype.Int8{Int64: 1234, Valid: true},
			}, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, workflowRunID int64) (string, error) {
			return "success", nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{
				ID:     id,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "acme"}, nil
		},
	}, WithRunnerGitHubCheckRunService(checkRunService), WithRunnerGitHubInstallationResolver(&mockRunnerInstallationResolver{
		resolveFn: func(_ context.Context, ownerUserID, ownerOrgID int64, owner, repo string) (int64, error) {
			assert.Equal(t, int64(7), ownerUserID)
			assert.Equal(t, int64(0), ownerOrgID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "demo", repo)
			return 99, nil
		},
	}))

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   91,
		RunnerID: 17,
		Status:   "done",
	})
	require.NoError(t, err)

	require.Len(t, checkRunService.updateCalls, 1)
	call := checkRunService.updateCalls[0]
	assert.Equal(t, int64(99), call.installationID)
	assert.Equal(t, "acme", call.owner)
	assert.Equal(t, "demo", call.repo)
	assert.Equal(t, int64(1234), call.checkRunID)
	assert.Equal(t, "completed", call.update.Status)
	assert.Equal(t, "success", call.update.Conclusion)
	require.NotNil(t, call.update.Output)
	assert.Contains(t, call.update.Output.Summary, "status `success`")
}

func TestRunnerService_CompleteTask_UpdatesGitHubCheckRunWithLogAnnotations(t *testing.T) {
	t.Parallel()

	checkRunService := &mockRunnerCheckRunService{}
	logPageCalls := 0
	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 501, nil
		},
		releaseRunnerFn: func(_ context.Context, id int64) (int64, error) {
			return 1, nil
		},
		getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           runID,
				RepositoryID: 77,
				Status:       "running",
				CheckRunID:   pgtype.Int8{Int64: 1234, Valid: true},
			}, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, workflowRunID int64) (string, error) {
			return "failure", nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{
				ID:     id,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "acme"}, nil
		},
		listWorkflowLogsSinceFn: func(_ context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
			logPageCalls++
			if logPageCalls == 1 {
				assert.Equal(t, int64(501), arg.RunID)
				assert.Equal(t, int64(0), arg.AfterID)
				return []db.WorkflowLog{
					{
						ID:    11,
						Entry: "::error file=src/auth.ts,line=42,endLine=42::Missing null check on user.email\n",
					},
					{
						ID:    12,
						Entry: "internal/services/runner.go:15: warning: use context cancellation\n",
					},
				}, nil
			}
			assert.Equal(t, int64(12), arg.AfterID)
			return nil, nil
		},
	}, WithRunnerGitHubCheckRunService(checkRunService), WithRunnerGitHubInstallationResolver(&mockRunnerInstallationResolver{
		resolveFn: func(_ context.Context, _, _ int64, owner, repo string) (int64, error) {
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "demo", repo)
			return 99, nil
		},
	}))

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   91,
		RunnerID: 17,
		Status:   "failed",
	})
	require.NoError(t, err)

	require.Len(t, checkRunService.updateCalls, 1)
	call := checkRunService.updateCalls[0]
	assert.Equal(t, int64(99), call.installationID)
	assert.Equal(t, "completed", call.update.Status)
	assert.Equal(t, "failure", call.update.Conclusion)
	require.NotNil(t, call.update.Output)
	require.Len(t, call.update.Output.Annotations, 2)
	assert.Contains(t, call.update.Output.Summary, "Detected 2 inline annotation(s)")

	annotationsByMessage := make(map[string]GitHubCheckRunAnnotation, len(call.update.Output.Annotations))
	for _, annotation := range call.update.Output.Annotations {
		annotationsByMessage[annotation.Message] = annotation
	}

	errorAnnotation, ok := annotationsByMessage["Missing null check on user.email"]
	require.True(t, ok)
	assert.Equal(t, "src/auth.ts", errorAnnotation.Path)
	assert.Equal(t, 42, errorAnnotation.StartLine)
	assert.Equal(t, 42, errorAnnotation.EndLine)
	assert.Equal(t, "failure", errorAnnotation.AnnotationLevel)

	warningAnnotation, ok := annotationsByMessage["use context cancellation"]
	require.True(t, ok)
	assert.Equal(t, "internal/services/runner.go", warningAnnotation.Path)
	assert.Equal(t, 15, warningAnnotation.StartLine)
	assert.Equal(t, 15, warningAnnotation.EndLine)
	assert.Equal(t, "warning", warningAnnotation.AnnotationLevel)
}

func TestRunnerService_CompleteTask_TaskNotClaimed_ReturnsConflict(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 0, pgx.ErrNoRows
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   7,
		RunnerID: 3,
		Status:   "failed",
		Error:    "boom",
	})
	assert.Equal(t, 409, runnerAPIStatus(t, err))
}

func TestRunnerService_CompleteTask_RejectsMatchingTaskScopedCredentialWithoutMutation(t *testing.T) {
	t.Parallel()

	var queried, completed, cleared, released bool
	queries := &mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
			queried = true
			return db.GetWorkflowTaskForRunnerRow{
				ID:            taskID,
				WorkflowRunID: 77,
				RepositoryID:  9,
				RunnerID:      pgtype.Int8{Int64: 5, Valid: true},
				Status:        "running",
			}, nil
		},
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			completed = true
			return 77, nil
		},
		clearTerminalTaskOwnershipFn: func(_ context.Context, _ db.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error) {
			cleared = true
			return 1, nil
		},
		releaseRunnerFn: func(_ context.Context, _ int64) (int64, error) {
			released = true
			return 1, nil
		},
	}
	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 77, RepositoryID: 9})
	ctx = middleware.ContextWithRunnerTaskToken(ctx, middleware.RunnerTaskTokenClaims{
		TaskID: 12, WorkflowRunID: 77, RepositoryID: 9, RunnerID: 5,
	})

	err := NewRunnerService(queries).CompleteTask(ctx, RunnerCompleteTaskInput{
		TaskID: 12, RunnerID: 5, Status: "done",
	})
	assert.Equal(t, 403, runnerAPIStatus(t, err))
	assert.False(t, queried, "untrusted task credentials must be rejected before loading mutable task state")
	assert.False(t, completed, "a child must not be able to forge its own successful exit")
	assert.False(t, cleared, "a child must not clear trusted runner ownership")
	assert.False(t, released, "a child must not make the runner reusable")
}

func TestRunnerService_CompleteTask_TrustedTerminalAcknowledgementReleasesRunner(t *testing.T) {
	t.Parallel()

	var cleared, released bool
	queries := &mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 0, pgx.ErrNoRows
		},
		getTerminalWorkflowTaskFn: func(_ context.Context, arg db.GetTerminalWorkflowTaskForRunnerParams) (int64, error) {
			assert.Equal(t, int64(12), arg.TaskID)
			assert.Equal(t, pgtype.Int8{Int64: 5, Valid: true}, arg.RunnerID)
			return 77, nil
		},
		clearTerminalTaskOwnershipFn: func(_ context.Context, arg db.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error) {
			assert.Equal(t, int64(12), arg.TaskID)
			assert.Equal(t, pgtype.Int8{Int64: 5, Valid: true}, arg.RunnerID)
			cleared = true
			return 1, nil
		},
		releaseRunnerFn: func(_ context.Context, runnerID int64) (int64, error) {
			assert.Equal(t, int64(5), runnerID)
			released = true
			return 1, nil
		},
	}
	ctx := middleware.ContextWithSharedAgentToken(context.Background())

	err := NewRunnerService(queries).CompleteTask(ctx, RunnerCompleteTaskInput{
		TaskID: 12, RunnerID: 5, Status: "done",
	})
	require.NoError(t, err)
	assert.True(t, cleared)
	assert.True(t, released)
}

func TestRunnerService_CompleteTask_StaleTerminalAcknowledgementCannotReleaseReusedRunner(t *testing.T) {
	t.Parallel()

	released := false
	queries := &mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 0, pgx.ErrNoRows
		},
		getTerminalWorkflowTaskFn: func(_ context.Context, _ db.GetTerminalWorkflowTaskForRunnerParams) (int64, error) {
			return 77, nil
		},
		clearTerminalTaskOwnershipFn: func(_ context.Context, _ db.ClearTerminalWorkflowTaskRunnerOwnershipParams) (int64, error) {
			return 0, nil
		},
		releaseRunnerFn: func(_ context.Context, _ int64) (int64, error) {
			released = true
			return 1, nil
		},
	}

	err := NewRunnerService(queries).CompleteTask(
		middleware.ContextWithSharedAgentToken(context.Background()),
		RunnerCompleteTaskInput{TaskID: 12, RunnerID: 5, Status: "done"},
	)
	assert.Equal(t, 409, runnerAPIStatus(t, err))
	assert.False(t, released, "an acknowledgement that no longer owns the task must not release a newer lease")
}

func TestRunnerService_CompleteTask_UpdateRunStatusNoRows_IsIgnored(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 5001, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "", pgx.ErrNoRows
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   8,
		RunnerID: 4,
		Status:   "cancelled",
		Error:    "stopped",
	})
	require.NoError(t, err)
}

func TestRunnerService_CompleteTask_UpdateRunStatusError_ReturnsInternal(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 5002, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "", errors.New("query failed")
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   9,
		RunnerID: 5,
		Status:   "done",
	})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunnerService_CompleteTask_DispatchesWorkflowRunWebhook(t *testing.T) {
	t.Parallel()

	dispatcher := &mockRunnerDispatcher{}

	svc := NewRunnerService(
		&mockRunnerQuerier{
			markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
				return 5003, nil
			},
			updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
				return "success", nil
			},
			getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
				require.Equal(t, int64(5003), runID)
				return db.WorkflowRun{
					ID:               5003,
					RepositoryID:     77,
					Status:           "success",
					TriggerEvent:     "push",
					TriggerRef:       "main",
					TriggerCommitSha: "abc123",
					CreatedAt:        time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC),
				}, nil
			},
		},
		WithRunnerWebhookDispatcher(dispatcher),
	)

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   10,
		RunnerID: 11,
		Status:   "done",
	})
	require.NoError(t, err)

	require.Len(t, dispatcher.calls, 1)
	call := dispatcher.calls[0]
	assert.Equal(t, int64(77), call.repoID)
	assert.Equal(t, "workflow_run", call.eventType)

	payload, ok := call.payload.(webhooks.WorkflowRunEventPayload)
	require.True(t, ok)
	assert.Equal(t, "completed", payload.Action)
	assert.Equal(t, int64(5003), payload.WorkflowRun.ID)
	assert.Equal(t, "success", payload.WorkflowRun.Status)
	assert.Equal(t, "push", payload.WorkflowRun.TriggerEvent)
	assert.Equal(t, "main", payload.WorkflowRun.TriggerRef)
	assert.Equal(t, "abc123", payload.WorkflowRun.CommitSHA)
}

func TestRunnerService_CompleteTask_DispatchesWorkflowRunTrigger(t *testing.T) {
	t.Parallel()

	workflowDispatcher := &mockRunnerWorkflowDispatcher{}
	svc := NewRunnerService(
		&mockRunnerQuerier{
			markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
				return 5005, nil
			},
			updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
				return "success", nil
			},
			getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
				require.Equal(t, int64(5005), runID)
				return db.WorkflowRun{
					ID:               5005,
					RepositoryID:     77,
					Status:           "success",
					TriggerEvent:     "push",
					TriggerRef:       "main",
					TriggerCommitSha: "abc123",
				}, nil
			},
			getWorkflowDefinitionNameByRunIDFn: func(_ context.Context, workflowRunID int64) (string, error) {
				require.Equal(t, int64(5005), workflowRunID)
				return "CI", nil
			},
		},
		WithRunnerWorkflowDispatcher(workflowDispatcher),
	)

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   10,
		RunnerID: 11,
		Status:   "done",
	})
	require.NoError(t, err)

	require.Len(t, workflowDispatcher.calls, 1)
	call := workflowDispatcher.calls[0]
	assert.Equal(t, int64(77), call.RepositoryID)
	assert.Equal(t, "workflow_run", call.Event.Type)
	assert.Equal(t, "completed", call.Event.Action)
	assert.Equal(t, "CI", call.Event.SourceWorkflow)
	assert.Equal(t, "main", call.Event.Ref)
	assert.Equal(t, "abc123", call.Event.CommitSHA)
}

func TestRunnerService_CompleteTask_DoesNotDispatchWorkflowRunTriggerWithoutCommit(t *testing.T) {
	t.Parallel()

	workflowDispatcher := &mockRunnerWorkflowDispatcher{}
	svc := NewRunnerService(
		&mockRunnerQuerier{
			markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
				return 5006, nil
			},
			updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
				return "success", nil
			},
			getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
				require.Equal(t, int64(5006), runID)
				return db.WorkflowRun{
					ID:           5006,
					RepositoryID: 77,
					Status:       "success",
					TriggerEvent: "landing_request",
					TriggerRef:   "main",
				}, nil
			},
		},
		WithRunnerWorkflowDispatcher(workflowDispatcher),
	)

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   10,
		RunnerID: 11,
		Status:   "done",
	})
	require.NoError(t, err)
	assert.Empty(t, workflowDispatcher.calls)
}

func TestRunnerService_CompleteTask_DispatchError_IsNonFatal(t *testing.T) {
	t.Parallel()

	dispatcher := &mockRunnerDispatcher{dispatchErr: errors.New("webhook down")}

	svc := NewRunnerService(
		&mockRunnerQuerier{
			markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
				return 5004, nil
			},
			updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
				return "failure", nil
			},
			getWorkflowRunByRunIDFn: func(_ context.Context, _ int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{
					ID:           5004,
					RepositoryID: 78,
					Status:       "failure",
					TriggerEvent: "push",
					CreatedAt:    time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC),
				}, nil
			},
		},
		WithRunnerWebhookDispatcher(dispatcher),
	)

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   12,
		RunnerID: 13,
		Status:   "failed",
		Error:    "boom",
	})
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
}

func TestWorkflowRunStatusToAction(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status string
		want   string
	}{
		{name: "queued", status: "queued", want: "queued"},
		{name: "running", status: "running", want: "in_progress"},
		{name: "success", status: "success", want: "completed"},
		{name: "failure", status: "failure", want: "failure"},
		{name: "error", status: "error", want: "failure"},
		{name: "cancelled", status: "cancelled", want: "cancelled"},
		{name: "unknown", status: "weird", want: ""},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, workflowRunStatusToAction(tt.status))
		})
	}
}

func TestRunnerService_StreamEvents_ValidatesTaskID(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{})
	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 0,
	})
	assert.Equal(t, 400, runnerAPIStatus(t, err))
}

func TestRunnerService_StreamEvents_NilQuerier_ReturnsStoreUnavailable(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(nil)
	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 10,
	})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunnerService_StreamEvents_TaskNotFound_ReturnsNotFound(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
			assert.Equal(t, int64(44), taskID)
			return db.GetWorkflowTaskForRunnerRow{}, pgx.ErrNoRows
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 44,
	})
	assert.Equal(t, 404, runnerAPIStatus(t, err))
}

func TestRunnerService_StreamEvents_EmptyEvents_Succeeds(t *testing.T) {
	t.Parallel()

	insertCalls := 0
	notifyCalls := 0

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
			assert.Equal(t, int64(55), taskID)
			return db.GetWorkflowTaskForRunnerRow{
				ID:             55,
				WorkflowRunID:  2001,
				WorkflowStepID: 301,
				Status:         "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, _ db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			insertCalls++
			return db.InsertWorkflowLogNextSequenceRow{}, nil
		},
		notifyWorkflowLogFn: func(_ context.Context, _ db.NotifyWorkflowLogParams) error {
			notifyCalls++
			return nil
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 55,
		Events: nil,
	})
	require.NoError(t, err)
	assert.Equal(t, 0, insertCalls)
	assert.Equal(t, 0, notifyCalls)
}

// A log row appended by the runner path must wake WorkflowRunLogsStream. The
// stream enumerates one `workflow_step_logs_<id>` channel per step that exists
// when the client connected and always LISTENs on `workflow_run_<id>`, so an
// append notifies both: a step created after the connect (agent dispatch, the
// sandbox scheduler) otherwise reaches the client only via the repair poll.
func TestRunnerService_StreamEvents_NotifiesStepAndRunLogChannels(t *testing.T) {
	t.Parallel()

	var stepNotifies []db.NotifyWorkflowLogParams
	var runNotifies []db.NotifyWorkflowRunLogParams
	inserted := int64(0)

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID: 107860, WorkflowRunID: 11717, WorkflowStepID: 5, RepositoryID: 101, Status: "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			inserted++
			return db.InsertWorkflowLogNextSequenceRow{
				ID:             inserted,
				WorkflowRunID:  arg.WorkflowRunID,
				WorkflowStepID: arg.WorkflowStepID,
				Sequence:       inserted,
				Stream:         arg.Stream,
				Entry:          arg.Entry,
			}, nil
		},
		notifyWorkflowLogFn: func(_ context.Context, arg db.NotifyWorkflowLogParams) error {
			stepNotifies = append(stepNotifies, arg)
			return nil
		},
		notifyWorkflowRunLogFn: func(_ context.Context, arg db.NotifyWorkflowRunLogParams) error {
			runNotifies = append(runNotifies, arg)
			return nil
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 107860,
		Events: []RunnerEvent{
			{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"cargo build\n"}`)},
			{Type: "log", Data: json.RawMessage(`{"stream":"system","text":"::gate native\n"}`)},
		},
	})
	require.NoError(t, err)

	require.Len(t, stepNotifies, 2)
	require.Len(t, runNotifies, 2)
	for i := range runNotifies {
		assert.Equal(t, int64(11717), runNotifies[i].RunID)
		// Both channels carry the identical persisted payload, so a client
		// woken by either one renders the same row.
		assert.Equal(t, stepNotifies[i].Payload, runNotifies[i].Payload)
	}
	// Order is the insertion order, so the stdout line and the trailing system
	// marker cannot be delivered out of sequence.
	assert.Contains(t, runNotifies[0].Payload, "cargo build")
	assert.Contains(t, runNotifies[1].Payload, "::gate native")
}

func TestRunnerService_StreamEvents_RunLogNotifyFailure_ReturnsInternal(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID: 107860, WorkflowRunID: 11717, WorkflowStepID: 5, RepositoryID: 101, Status: "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			return db.InsertWorkflowLogNextSequenceRow{ID: 1, WorkflowRunID: arg.WorkflowRunID, WorkflowStepID: arg.WorkflowStepID, Sequence: 1, Stream: arg.Stream, Entry: arg.Entry}, nil
		},
		notifyWorkflowRunLogFn: func(context.Context, db.NotifyWorkflowRunLogParams) error {
			return errors.New("notify failed")
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 107860,
		Events: []RunnerEvent{{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"hi"}`)}},
	})
	require.Error(t, err)
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunnerService_StreamEvents_InsertsLogs(t *testing.T) {
	t.Parallel()

	inserts := make([]db.InsertWorkflowLogNextSequenceParams, 0)
	notifies := make([]db.NotifyWorkflowLogParams, 0)

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
			assert.Equal(t, int64(123), taskID)
			return db.GetWorkflowTaskForRunnerRow{
				ID:             123,
				WorkflowRunID:  10,
				WorkflowStepID: 5,
				RepositoryID:   101,
				Status:         "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			inserts = append(inserts, arg)
			return db.InsertWorkflowLogNextSequenceRow{
				ID:             int64(len(inserts)),
				WorkflowRunID:  arg.WorkflowRunID,
				WorkflowStepID: arg.WorkflowStepID,
				Sequence:       int64(len(inserts)),
				Stream:         arg.Stream,
				Entry:          arg.Entry,
			}, nil
		},
		notifyWorkflowLogFn: func(_ context.Context, arg db.NotifyWorkflowLogParams) error {
			notifies = append(notifies, arg)
			return nil
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 123,
		Events: []RunnerEvent{
			{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"line one"}`)},
			{Type: "log", Data: json.RawMessage(`{"stream":"stderr","text":"line two"}`)},
		},
	})
	require.NoError(t, err)

	require.Len(t, inserts, 2)
	assert.Equal(t, int64(10), inserts[0].WorkflowRunID)
	assert.Equal(t, int64(5), inserts[0].WorkflowStepID)
	assert.Equal(t, "stdout", inserts[0].Stream)
	assert.Equal(t, "line one", inserts[0].Entry)
	assert.Equal(t, "stderr", inserts[1].Stream)
	assert.Equal(t, "line two", inserts[1].Entry)

	require.Len(t, notifies, 2)
	assert.Equal(t, int64(5), notifies[0].StepID)
	assert.Equal(t, int64(5), notifies[1].StepID)
}

func TestRunnerService_StreamEvents_RedactsRepoSecretsBeforeInsert(t *testing.T) {
	t.Parallel()

	inserts := make([]db.InsertWorkflowLogNextSequenceParams, 0, 1)
	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID:             123,
				WorkflowRunID:  10,
				WorkflowStepID: 5,
				RepositoryID:   101,
				Status:         "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			inserts = append(inserts, arg)
			return db.InsertWorkflowLogNextSequenceRow{
				ID:             1,
				WorkflowRunID:  arg.WorkflowRunID,
				WorkflowStepID: arg.WorkflowStepID,
				Sequence:       1,
				Stream:         arg.Stream,
				Entry:          arg.Entry,
			}, nil
		},
	}, WithRunnerSecretInjector(NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
			assert.Equal(t, int64(101), repositoryID)
			return []db.ListSecretValuesRow{
				{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte("smithers_secret_token")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})))

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 123,
		Events: []RunnerEvent{
			{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"token=smithers_secret_token"}`)},
		},
	})
	require.NoError(t, err)
	require.Len(t, inserts, 1)
	assert.Equal(t, "token=********", inserts[0].Entry)
}

func TestRunnerService_StreamEvents_ContinuesSequenceFromExistingLogs(t *testing.T) {
	t.Parallel()

	var insertedSequences []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID:             123,
				WorkflowRunID:  10,
				WorkflowStepID: 5,
				Status:         "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			nextSequence := int64(8 + len(insertedSequences))
			insertedSequences = append(insertedSequences, nextSequence)
			return db.InsertWorkflowLogNextSequenceRow{
				ID:             int64(len(insertedSequences)),
				WorkflowRunID:  arg.WorkflowRunID,
				WorkflowStepID: arg.WorkflowStepID,
				Sequence:       nextSequence,
				Stream:         arg.Stream,
				Entry:          arg.Entry,
			}, nil
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 123,
		Events: []RunnerEvent{
			{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"line one"}`)},
			{Type: "log", Data: json.RawMessage(`{"stream":"stderr","text":"line two"}`)},
		},
	})
	require.NoError(t, err)
	require.Len(t, insertedSequences, 2)
	assert.Equal(t, int64(8), insertedSequences[0])
	assert.Equal(t, int64(9), insertedSequences[1])
}

func TestRunnerService_StreamEvents_SkipsNonLogEvents(t *testing.T) {
	t.Parallel()

	insertCalls := 0

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID:             1,
				WorkflowRunID:  10,
				WorkflowStepID: 20,
				Status:         "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			insertCalls++
			return db.InsertWorkflowLogNextSequenceRow{
				ID:             1,
				WorkflowRunID:  arg.WorkflowRunID,
				WorkflowStepID: arg.WorkflowStepID,
				Sequence:       1,
				Stream:         arg.Stream,
				Entry:          arg.Entry,
			}, nil
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 1,
		Events: []RunnerEvent{
			{Type: "token", Data: json.RawMessage(`{"text":"token"}`)},
			{Type: "log", Data: json.RawMessage(`{"stream":"system","text":"one log"}`)},
			{Type: "error", Data: json.RawMessage(`{"message":"boom"}`)},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, 1, insertCalls)
}

// Issue #285: a request with more than maxRunnerStreamEventsPerRequest events
// must be rejected with 413 before ever touching the task/secrets lookups.
func TestRunnerService_StreamEvents_TooManyEvents_Returns413(t *testing.T) {
	t.Parallel()

	taskFetchCalls := 0
	insertCalls := 0

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			taskFetchCalls++
			return db.GetWorkflowTaskForRunnerRow{ID: 1, WorkflowRunID: 10, WorkflowStepID: 20, Status: "running"}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			insertCalls++
			return db.InsertWorkflowLogNextSequenceRow{}, nil
		},
	})

	events := make([]RunnerEvent, maxRunnerStreamEventsPerRequest+1)
	for i := range events {
		events[i] = RunnerEvent{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":""}`)}
	}

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 1,
		Events: events,
	})
	assert.Equal(t, 413, runnerAPIStatus(t, err))
	assert.Equal(t, 0, taskFetchCalls, "task lookup must not happen for an over-budget batch")
	assert.Equal(t, 0, insertCalls)
}

// Issue #285: a batch whose aggregate log text exceeds
// maxRunnerStreamLogBytesPerRequest must be rejected with 413, and no log
// insert must have been issued for any event in the batch.
func TestRunnerService_StreamEvents_OversizedLogPayload_Returns413(t *testing.T) {
	t.Parallel()

	insertCalls := 0

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{ID: 1, WorkflowRunID: 10, WorkflowStepID: 20, Status: "running"}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			insertCalls++
			return db.InsertWorkflowLogNextSequenceRow{}, nil
		},
	})

	bigText := strings.Repeat("a", maxRunnerStreamLogBytesPerRequest)
	data, err := json.Marshal(map[string]string{"stream": "stdout", "text": bigText})
	require.NoError(t, err)
	overflowData, err := json.Marshal(map[string]string{"stream": "stdout", "text": "overflow"})
	require.NoError(t, err)

	streamErr := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 1,
		Events: []RunnerEvent{
			{Type: "log", Data: data},
			{Type: "log", Data: overflowData},
		},
	})
	assert.Equal(t, 413, runnerAPIStatus(t, streamErr))
	assert.Equal(t, 0, insertCalls, "no log insert should happen once the batch is over budget")
}

func TestRunnerService_StreamEvents_InsertError_ReturnsInternal(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID:             1,
				WorkflowRunID:  10,
				WorkflowStepID: 20,
				Status:         "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, _ db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			return db.InsertWorkflowLogNextSequenceRow{}, errors.New("insert failed")
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 1,
		Events: []RunnerEvent{
			{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"line"}`)},
		},
	})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunnerService_StreamEvents_NotifyError_ReturnsInternal(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID:             1,
				WorkflowRunID:  10,
				WorkflowStepID: 20,
				Status:         "running",
			}, nil
		},
		insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			return db.InsertWorkflowLogNextSequenceRow{
				ID:             1,
				WorkflowRunID:  arg.WorkflowRunID,
				WorkflowStepID: arg.WorkflowStepID,
				Sequence:       1,
				Stream:         arg.Stream,
				Entry:          arg.Entry,
			}, nil
		},
		notifyWorkflowLogFn: func(_ context.Context, _ db.NotifyWorkflowLogParams) error {
			return errors.New("notify failed")
		},
	})

	err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
		TaskID: 1,
		Events: []RunnerEvent{
			{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"line"}`)},
		},
	})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
}

// ─── DAG dependency progression ───────────────────────────────────────────────

func TestRunnerService_CompleteTask_UnblocksDownstream(t *testing.T) {
	t.Parallel()

	var unblockedIDs []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, runID int64) ([]db.ListBlockedTasksForRunRow, error) {
			assert.Equal(t, int64(100), runID)
			if len(unblockedIDs) > 0 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{ID: 2, StepName: "B", Payload: json.RawMessage(`{"needs":["A"]}`)},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, Status: "done", StepName: "A"},
				{ID: 2, Status: "blocked", StepName: "B"},
			}, nil
		},
		unblockTaskFn: func(_ context.Context, id int64) error {
			unblockedIDs = append(unblockedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "running", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "done",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{2}, unblockedIDs)
}

func TestRunnerService_CompleteTask_FailsDownstream(t *testing.T) {
	t.Parallel()

	var skippedIDs []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			if len(skippedIDs) > 0 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{ID: 2, StepName: "B", Payload: json.RawMessage(`{"needs":["A"]}`)},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, Status: "failed", StepName: "A"},
				{ID: 2, Status: "blocked", StepName: "B"},
			}, nil
		},
		skipBlockedTaskFn: func(_ context.Context, id int64) error {
			skippedIDs = append(skippedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "failure", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "failed",
		Error:    "build failed",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{2}, skippedIDs)
}

func TestRunnerService_CompleteTask_TransitiveDependencies(t *testing.T) {
	t.Parallel()

	var skippedIDs []int64
	callCount := 0

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			callCount++
			switch callCount {
			case 1:
				return []db.ListBlockedTasksForRunRow{
					{ID: 2, StepName: "B", Payload: json.RawMessage(`{"needs":["A"]}`)},
					{ID: 3, StepName: "C", Payload: json.RawMessage(`{"needs":["B"]}`)},
				}, nil
			case 2:
				return []db.ListBlockedTasksForRunRow{
					{ID: 3, StepName: "C", Payload: json.RawMessage(`{"needs":["B"]}`)},
				}, nil
			default:
				return nil, nil
			}
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			switch callCount {
			case 1:
				return []db.ListTaskStepInfoForRunRow{
					{ID: 1, Status: "failed", StepName: "A"},
					{ID: 2, Status: "blocked", StepName: "B"},
					{ID: 3, Status: "blocked", StepName: "C"},
				}, nil
			default:
				return []db.ListTaskStepInfoForRunRow{
					{ID: 1, Status: "failed", StepName: "A"},
					{ID: 2, Status: "skipped", StepName: "B"},
					{ID: 3, Status: "blocked", StepName: "C"},
				}, nil
			}
		},
		skipBlockedTaskFn: func(_ context.Context, id int64) error {
			skippedIDs = append(skippedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "failure", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "failed",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{2, 3}, skippedIDs)
}

func TestRunnerService_CompleteTask_NoBlockedTasks_Noop(t *testing.T) {
	t.Parallel()

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			return nil, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "success", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "done",
	})
	require.NoError(t, err)
}

// ─── if-expression override in dependency progression ──────────────────────

func TestRunnerService_CompleteTask_AlwaysOverride_UnblocksOnFailure(t *testing.T) {
	t.Parallel()

	// Job B depends on A and has if: always(). Even if A fails, B should unblock (not skip).
	var unblockedIDs []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			if len(unblockedIDs) > 0 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{ID: 2, StepName: "B", Payload: json.RawMessage(`{"needs":["A"],"if":"always()"}`)},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, Status: "failed", StepName: "A"},
				{ID: 2, Status: "blocked", StepName: "B"},
			}, nil
		},
		unblockTaskFn: func(_ context.Context, id int64) error {
			unblockedIDs = append(unblockedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "running", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "failed",
		Error:    "build failed",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{2}, unblockedIDs, "B should be unblocked despite A failure because of always()")
}

func TestRunnerService_CompleteTask_NeedsResultExpression_UnblocksOnFailure(t *testing.T) {
	t.Parallel()

	// Job B depends on A and has if: needs.A.result == "failure". A failed, so B should unblock.
	var unblockedIDs []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			if len(unblockedIDs) > 0 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{ID: 2, StepName: "B", Payload: json.RawMessage(`{"needs":["A"],"if":"needs.A.result == \"failure\""}`)},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, Status: "failed", StepName: "A"},
				{ID: 2, Status: "blocked", StepName: "B"},
			}, nil
		},
		unblockTaskFn: func(_ context.Context, id int64) error {
			unblockedIDs = append(unblockedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "running", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "failed",
		Error:    "build failed",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{2}, unblockedIDs, "B should be unblocked because needs.A.result == failure matches")
}

func TestRunnerService_CompleteTask_NeedsResultExpression_SkipsOnMismatch(t *testing.T) {
	t.Parallel()

	// Job B depends on A and has if: needs.A.result == "success". A failed, so B should be skipped.
	var skippedIDs []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			if len(skippedIDs) > 0 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{ID: 2, StepName: "B", Payload: json.RawMessage(`{"needs":["A"],"if":"needs.A.result == \"success\""}`)},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, Status: "failed", StepName: "A"},
				{ID: 2, Status: "blocked", StepName: "B"},
			}, nil
		},
		skipBlockedTaskFn: func(_ context.Context, id int64) error {
			skippedIDs = append(skippedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "failure", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "failed",
		Error:    "build failed",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{2}, skippedIDs, "B should be skipped because needs.A.result == success doesn't match")
}

func TestRunnerService_CompleteTask_InputExpression_UnblocksNotifyAfterFailure(t *testing.T) {
	t.Parallel()

	var unblockedIDs []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			if len(unblockedIDs) > 0 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{
					ID:       2,
					StepName: "notify",
					Payload:  json.RawMessage(`{"needs":["review"],"if":"!contains(inputs.issueLabels, \"no-agent\")","event":"issues","inputs":{"issueLabels":["bug"]}}`),
				},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, Status: "failed", StepName: "review"},
				{ID: 2, Status: "blocked", StepName: "notify"},
			}, nil
		},
		unblockTaskFn: func(_ context.Context, id int64) error {
			unblockedIDs = append(unblockedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "running", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "failed",
		Error:    "review failed",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{2}, unblockedIDs, "notify should still run when the issue is not opted out")
}

func TestRunnerService_CompleteTask_NeedsResultExpression_SkipsOnSuccessMismatch(t *testing.T) {
	t.Parallel()

	var skippedIDs []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			if len(skippedIDs) > 0 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{ID: 2, StepName: "review", Payload: json.RawMessage(`{"needs":["ci"],"if":"needs.ci.result == \"failure\""}`)},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, Status: "done", StepName: "ci"},
				{ID: 2, Status: "blocked", StepName: "review"},
			}, nil
		},
		skipBlockedTaskFn: func(_ context.Context, id int64) error {
			skippedIDs = append(skippedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "success", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   1,
		RunnerID: 10,
		Status:   "done",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{2}, skippedIDs, "review should be skipped when the needs-expression does not match even after a successful dependency")
}

func TestRunnerService_CompleteTask_MixedResults_PartialFailure(t *testing.T) {
	t.Parallel()

	// A succeeds, B fails. C needs [A, B] (no if) -> skip. D needs [A] only -> unblock.
	var skippedIDs []int64
	var unblockedIDs []int64

	svc := NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 100, nil
		},
		listBlockedTasksFn: func(_ context.Context, _ int64) ([]db.ListBlockedTasksForRunRow, error) {
			if len(skippedIDs)+len(unblockedIDs) > 0 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{ID: 3, StepName: "C", Payload: json.RawMessage(`{"needs":["A","B"]}`)},
				{ID: 4, StepName: "D", Payload: json.RawMessage(`{"needs":["A"]}`)},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, _ int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, Status: "done", StepName: "A"},
				{ID: 2, Status: "failed", StepName: "B"},
				{ID: 3, Status: "blocked", StepName: "C"},
				{ID: 4, Status: "blocked", StepName: "D"},
			}, nil
		},
		skipBlockedTaskFn: func(_ context.Context, id int64) error {
			skippedIDs = append(skippedIDs, id)
			return nil
		},
		unblockTaskFn: func(_ context.Context, id int64) error {
			unblockedIDs = append(unblockedIDs, id)
			return nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, _ int64) (string, error) {
			return "failure", nil
		},
	})

	err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   2,
		RunnerID: 10,
		Status:   "failed",
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{3}, skippedIDs, "C should be skipped because B failed")
	assert.Equal(t, []int64{4}, unblockedIDs, "D should be unblocked because A is done")
}

func TestParseIfExprFromPayload(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		payload json.RawMessage
		want    string
	}{
		{name: "with if", payload: json.RawMessage(`{"if":"always()","needs":["A"]}`), want: "always()"},
		{name: "no if", payload: json.RawMessage(`{"needs":["A"]}`), want: ""},
		{name: "empty if", payload: json.RawMessage(`{"if":"","needs":["A"]}`), want: ""},
		{name: "invalid json", payload: json.RawMessage(`{bad`), want: ""},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := parseIfExprFromPayload(tt.payload)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestParseNeedsFromPayload(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		payload json.RawMessage
		want    []string
	}{
		{name: "with needs", payload: json.RawMessage(`{"needs":["build","lint"]}`), want: []string{"build", "lint"}},
		{name: "no needs", payload: json.RawMessage(`{"job":"test"}`), want: nil},
		{name: "empty needs", payload: json.RawMessage(`{"needs":[]}`), want: []string{}},
		{name: "invalid json", payload: json.RawMessage(`{bad`), want: nil},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := parseNeedsFromPayload(tt.payload)
			assert.Equal(t, tt.want, got)
		})
	}
}

// TestRunnerService_StreamEvents_CrossRunCallback verifies that a runner
// authenticated for run A cannot stream log events into a task belonging to
// run B (cross-run callback rejection).
func TestRunnerService_StreamEvents_CrossRunCallback(t *testing.T) {
	t.Parallel()

	t.Run("rejects task from different run", func(t *testing.T) {
		t.Parallel()

		svc := NewRunnerService(&mockRunnerQuerier{
			getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
				assert.Equal(t, int64(77), taskID)
				return db.GetWorkflowTaskForRunnerRow{
					ID:            77,
					WorkflowRunID: 200, // belongs to run 200
					RepositoryID:  10,
					Status:        "running",
				}, nil
			},
		})

		// Agent token is scoped to run 100, but the task belongs to run 200.
		ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 100})

		err := svc.StreamEvents(ctx, RunnerStreamEventsInput{
			TaskID: 77,
			Events: []RunnerEvent{{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"hello"}`)}},
		})
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 403, apiErr.Status)
		assert.Contains(t, apiErr.Message, "workflow run")
	})

	t.Run("allows task from same run", func(t *testing.T) {
		t.Parallel()

		svc := NewRunnerService(&mockRunnerQuerier{
			getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
				return db.GetWorkflowTaskForRunnerRow{
					ID:             taskID,
					WorkflowRunID:  100, // same run
					WorkflowStepID: 55,
					RepositoryID:   10,
					Status:         "running",
				}, nil
			},
			insertWorkflowLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
				return db.InsertWorkflowLogNextSequenceRow{
					ID:             1,
					WorkflowStepID: 55,
					Sequence:       1,
					Stream:         "stdout",
					Entry:          "hello",
				}, nil
			},
			notifyWorkflowLogFn: func(_ context.Context, _ db.NotifyWorkflowLogParams) error {
				return nil
			},
		})

		// Agent token scoped to run 100; task also belongs to run 100.
		ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 100})

		err := svc.StreamEvents(ctx, RunnerStreamEventsInput{
			TaskID: 77,
			Events: []RunnerEvent{{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"hello"}`)}},
		})
		require.NoError(t, err)
	})

	t.Run("no run in context skips scope check", func(t *testing.T) {
		t.Parallel()

		// When there is no workflow run in context (e.g. shared runner token),
		// the scope check is skipped and the call proceeds normally.
		svc := NewRunnerService(&mockRunnerQuerier{
			getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
				return db.GetWorkflowTaskForRunnerRow{
					ID:             taskID,
					WorkflowRunID:  999,
					WorkflowStepID: 66,
					RepositoryID:   10,
					Status:         "running",
				}, nil
			},
			insertWorkflowLogNextSequenceFn: func(_ context.Context, _ db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
				return db.InsertWorkflowLogNextSequenceRow{
					ID:             2,
					WorkflowStepID: 66,
					Sequence:       1,
					Stream:         "stdout",
					Entry:          "line",
				}, nil
			},
			notifyWorkflowLogFn: func(_ context.Context, _ db.NotifyWorkflowLogParams) error {
				return nil
			},
		})

		// No workflow run in context.
		err := svc.StreamEvents(context.Background(), RunnerStreamEventsInput{
			TaskID: 88,
			Events: []RunnerEvent{{Type: "log", Data: json.RawMessage(`{"stream":"stdout","text":"line"}`)}},
		})
		require.NoError(t, err)
	})
}

func TestRunnerService_CompleteTask_RejectsLegacyWorkflowCredentialBeforeMutation(t *testing.T) {
	t.Parallel()

	queried, completed := false, false
	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, _ int64) (db.GetWorkflowTaskForRunnerRow, error) {
			queried = true
			return db.GetWorkflowTaskForRunnerRow{}, nil
		},
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			completed = true
			return 100, nil
		},
	})

	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 100})
	err := svc.CompleteTask(ctx, RunnerCompleteTaskInput{
		TaskID: 77, RunnerID: 42, Status: "done",
	})
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.Status)
	assert.Contains(t, apiErr.Message, "workflow credentials")
	assert.False(t, queried)
	assert.False(t, completed)
}

// ─── Transactional CompleteTask wiring ───────────────────────────────────────

// txBeginErrRunnerQuerier makes CompleteTask take the transactional branch (it
// implements BeginTx + WithTx like *db.Queries) and fails at BeginTx. This
// pins the wiring for issues #139/#294: when the store supports transactions,
// task completion must run inside one — never fall back to the multi-statement
// path that can strand progress or double-fire terminal side effects.
type txBeginErrRunnerQuerier struct {
	*mockRunnerQuerier
	beginTxCalls int
}

func (q *txBeginErrRunnerQuerier) BeginTx(context.Context) (pgx.Tx, error) {
	q.beginTxCalls++
	return nil, errors.New("begin tx unavailable")
}

func (q *txBeginErrRunnerQuerier) WithTx(pgx.Tx) *db.Queries {
	panic("WithTx must not be called when BeginTx fails")
}

func TestRunnerService_CompleteTask_UsesTransactionWhenSupported(t *testing.T) {
	t.Parallel()

	taskMarked := false
	mock := &txBeginErrRunnerQuerier{mockRunnerQuerier: &mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(_ context.Context, _ db.MarkWorkflowTaskDoneParams) (int64, error) {
			taskMarked = true
			return 501, nil
		},
	}}

	err := NewRunnerService(mock).CompleteTask(context.Background(), RunnerCompleteTaskInput{
		TaskID:   91,
		RunnerID: 17,
		Status:   "done",
	})
	assert.Equal(t, 500, runnerAPIStatus(t, err))
	assert.Equal(t, 1, mock.beginTxCalls)
	assert.False(t, taskMarked, "the task must not be marked done outside the transaction")
}
