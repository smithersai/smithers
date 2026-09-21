//go:build integration
// +build integration

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type workflowAliasCall struct {
	Op           string
	RepositoryID int64
	RunID        int64
	UserID       int64
}

type workflowAliasSpyService struct {
	mu    sync.Mutex
	calls []workflowAliasCall
}

func (s *workflowAliasSpyService) ListWorkflowDefinitions(context.Context, int64, int, int) ([]db.WorkflowDefinition, error) {
	return nil, nil
}

func (s *workflowAliasSpyService) GetWorkflowDefinition(context.Context, int64, int64) (db.WorkflowDefinition, error) {
	return db.WorkflowDefinition{}, nil
}

func (s *workflowAliasSpyService) ListWorkflowRunsByRepo(context.Context, int64, int, int) ([]db.WorkflowRun, error) {
	return nil, nil
}

func (s *workflowAliasSpyService) ListWorkflowRunsByDefinition(context.Context, int64, int64, int, int) ([]db.WorkflowRun, error) {
	return nil, nil
}

func (s *workflowAliasSpyService) GetWorkflowRun(context.Context, int64, int64) (db.WorkflowRun, error) {
	return db.WorkflowRun{}, nil
}

func (s *workflowAliasSpyService) CancelWorkflowRun(_ context.Context, repositoryID, runID int64) error {
	s.record(workflowAliasCall{Op: "cancel", RepositoryID: repositoryID, RunID: runID})
	return nil
}

func (s *workflowAliasSpyService) ResumeRun(_ context.Context, repositoryID, runID int64) error {
	s.record(workflowAliasCall{Op: "resume", RepositoryID: repositoryID, RunID: runID})
	return nil
}

func (s *workflowAliasSpyService) DispatchForEvent(context.Context, services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	return nil, nil
}

func (s *workflowAliasSpyService) RerunRun(_ context.Context, input services.RerunInput) (*services.WorkflowRunResult, error) {
	s.record(workflowAliasCall{
		Op:           "rerun",
		RepositoryID: input.RepositoryID,
		RunID:        input.RunID,
		UserID:       input.UserID,
	})
	return &services.WorkflowRunResult{
		WorkflowDefinitionID: 88,
		WorkflowRunID:        99,
		Steps: []services.WorkflowStepResult{
			{StepID: 501, TaskID: 601},
		},
	}, nil
}

func (s *workflowAliasSpyService) ListWorkflowSteps(context.Context, int64) ([]db.WorkflowStep, error) {
	return nil, nil
}

func (s *workflowAliasSpyService) ListWorkflowLogsSince(context.Context, int64, int64, int32) ([]db.WorkflowLog, error) {
	return nil, nil
}

func (s *workflowAliasSpyService) record(call workflowAliasCall) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, call)
}

func (s *workflowAliasSpyService) snapshot() []workflowAliasCall {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]workflowAliasCall, len(s.calls))
	copy(out, s.calls)
	return out
}

func TestRunsAliases(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "workflow_alias_user")
	repo := routesIntegrationCreateRepo(t, pool, user, "workflow_alias_repo", false)

	spy := &workflowAliasSpyService{}
	server, _ := setupRoutesIntegrationServer(t, queries, routesIntegrationServerOptions{
		workflowService: spy,
	})
	authClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))

	canonicalCancel := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/workflows/runs/42/cancel",
		nil,
	)
	require.Equal(t, http.StatusNoContent, canonicalCancel.StatusCode)
	require.Empty(t, routesIntegrationReadBody(t, canonicalCancel))

	aliasCancel := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/runs/42/cancel",
		nil,
	)
	require.Equal(t, canonicalCancel.StatusCode, aliasCancel.StatusCode)
	require.Empty(t, routesIntegrationReadBody(t, aliasCancel))

	canonicalRerun := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/workflows/runs/42/rerun",
		[]byte(`{}`),
	)
	require.Equal(t, http.StatusCreated, canonicalRerun.StatusCode)
	canonicalRerunBody := routesIntegrationReadBody(t, canonicalRerun)

	aliasRerun := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/runs/42/rerun",
		[]byte(`{}`),
	)
	require.Equal(t, canonicalRerun.StatusCode, aliasRerun.StatusCode)
	aliasRerunBody := routesIntegrationReadBody(t, aliasRerun)
	require.JSONEq(t, string(canonicalRerunBody), string(aliasRerunBody))

	canonicalResume := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/workflows/runs/42/resume",
		nil,
	)
	require.Equal(t, http.StatusNoContent, canonicalResume.StatusCode)
	require.Empty(t, routesIntegrationReadBody(t, canonicalResume))

	aliasResume := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/runs/42/resume",
		nil,
	)
	require.Equal(t, canonicalResume.StatusCode, aliasResume.StatusCode)
	require.Empty(t, routesIntegrationReadBody(t, aliasResume))

	var rerunBody struct {
		WorkflowDefinitionID int64 `json:"workflow_definition_id"`
		WorkflowRunID        int64 `json:"workflow_run_id"`
		Steps                []struct {
			StepID int64 `json:"step_id"`
			TaskID int64 `json:"task_id"`
		} `json:"steps"`
	}
	require.NoError(t, json.Unmarshal(aliasRerunBody, &rerunBody))
	require.Equal(t, int64(88), rerunBody.WorkflowDefinitionID)
	require.Equal(t, int64(99), rerunBody.WorkflowRunID)
	require.Len(t, rerunBody.Steps, 1)
	require.Equal(t, int64(501), rerunBody.Steps[0].StepID)
	require.Equal(t, int64(601), rerunBody.Steps[0].TaskID)

	require.Equal(t, []workflowAliasCall{
		{Op: "cancel", RepositoryID: repo.ID, RunID: 42},
		{Op: "cancel", RepositoryID: repo.ID, RunID: 42},
		{Op: "rerun", RepositoryID: repo.ID, RunID: 42, UserID: user.ID},
		{Op: "rerun", RepositoryID: repo.ID, RunID: 42, UserID: user.ID},
		{Op: "resume", RepositoryID: repo.ID, RunID: 42},
		{Op: "resume", RepositoryID: repo.ID, RunID: 42},
	}, spy.snapshot())
}

// Ticket tests never invoke it; workflow invocation needs its own fixture.
func (s *workflowAliasSpyService) InvokeWorkflow(context.Context, services.InvokeWorkflowInput) (*services.InvokeWorkflowResult, error) {
	panic("unexpected InvokeWorkflow in workflow alias spy")
}

func (m *workflowAliasSpyService) GetWorkflowLogStreamHead(context.Context, int64) (int64, error) {
	return 0, nil
}
