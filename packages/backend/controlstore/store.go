// Package controlstore gives deployment control services their consumed product queries.
// All SQL and row models remain in the canonical product database implementation.
package controlstore

import (
	context "context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type AdminListAgentSessionsParams = db.AdminListAgentSessionsParams
type AdminListAgentSessionsRow = db.AdminListAgentSessionsRow
type AdminListTokensParams = db.AdminListTokensParams
type AdminListTokensRow = db.AdminListTokensRow
type AdminListWorkspacesParams = db.AdminListWorkspacesParams
type AdminListWorkspacesRow = db.AdminListWorkspacesRow
type AgentSession = db.AgentSession
type AnalyticsActivationRow = db.AnalyticsActivationRow
type AnalyticsAgentsByStatusParams = db.AnalyticsAgentsByStatusParams
type AnalyticsAgentsByStatusRow = db.AnalyticsAgentsByStatusRow
type AnalyticsAgentsParams = db.AnalyticsAgentsParams
type AnalyticsAgentsRow = db.AnalyticsAgentsRow
type AnalyticsImportFailuresParams = db.AnalyticsImportFailuresParams
type AnalyticsImportFailuresRow = db.AnalyticsImportFailuresRow
type AnalyticsImportsByStatusParams = db.AnalyticsImportsByStatusParams
type AnalyticsImportsByStatusRow = db.AnalyticsImportsByStatusRow
type AnalyticsImportsFailedByStageParams = db.AnalyticsImportsFailedByStageParams
type AnalyticsImportsFailedByStageRow = db.AnalyticsImportsFailedByStageRow
type AnalyticsLandingByStateParams = db.AnalyticsLandingByStateParams
type AnalyticsLandingByStateRow = db.AnalyticsLandingByStateRow
type AnalyticsLandingCycleParams = db.AnalyticsLandingCycleParams
type AnalyticsLandingParams = db.AnalyticsLandingParams
type AnalyticsLandingRow = db.AnalyticsLandingRow
type AnalyticsReposParams = db.AnalyticsReposParams
type AnalyticsReposRow = db.AnalyticsReposRow
type AnalyticsSignupsByDayParams = db.AnalyticsSignupsByDayParams
type AnalyticsSignupsByDayRow = db.AnalyticsSignupsByDayRow
type AnalyticsStuckAgentsParams = db.AnalyticsStuckAgentsParams
type AnalyticsStuckAgentsRow = db.AnalyticsStuckAgentsRow
type AnalyticsTopReposParams = db.AnalyticsTopReposParams
type AnalyticsTopReposRow = db.AnalyticsTopReposRow
type AnalyticsUsersParams = db.AnalyticsUsersParams
type AnalyticsUsersRow = db.AnalyticsUsersRow
type AnalyticsWorkspaceBootParams = db.AnalyticsWorkspaceBootParams
type AnalyticsWorkspaceBootRow = db.AnalyticsWorkspaceBootRow
type AnalyticsWorkspaceFailuresParams = db.AnalyticsWorkspaceFailuresParams
type AnalyticsWorkspaceFailuresRow = db.AnalyticsWorkspaceFailuresRow
type AnalyticsWorkspacesByDayParams = db.AnalyticsWorkspacesByDayParams
type AnalyticsWorkspacesByDayRow = db.AnalyticsWorkspacesByDayRow
type AnalyticsWorkspacesByKindStatusParams = db.AnalyticsWorkspacesByKindStatusParams
type AnalyticsWorkspacesByKindStatusRow = db.AnalyticsWorkspacesByKindStatusRow
type CommitStatus = db.CommitStatus
type FindAlertRemediationWorkflowRunParams = db.FindAlertRemediationWorkflowRunParams
type GetWorkflowDefinitionByPathParams = db.GetWorkflowDefinitionByPathParams
type HasLegacyAlertRemediationWorkflowRunParams = db.HasLegacyAlertRemediationWorkflowRunParams
type InsertAuditLogParams = db.InsertAuditLogParams
type InsertWorkflowLogNextSequenceParams = db.InsertWorkflowLogNextSequenceParams
type InsertWorkflowLogNextSequenceRow = db.InsertWorkflowLogNextSequenceRow
type InsertWorkflowLogParams = db.InsertWorkflowLogParams
type ListTaskStepInfoForRunRow = db.ListTaskStepInfoForRunRow
type ListWorkflowLogsSinceParams = db.ListWorkflowLogsSinceParams
type NotifyAgentSessionParams = db.NotifyAgentSessionParams
type NotifyWorkflowLogParams = db.NotifyWorkflowLogParams
type NotifyWorkflowRunEventParams = db.NotifyWorkflowRunEventParams
type NotifyWorkflowRunLogParams = db.NotifyWorkflowRunLogParams
type Organization = db.Organization
type Repository = db.Repository
type UpdateAgentSessionTerminalStatusParams = db.UpdateAgentSessionTerminalStatusParams
type UpdateWorkflowStepStatusTerminalParams = db.UpdateWorkflowStepStatusTerminalParams
type User = db.User
type WorkflowCach = db.WorkflowCach
type WorkflowDefinition = db.WorkflowDefinition
type WorkflowLog = db.WorkflowLog
type WorkflowRun = db.WorkflowRun
type WorkflowTask = db.WorkflowTask
type Workspace = db.Workspace

// DBTX is the caller-owned connection or transaction; New never opens a pool.
type DBTX = db.DBTX

// Product contains only queries consumed by deployment control services.

type Product interface {
	AnalyticsStatementTimeout(context.Context) error
	IsStorageDeletionObjectActive(context.Context, db.IsStorageDeletionObjectActiveParams) (bool, error)
	GetRepoByOwnerAndName(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	AdminListAgentSessions(ctx context.Context, arg db.AdminListAgentSessionsParams) ([]db.AdminListAgentSessionsRow, error)
	AdminListTokens(ctx context.Context, arg db.AdminListTokensParams) ([]db.AdminListTokensRow, error)
	AdminListWorkspaces(ctx context.Context, arg db.AdminListWorkspacesParams) ([]db.AdminListWorkspacesRow, error)
	AnalyticsActivation(ctx context.Context, includeSynthetic bool) (db.AnalyticsActivationRow, error)
	AnalyticsAgents(ctx context.Context, arg db.AnalyticsAgentsParams) (db.AnalyticsAgentsRow, error)
	AnalyticsAgentsByStatus(ctx context.Context, arg db.AnalyticsAgentsByStatusParams) ([]db.AnalyticsAgentsByStatusRow, error)
	AnalyticsImportFailures(ctx context.Context, arg db.AnalyticsImportFailuresParams) ([]db.AnalyticsImportFailuresRow, error)
	AnalyticsImportsByStatus(ctx context.Context, arg db.AnalyticsImportsByStatusParams) ([]db.AnalyticsImportsByStatusRow, error)
	AnalyticsImportsFailedByStage(ctx context.Context, arg db.AnalyticsImportsFailedByStageParams) ([]db.AnalyticsImportsFailedByStageRow, error)
	AnalyticsLanding(ctx context.Context, arg db.AnalyticsLandingParams) (db.AnalyticsLandingRow, error)
	AnalyticsLandingByState(ctx context.Context, arg db.AnalyticsLandingByStateParams) ([]db.AnalyticsLandingByStateRow, error)
	AnalyticsLandingCycle(ctx context.Context, arg db.AnalyticsLandingCycleParams) (float64, error)
	AnalyticsRepos(ctx context.Context, arg db.AnalyticsReposParams) (db.AnalyticsReposRow, error)
	AnalyticsSignupsByDay(ctx context.Context, arg db.AnalyticsSignupsByDayParams) ([]db.AnalyticsSignupsByDayRow, error)
	AnalyticsStuckAgents(ctx context.Context, arg db.AnalyticsStuckAgentsParams) ([]db.AnalyticsStuckAgentsRow, error)
	AnalyticsTopRepos(ctx context.Context, arg db.AnalyticsTopReposParams) ([]db.AnalyticsTopReposRow, error)
	AnalyticsUsers(ctx context.Context, arg db.AnalyticsUsersParams) (db.AnalyticsUsersRow, error)
	AnalyticsWorkspaceBoot(ctx context.Context, arg db.AnalyticsWorkspaceBootParams) (db.AnalyticsWorkspaceBootRow, error)
	AnalyticsWorkspaceFailures(ctx context.Context, arg db.AnalyticsWorkspaceFailuresParams) ([]db.AnalyticsWorkspaceFailuresRow, error)
	AnalyticsWorkspacesActive(ctx context.Context, includeSynthetic bool) (int64, error)
	AnalyticsWorkspacesByDay(ctx context.Context, arg db.AnalyticsWorkspacesByDayParams) ([]db.AnalyticsWorkspacesByDayRow, error)
	AnalyticsWorkspacesByKindStatus(ctx context.Context, arg db.AnalyticsWorkspacesByKindStatusParams) ([]db.AnalyticsWorkspacesByKindStatusRow, error)
	FindAlertRemediationWorkflowRun(ctx context.Context, arg db.FindAlertRemediationWorkflowRunParams) (db.WorkflowRun, error)
	GetAgentSession(ctx context.Context, id string) (db.AgentSession, error)
	GetLandingQueueDepth(ctx context.Context) (int64, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetWorkflowDefinitionByPath(ctx context.Context, arg db.GetWorkflowDefinitionByPathParams) (db.WorkflowDefinition, error)
	GetWorkflowDefinitionNameByRunID(ctx context.Context, id int64) (string, error)
	GetWorkflowRunByRunID(ctx context.Context, id int64) (db.WorkflowRun, error)
	GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error)
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
	HasLegacyAlertRemediationWorkflowRun(ctx context.Context, arg db.HasLegacyAlertRemediationWorkflowRunParams) (bool, error)
	InsertAuditLog(ctx context.Context, arg db.InsertAuditLogParams) error
	InsertWorkflowLog(ctx context.Context, arg db.InsertWorkflowLogParams) (db.WorkflowLog, error)
	InsertWorkflowLogNextSequence(ctx context.Context, arg db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error)
	ListTaskStepInfoForRun(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error)
	ListWorkflowLogsSince(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error)
	NotifyAgentSession(ctx context.Context, arg db.NotifyAgentSessionParams) error
	NotifyWorkflowLog(ctx context.Context, arg db.NotifyWorkflowLogParams) error
	NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	NotifyWorkflowRunLog(ctx context.Context, arg db.NotifyWorkflowRunLogParams) error
	SkipBlockedWorkflowTask(ctx context.Context, id int64) error
	UnblockWorkflowTask(ctx context.Context, id int64) error
	UpdateAgentSessionTerminalStatus(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error)
	UpdateWorkflowRunStatusBasedOnTasks(ctx context.Context, workflowRunID int64) (string, error)
	UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error)
	UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
}

type IsStorageDeletionObjectActiveParams = db.IsStorageDeletionObjectActiveParams

func New(conn DBTX) Product { return db.New(conn) }

type GetRepoByOwnerAndNameParams = db.GetRepoByOwnerAndNameParams
type GetRepoByOwnerAndNameRow = db.GetRepoByOwnerAndNameRow
