package runtimeports

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// WorkflowRun is the canonical product run row returned by the claim-fenced
// terminal writes of a deployment's sandbox scheduler store.
type WorkflowRun = db.WorkflowRun

type WorkflowRunQuerier interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	CreateWorkflowRun(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error)
	CreateWorkflowStep(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error)
	CreateWorkflowTask(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error)
	CreateCommitStatus(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error)
	ListWorkflowDefinitionsByRepo(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error)
	GetWorkflowDefinition(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	EnsureWorkflowDefinitionReference(ctx context.Context, arg db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error)
	GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	UpdateWorkflowRunAgentToken(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error)
	CancelWorkflowRun(ctx context.Context, id int64) error
	// FailWorkflowRun terminalizes a run that aborted during dispatch. It is
	// required, not optional: a querier that silently lacked it left the run
	// queued forever, because status is otherwise derived from tasks that were
	// never created.
	FailWorkflowRun(ctx context.Context, id int64) error
	CancelWorkflowTasks(ctx context.Context, workflowRunID int64) error
	HasUnsettledRunnerOwnershipForWorkflowRun(ctx context.Context, workflowRunID int64) (bool, error)
	ResumeWorkflowRun(ctx context.Context, id int64) error
	ResumeWorkflowTasks(ctx context.Context, workflowRunID int64) error
	ResumeWorkflowSteps(ctx context.Context, workflowRunID int64) error
	NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
}
