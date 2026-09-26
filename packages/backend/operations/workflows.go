package operations

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type AdminAuditActor = services.AdminAuditActor
type AuditQueries = services.AuditQueries
type AuditService = services.AuditService
type AuditEvent = services.AuditEvent
type AgentSessionEvent = services.AgentSessionEvent
type AlertRemediationRunBinding = services.AlertRemediationRunBinding
type GitHubCheckRunAnnotation = services.GitHubCheckRunAnnotation
type GitHubCheckRunOutput = services.GitHubCheckRunOutput
type GitHubCheckRunUpdate = services.GitHubCheckRunUpdate
type GitHubCheckRunService = services.GitHubCheckRunService
type GitHubRepositoryInstallationResolver = services.GitHubRepositoryInstallationResolver
type TriggerEvent = services.TriggerEvent
type WorkflowRunMetricsObserver = services.WorkflowRunMetricsObserver

const (
	AlertRemediationTriggerEvent = services.AlertRemediationTriggerEvent
	MaxInjectedEnvEntries        = services.MaxInjectedEnvEntries
	SecretEnvKeysRuntimeMarker   = services.SecretEnvKeysRuntimeMarker
)

func AdminAuditActorFromContext(ctx context.Context) (AdminAuditActor, bool) {
	return services.AdminAuditActorFromContext(ctx)
}
func ContextWithAdminAuditActor(ctx context.Context, actor AdminAuditActor) context.Context {
	return services.ContextWithAdminAuditActor(ctx, actor)
}
func NewAuditService(q AuditQueries) *AuditService { return services.NewAuditService(q) }
func ClampInt32(x int) int32                       { return services.ClampInt32(x) }
func UUIDString(u pgtype.UUID) string              { return services.UUIDString(u) }
func EvaluateIfExpression(expr string, event TriggerEvent, needs map[string]string) (bool, error) {
	return services.EvaluateIfExpression(expr, event, needs)
}
func IsInjectedSecretName(name string) bool { return services.IsInjectedSecretName(name) }
func IsTerminalWorkflowRunStatus(status string) bool {
	return services.IsTerminalWorkflowRunStatus(status)
}
func WorkflowRunStatusDescription(status string) string {
	return services.WorkflowRunStatusDescription(status)
}
func NormalizeTriggerName(name string) string { return services.NormalizeTriggerName(name) }
func RedactSecretValues(env map[string]string, text string) string {
	return services.RedactSecretValues(env, text)
}
func ResourceStoreError(err error, resource string) error {
	return services.ResourceStoreError(err, resource)
}
func LockWorkflowRun(ctx context.Context, tx pgx.Tx, runID int64) error {
	return services.LockWorkflowRun(ctx, tx, runID)
}
func ObserveWorkflowRunCompletion(observer WorkflowRunMetricsObserver, run db.WorkflowRun, status string) {
	services.ObserveWorkflowRunCompletion(observer, run, status)
}
func RevokeWorkflowRunCredentials(ctx context.Context, queries any, runID, repositoryID int64) {
	services.RevokeWorkflowRunCredentials(ctx, queries, runID, repositoryID)
}
func NotifyWorkflowRunEvent(ctx context.Context, notifier interface {
	NotifyWorkflowRunEvent(context.Context, db.NotifyWorkflowRunEventParams) error
}, runID int64, source string) {
	services.NotifyWorkflowRunEvent(ctx, notifier, runID, source)
}
