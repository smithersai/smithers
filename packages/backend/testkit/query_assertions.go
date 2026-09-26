package testkit

import (
	"context"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// QueryAssertions exposes canonical queries only for private-schema regression tests.
// It owns no SQL and must never enter production composition.
type QueryAssertions interface {
	AdminSetUserSynthetic(ctx context.Context, arg db.AdminSetUserSyntheticParams) (db.User, error)
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
	CancelWorkflowRun(ctx context.Context, id int64) error
	CancelWorkflowTasks(ctx context.Context, workflowRunID int64) error
	ClaimStripeProcessedEvent(ctx context.Context, arg db.ClaimStripeProcessedEventParams) (string, error)
	ClaimWorkflowCacheDeletion(ctx context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCach, error)
	CloseOrphanedSandboxUsageIntervals(ctx context.Context) error
	CloseSandboxUsageInterval(ctx context.Context, arg db.CloseSandboxUsageIntervalParams) error
	CountActiveAgentSessionVMsForUser(ctx context.Context, userID int64) (int64, error)
	CountAgentRunsByOwner(ctx context.Context, arg db.CountAgentRunsByOwnerParams) (int64, error)
	CountCreditLedgerByAccount(ctx context.Context, billingAccountID int64) (int64, error)
	CountPrivateReposByOwner(ctx context.Context, arg db.CountPrivateReposByOwnerParams) (int64, error)
	CreateAgentSession(ctx context.Context, arg db.CreateAgentSessionParams) (db.AgentSession, error)
	CreateCommitStatus(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error)
	CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error)
	CreateLandingRequest(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error)
	CreateRepo(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error)
	CreateWorkflowDefinition(ctx context.Context, arg db.CreateWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	CreateWorkflowRun(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error)
	CreateWorkflowStep(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error)
	CreateWorkflowTask(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error)
	DeactivateBillingEntitlementsByAccount(ctx context.Context, billingAccountID int64) error
	DeleteClaimedWorkflowCache(ctx context.Context, arg db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCach, error)
	DeleteExpiredLFSUploadReservation(ctx context.Context, arg db.DeleteExpiredLFSUploadReservationParams) (int64, error)
	DeleteLFSUploadReservation(ctx context.Context, arg db.DeleteLFSUploadReservationParams) error
	DeleteRepo(ctx context.Context, id int64) error
	DeleteStripeProcessedEvent(ctx context.Context, eventID string) error
	FindAlertRemediationWorkflowRun(ctx context.Context, arg db.FindAlertRemediationWorkflowRunParams) (db.WorkflowRun, error)
	GetBillingAccountByOwner(ctx context.Context, arg db.GetBillingAccountByOwnerParams) (db.BillingAccount, error)
	GetBillingAccountByStripeCustomerID(ctx context.Context, stripeCustomerID string) (db.BillingAccount, error)
	GetCreditLedgerByIdempotencyKey(ctx context.Context, arg db.GetCreditLedgerByIdempotencyKeyParams) (db.BillingCreditLedger, error)
	GetLatestBillingSubscriptionByAccount(ctx context.Context, billingAccountID int64) (db.BillingSubscription, error)
	GetLatestLiveBillingSubscriptionByAccount(ctx context.Context, billingAccountID int64) (db.BillingSubscription, error)
	GetUsageCounterByMetric(ctx context.Context, arg db.GetUsageCounterByMetricParams) (db.BillingUsageCounter, error)
	GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	GetWorkflowRunByRunID(ctx context.Context, id int64) (db.WorkflowRun, error)
	GetWorkflowTask(ctx context.Context, arg db.GetWorkflowTaskParams) (db.WorkflowTask, error)
	HasLegacyAlertRemediationWorkflowRun(ctx context.Context, arg db.HasLegacyAlertRemediationWorkflowRunParams) (bool, error)
	IncrementUsageCounter(ctx context.Context, arg db.IncrementUsageCounterParams) (db.BillingUsageCounter, error)
	InsertCreditLedgerEntry(ctx context.Context, arg db.InsertCreditLedgerEntryParams) (db.BillingCreditLedger, error)
	IsStorageDeletionObjectActive(ctx context.Context, arg db.IsStorageDeletionObjectActiveParams) (bool, error)
	ListAllActiveBillingAccounts(ctx context.Context) ([]db.BillingAccount, error)
	ListBillingEntitlementsByAccount(ctx context.Context, billingAccountID int64) ([]db.BillingEntitlement, error)
	ListBillingSubscriptionsByAccount(ctx context.Context, billingAccountID int64) ([]db.BillingSubscription, error)
	ListBillingUsageCountersByOwnerAndPeriod(ctx context.Context, arg db.ListBillingUsageCountersByOwnerAndPeriodParams) ([]db.BillingUsageCounter, error)
	ListCreditLedgerByAccount(ctx context.Context, arg db.ListCreditLedgerByAccountParams) ([]db.BillingCreditLedger, error)
	ListWorkflowDefinitionsByRepo(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error)
	ListWorkflowRunsByRepo(ctx context.Context, arg db.ListWorkflowRunsByRepoParams) ([]db.WorkflowRun, error)
	MarkWorkflowTaskVMRunning(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error)
	NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	OpenSandboxUsageInterval(ctx context.Context, arg db.OpenSandboxUsageIntervalParams) error
	ResumeWorkflowRun(ctx context.Context, id int64) error
	ResumeWorkflowTasks(ctx context.Context, workflowRunID int64) error
	SumSandboxAwakeSecondsForUserSince(ctx context.Context, userID int64, since time.Time) (int64, error)
	SumWorkflowMinutesByOwner(ctx context.Context, arg db.SumWorkflowMinutesByOwnerParams) (int64, error)
	UpdateWorkflowRunStatusBasedOnTasks(ctx context.Context, workflowRunID int64) (string, error)
	UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error)
	UpsertAgentWorkflowDefinition(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error)
	UpsertBillingAccount(ctx context.Context, arg db.UpsertBillingAccountParams) (db.BillingAccount, error)
	UpsertBillingEntitlement(ctx context.Context, arg db.UpsertBillingEntitlementParams) (db.BillingEntitlement, error)
	UpsertBillingSubscription(ctx context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error)
	UpsertBillingUsageCounter(ctx context.Context, arg db.UpsertBillingUsageCounterParams) (db.BillingUsageCounter, error)
	UpsertLFSUploadReservation(ctx context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error)
	UpsertWorkflowDefinition(ctx context.Context, arg db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error)
}

func DatabaseQueries(t testing.TB, conn DBTX) QueryAssertions { t.Helper(); return db.New(conn) }

type AdminSetUserSyntheticParams = db.AdminSetUserSyntheticParams
type AnalyticsAgentsByStatusParams = db.AnalyticsAgentsByStatusParams
type AnalyticsAgentsParams = db.AnalyticsAgentsParams
type AnalyticsImportFailuresParams = db.AnalyticsImportFailuresParams
type AnalyticsImportsByStatusParams = db.AnalyticsImportsByStatusParams
type AnalyticsImportsFailedByStageParams = db.AnalyticsImportsFailedByStageParams
type AnalyticsLandingByStateParams = db.AnalyticsLandingByStateParams
type AnalyticsLandingCycleParams = db.AnalyticsLandingCycleParams
type AnalyticsLandingParams = db.AnalyticsLandingParams
type AnalyticsReposParams = db.AnalyticsReposParams
type AnalyticsSignupsByDayParams = db.AnalyticsSignupsByDayParams
type AnalyticsStuckAgentsParams = db.AnalyticsStuckAgentsParams
type AnalyticsTopReposParams = db.AnalyticsTopReposParams
type AnalyticsUsersParams = db.AnalyticsUsersParams
type AnalyticsWorkspaceBootParams = db.AnalyticsWorkspaceBootParams
type AnalyticsWorkspaceFailuresParams = db.AnalyticsWorkspaceFailuresParams
type AnalyticsWorkspacesByDayParams = db.AnalyticsWorkspacesByDayParams
type AnalyticsWorkspacesByKindStatusParams = db.AnalyticsWorkspacesByKindStatusParams
type BillingAccount = db.BillingAccount
type ClaimStripeProcessedEventParams = db.ClaimStripeProcessedEventParams
type ClaimWorkflowCacheDeletionParams = db.ClaimWorkflowCacheDeletionParams
type CloseSandboxUsageIntervalParams = db.CloseSandboxUsageIntervalParams
type CountAgentRunsByOwnerParams = db.CountAgentRunsByOwnerParams
type CountPrivateReposByOwnerParams = db.CountPrivateReposByOwnerParams
type CreateAgentSessionParams = db.CreateAgentSessionParams
type CreateCommitStatusParams = db.CreateCommitStatusParams
type CreateIssueParams = db.CreateIssueParams
type CreateLandingRequestParams = db.CreateLandingRequestParams
type CreateRepoParams = db.CreateRepoParams
type DBTX = db.DBTX
type DeleteClaimedWorkflowCacheParams = db.DeleteClaimedWorkflowCacheParams
type DeleteExpiredLFSUploadReservationParams = db.DeleteExpiredLFSUploadReservationParams
type DeleteLFSUploadReservationParams = db.DeleteLFSUploadReservationParams
type FindAlertRemediationWorkflowRunParams = db.FindAlertRemediationWorkflowRunParams
type GetBillingAccountByOwnerParams = db.GetBillingAccountByOwnerParams
type GetCreditLedgerByIdempotencyKeyParams = db.GetCreditLedgerByIdempotencyKeyParams
type GetUsageCounterByMetricParams = db.GetUsageCounterByMetricParams
type GetWorkflowRunParams = db.GetWorkflowRunParams
type GetWorkflowTaskParams = db.GetWorkflowTaskParams
type HasLegacyAlertRemediationWorkflowRunParams = db.HasLegacyAlertRemediationWorkflowRunParams
type IncrementUsageCounterParams = db.IncrementUsageCounterParams
type InsertCreditLedgerEntryParams = db.InsertCreditLedgerEntryParams
type IsStorageDeletionObjectActiveParams = db.IsStorageDeletionObjectActiveParams
type Issue = db.Issue
type LandingRequest = db.LandingRequest
type ListBillingUsageCountersByOwnerAndPeriodParams = db.ListBillingUsageCountersByOwnerAndPeriodParams
type ListCreditLedgerByAccountParams = db.ListCreditLedgerByAccountParams
type ListWorkflowDefinitionsByRepoParams = db.ListWorkflowDefinitionsByRepoParams
type ListWorkflowRunsByRepoParams = db.ListWorkflowRunsByRepoParams
type MarkWorkflowTaskVMRunningParams = db.MarkWorkflowTaskVMRunningParams
type NotifyWorkflowRunEventParams = db.NotifyWorkflowRunEventParams
type OpenSandboxUsageIntervalParams = db.OpenSandboxUsageIntervalParams
type Release = db.Release
type SumStorageBytesByOwnerParams = db.SumStorageBytesByOwnerParams
type SumWorkflowMinutesByOwnerParams = db.SumWorkflowMinutesByOwnerParams
type UpsertBillingAccountParams = db.UpsertBillingAccountParams
type UpsertBillingEntitlementParams = db.UpsertBillingEntitlementParams
type UpsertBillingSubscriptionParams = db.UpsertBillingSubscriptionParams
type UpsertBillingUsageCounterParams = db.UpsertBillingUsageCounterParams
type UpsertLFSUploadReservationParams = db.UpsertLFSUploadReservationParams
type UpsertWorkflowDefinitionParams = db.UpsertWorkflowDefinitionParams
type WorkflowRun = db.WorkflowRun
type WorkflowTask = db.WorkflowTask
