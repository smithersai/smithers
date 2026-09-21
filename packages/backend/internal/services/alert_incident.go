package services

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services/alertregistry"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MonitoringAlertIncident is the normalized subset of a GCP Cloud Monitoring
// webhook payload the remediation pipeline cares about. Parsed by
// routes.AlertWebhookHandler and consumed here.
type MonitoringAlertIncident struct {
	IncidentID    string
	PolicyName    string
	ConditionName string
	State         string
	Summary       string
	URL           string
}

// AlertRemediationOutcome is reported after a draft PR is opened or the
// workflow fails to prepare a fix.
type AlertRemediationOutcome struct {
	IncidentID string `json:"incident_id"`
	State      string `json:"state"`      // pr_opened | failed
	PrURL      string `json:"pr_url"`     // Backward-compatible artifact URL field.
	ReportURL  string `json:"report_url"` // Preferred artifact URL field.
}

// AlertRemediationTaskClaim is the signed runner-task identity that must still
// own the running task when the outcome update commits. Rechecking the claim in
// SQL closes the body-read window in which a task can be requeued or reclaimed
// after middleware authentication.
type AlertRemediationTaskClaim struct {
	TaskID   int64
	RunnerID int64
	Attempt  int32
}

// AlertIncidentQuerier contains the DB methods used by AlertIncidentService.
type AlertIncidentQuerier interface {
	IncrementActiveAlertIncident(ctx context.Context, arg db.IncrementActiveAlertIncidentParams) (int64, error)
	CreateAlertIncident(ctx context.Context, arg db.CreateAlertIncidentParams) (db.CreateAlertIncidentRow, error)
	ResolveAlertIncidentByIncidentID(ctx context.Context, incidentID string) error
	CountActiveAlertIncidentsForPolicy(ctx context.Context, arg db.CountActiveAlertIncidentsForPolicyParams) (int64, error)
	CountAlertRemediationJobsForPolicySince(ctx context.Context, arg db.CountAlertRemediationJobsForPolicySinceParams) (int64, error)
	CreateAlertRemediationJob(ctx context.Context, incidentID int64) (db.AlertRemediationJob, error)
	GetAlertIncidentByIncidentID(ctx context.Context, incidentID string) (db.AlertIncident, error)
	GetAlertIncident(ctx context.Context, id int64) (db.AlertIncident, error)
	AuthorizeAlertRemediationOutcomeRun(ctx context.Context, arg db.AuthorizeAlertRemediationOutcomeRunParams) (int64, error)
	RecordAlertIncidentRemediationOutcomeGuarded(ctx context.Context, arg db.RecordAlertIncidentRemediationOutcomeGuardedParams) (int64, error)
}

// alertIncidentTxQuerier is satisfied by *db.Queries. It lets admission
// (insert incident -> count active -> check cap -> enqueue job) run inside a
// single transaction serialized by a per-policy advisory lock, so two
// concurrent deliveries for the same policy cannot both observe "no active
// incident" and both enqueue a job (see issue #328).
type alertIncidentTxQuerier interface {
	AlertIncidentQuerier
	BeginTx(ctx context.Context) (pgx.Tx, error)
	WithTx(tx pgx.Tx) *db.Queries
}

// AlertIncidentService turns GCP Cloud Monitoring webhook notifications into
// alert_incidents rows and, when a policy is registered as auto-remediable,
// enqueues alert_remediation_jobs drained by AlertRemediationWorker.
type AlertIncidentService struct {
	queries  AlertIncidentQuerier
	registry *alertregistry.Registry
	logger   *slog.Logger
	now      func() time.Time
	// remediationEnabled gates only the ENQUEUE half of admission. Recording
	// the incident is unconditional: alert ingestion is how an operator (and
	// /api/admin/system/incidents) learns an alert fired at all, and it must
	// keep working when auto-remediation is deliberately fail-closed.
	remediationEnabled bool
}

// AlertIncidentOption customizes AlertIncidentService construction.
type AlertIncidentOption func(*AlertIncidentService)

// WithAlertRemediationEnabled turns automatic remediation enqueueing on or off
// without affecting incident recording. Pass false when no remediation worker
// is running, so jobs are not queued for a drainer that does not exist.
func WithAlertRemediationEnabled(enabled bool) AlertIncidentOption {
	return func(s *AlertIncidentService) { s.remediationEnabled = enabled }
}

// NewAlertIncidentService constructs the service. registry may come from
// alertregistry.Load(). Remediation enqueueing defaults to on; use
// WithAlertRemediationEnabled(false) when no worker will drain the queue.
func NewAlertIncidentService(queries AlertIncidentQuerier, registry *alertregistry.Registry, opts ...AlertIncidentOption) *AlertIncidentService {
	s := &AlertIncidentService{
		queries:            queries,
		registry:           registry,
		logger:             slog.Default(),
		now:                func() time.Time { return time.Now().UTC() },
		remediationEnabled: true,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// HandleAlertIncident implements the routes.AlertIncidentReceiver interface.
//
// Guardrails enforced here (in order):
//   - each delivery is recorded or deduped, even when remediation is disabled
//   - closed incidents only resolve existing rows, never enqueue work
//   - active deliveries with the same policy and condition refresh one incident
//   - unknown or non-remediable policies are recorded but never enqueued
//   - one active incident per policy may hold a remediation job (dedupe)
//   - maxAutoAttemptsPerDay from the registry caps enqueues per policy
func (s *AlertIncidentService) HandleAlertIncident(ctx context.Context, incident MonitoringAlertIncident) error {
	if s == nil || s.queries == nil {
		return nil
	}
	incident.State = strings.ToLower(strings.TrimSpace(incident.State))
	if incident.State != "open" && incident.State != "closed" {
		return pkgerrors.BadRequest("alert incident state must be open or closed")
	}

	entry := s.registry.Lookup(incident.PolicyName)
	runbook, workflow := "", ""
	if entry != nil {
		runbook = entry.Runbook
		workflow = entry.Workflow
	}

	txq, ok := s.queries.(alertIncidentTxQuerier)
	if !ok {
		// Unit-test fakes and any querier that doesn't support transactions
		// degrade to the unserialized path (existing behavior).
		return s.admitAndEnqueue(ctx, s.queries, incident, entry, runbook, workflow)
	}

	tx, err := txq.BeginTx(ctx)
	if err != nil {
		return fmt.Errorf("begin alert admission transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize insert->count->cap-check->enqueue per policy so two
	// concurrent deliveries for the same policy cannot both see "no active
	// incident" and both enqueue a job (#328). The insert must happen inside
	// this critical section: the second arriver's active-count must see the
	// first arriver's committed row.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('alert_admission:' || $1, 0))", incident.PolicyName); err != nil {
		return fmt.Errorf("lock alert admission for policy %q: %w", incident.PolicyName, err)
	}

	if err := s.admitAndEnqueue(ctx, txq.WithTx(tx), incident, entry, runbook, workflow); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit alert admission transaction: %w", err)
	}
	return nil
}

// admitAndEnqueue creates the incident row and, when the policy is
// auto-remediable and under its admission caps, enqueues a remediation job.
// It operates entirely on the passed querier so callers can run it either
// directly (unit-test fakes) or against a transaction-bound querier guarded
// by the per-policy advisory lock (see HandleAlertIncident).
func (s *AlertIncidentService) admitAndEnqueue(ctx context.Context, q AlertIncidentQuerier, incident MonitoringAlertIncident, entry *alertregistry.Entry, runbook, workflow string) error {
	if incident.State == "closed" {
		if err := q.ResolveAlertIncidentByIncidentID(ctx, incident.IncidentID); err != nil {
			return fmt.Errorf("resolve alert incident %s: %w", incident.IncidentID, err)
		}
		return nil
	}

	hits, err := q.IncrementActiveAlertIncident(ctx, db.IncrementActiveAlertIncidentParams{
		PolicyName: incident.PolicyName, ConditionName: incident.ConditionName,
		IncidentID: incident.IncidentID, Summary: incident.Summary,
	})
	if err != nil {
		return fmt.Errorf("dedupe alert incident %s: %w", incident.IncidentID, err)
	}
	if hits > 0 {
		return nil
	}

	row, err := q.CreateAlertIncident(ctx, db.CreateAlertIncidentParams{
		IncidentID:    incident.IncidentID,
		PolicyName:    incident.PolicyName,
		ConditionName: incident.ConditionName,
		Summary:       incident.Summary,
		IncidentUrl:   incident.URL,
		Runbook:       runbook,
		Workflow:      workflow,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// ON CONFLICT DO NOTHING → duplicate delivery; already recorded.
			return nil
		}
		return fmt.Errorf("create alert incident %s: %w", incident.IncidentID, err)
	}

	if !s.remediationEnabled {
		s.logger.Info("alert incident recorded; auto-remediation is disabled on this replica",
			"incident_id", incident.IncidentID,
			"policy", incident.PolicyName)
		return nil
	}

	if entry == nil || !entry.Remediable {
		s.logger.Info("alert incident recorded without remediation",
			"incident_id", incident.IncidentID,
			"policy", incident.PolicyName,
			"registered", entry != nil)
		return nil
	}

	active, err := q.CountActiveAlertIncidentsForPolicy(ctx, db.CountActiveAlertIncidentsForPolicyParams{
		PolicyName: incident.PolicyName,
		ID:         row.ID,
	})
	if err != nil {
		return fmt.Errorf("count active incidents for policy %q: %w", incident.PolicyName, err)
	}
	if active > 0 {
		s.logger.Info("alert remediation deduped: another incident for this policy is active",
			"incident_id", incident.IncidentID, "policy", incident.PolicyName)
		return nil
	}

	attempts, err := q.CountAlertRemediationJobsForPolicySince(ctx, db.CountAlertRemediationJobsForPolicySinceParams{
		PolicyName: incident.PolicyName,
		CreatedAt:  s.now().Add(-24 * time.Hour),
	})
	if err != nil {
		return fmt.Errorf("count remediation attempts for policy %q: %w", incident.PolicyName, err)
	}
	if attempts >= int64(entry.MaxAutoAttemptsPerDay) {
		s.logger.Warn("alert remediation skipped: daily auto-attempt cap reached",
			"incident_id", incident.IncidentID,
			"policy", incident.PolicyName,
			"attempts_last_24h", attempts,
			"max_per_day", entry.MaxAutoAttemptsPerDay)
		return nil
	}

	if _, err := q.CreateAlertRemediationJob(ctx, row.ID); err != nil {
		return fmt.Errorf("enqueue remediation job for incident %s: %w", incident.IncidentID, err)
	}
	s.logger.Info("alert remediation job enqueued",
		"incident_id", incident.IncidentID,
		"policy", incident.PolicyName,
		"workflow", workflow)
	return nil
}

// RecordRemediationOutcome persists the workflow-reported remediation result
// on the incident row (implements the routes.AlertIncidentReceiver interface).
func (s *AlertIncidentService) RecordRemediationOutcome(ctx context.Context, outcome AlertRemediationOutcome) error {
	if s == nil || s.queries == nil {
		return nil
	}
	state := strings.ToLower(strings.TrimSpace(outcome.State))
	if state != "resolved" && state != "failed" && state != "pr_opened" {
		// Client-caused bad input -> 4xx, not 500.
		return pkgerrors.BadRequest("invalid remediation outcome state")
	}
	artifactURL := strings.TrimSpace(outcome.ReportURL)
	if artifactURL == "" {
		artifactURL = strings.TrimSpace(outcome.PrURL)
	}
	row, err := s.queries.GetAlertIncidentByIncidentID(ctx, strings.TrimSpace(outcome.IncidentID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("alert incident not found")
		}
		return fmt.Errorf("load alert incident %s: %w", outcome.IncidentID, err)
	}
	return s.recordRemediationOutcome(ctx, row, outcome, state, artifactURL)
}

type alertRemediationDispatchIdentity struct {
	IncidentRowID            int64  `json:"incident_row_id"`
	IncidentID               string `json:"incident_id"`
	RemediationJobID         int64  `json:"remediation_job_id"`
	RemediationDispatchToken string `json:"remediation_dispatch_token"`
	RemediationRepository    string `json:"remediation_repository"`
}

// RecordWorkflowRemediationOutcome records an outcome only when the caller's
// verified workflow run is durably bound to the exact remediation job and
// incident. The task-token signature authenticates the run; dispatch_inputs
// provide server-written identity data that can be recovered after a worker
// stop between run commit and its best-effort acknowledgement.
func (s *AlertIncidentService) RecordWorkflowRemediationOutcome(ctx context.Context, run db.WorkflowRun, claim AlertRemediationTaskClaim, outcome AlertRemediationOutcome) error {
	if s == nil || s.queries == nil {
		return pkgerrors.Internal("alert remediation outcome store unavailable")
	}
	if claim.TaskID <= 0 || claim.RunnerID <= 0 || claim.Attempt <= 0 ||
		run.ID <= 0 || run.RepositoryID <= 0 || run.WorkflowDefinitionID <= 0 ||
		run.TriggerEvent != AlertRemediationTriggerEvent || run.ExecutionPlane != WorkflowRunPlaneRunner {
		return pkgerrors.Forbidden("workflow run is not authorized to report alert outcomes")
	}

	var identity alertRemediationDispatchIdentity
	if len(run.DispatchInputs) == 0 || json.Unmarshal(run.DispatchInputs, &identity) != nil {
		return pkgerrors.Forbidden("workflow run is not bound to an alert remediation job")
	}
	identity.IncidentID = strings.TrimSpace(identity.IncidentID)
	identity.RemediationDispatchToken = strings.TrimSpace(identity.RemediationDispatchToken)
	identity.RemediationRepository = strings.TrimSpace(identity.RemediationRepository)
	if identity.IncidentRowID <= 0 || identity.RemediationJobID <= 0 || identity.IncidentID == "" ||
		!isAlertRemediationDispatchToken(identity.RemediationDispatchToken) ||
		!isCanonicalGitHubRepository(identity.RemediationRepository) {
		return pkgerrors.Forbidden("workflow run has an invalid alert remediation binding")
	}
	if expected := strings.TrimSpace(outcome.IncidentID); expected == "" || expected != identity.IncidentID {
		return pkgerrors.Forbidden("workflow run does not belong to this alert incident")
	}

	state := strings.ToLower(strings.TrimSpace(outcome.State))
	var expectedJob string
	switch state {
	case "pr_opened":
		expectedJob = "publish"
	case "failed":
		expectedJob = "record-failure"
	default:
		return pkgerrors.BadRequest("invalid remediation outcome state")
	}
	artifactURL := ""
	if state == "pr_opened" {
		artifactURL = strings.TrimSpace(outcome.ReportURL)
		if artifactURL == "" {
			artifactURL = strings.TrimSpace(outcome.PrURL)
		}
		var valid bool
		artifactURL, valid = canonicalGitHubPullRequestURL(artifactURL, identity.RemediationRepository)
		if !valid {
			return pkgerrors.BadRequest("invalid remediation pull request url")
		}
	}

	rowsAffected, err := s.queries.AuthorizeAlertRemediationOutcomeRun(ctx, db.AuthorizeAlertRemediationOutcomeRunParams{
		JobID:                identity.RemediationJobID,
		IncidentRowID:        identity.IncidentRowID,
		DispatchToken:        identity.RemediationDispatchToken,
		WorkflowRunID:        pgtype.Int8{Int64: run.ID, Valid: true},
		TaskID:               claim.TaskID,
		RunnerID:             pgtype.Int8{Int64: claim.RunnerID, Valid: true},
		TaskAttempt:          claim.Attempt,
		ExpectedJob:          expectedJob,
		IncidentID:           identity.IncidentID,
		RepositoryID:         run.RepositoryID,
		WorkflowDefinitionID: run.WorkflowDefinitionID,
	})
	if err != nil {
		return fmt.Errorf("authorize remediation outcome workflow run %d: %w", run.ID, err)
	}
	if rowsAffected != 1 {
		return pkgerrors.Forbidden("workflow run is not authorized to report this alert outcome")
	}

	row, err := s.queries.GetAlertIncident(ctx, identity.IncidentRowID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("alert incident not found")
		}
		return fmt.Errorf("load alert incident %s: %w", identity.IncidentID, err)
	}
	if row.IncidentID != identity.IncidentID {
		return pkgerrors.Forbidden("workflow run does not belong to this alert incident")
	}
	return s.recordRemediationOutcome(ctx, row, outcome, state, artifactURL)
}

func isAlertRemediationDispatchToken(token string) bool {
	if len(token) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(token)
	return err == nil && len(decoded) == 32
}

func isCanonicalGitHubRepository(fullName string) bool {
	parts := strings.Split(fullName, "/")
	if len(parts) != 2 {
		return false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 100 {
			return false
		}
		for _, ch := range part {
			if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
				(ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' {
				continue
			}
			return false
		}
	}
	return true
}

func canonicalGitHubPullRequestURL(raw, repository string) (string, bool) {
	if !isCanonicalGitHubRepository(repository) {
		return "", false
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Host, "github.com") ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawPath != "" {
		return "", false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	repositoryParts := strings.Split(repository, "/")
	if len(parts) != 4 || !strings.EqualFold(parts[0], repositoryParts[0]) ||
		!strings.EqualFold(parts[1], repositoryParts[1]) || parts[2] != "pull" {
		return "", false
	}
	number, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil || number <= 0 {
		return "", false
	}
	return fmt.Sprintf("https://github.com/%s/pull/%d", repository, number), true
}

func (s *AlertIncidentService) recordRemediationOutcome(
	ctx context.Context,
	row db.AlertIncident,
	outcome AlertRemediationOutcome,
	state string,
	artifactURL string,
) error {
	rowsAffected, err := s.queries.RecordAlertIncidentRemediationOutcomeGuarded(ctx, db.RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID:               row.ID,
		State:            state,
		RemediationPrUrl: artifactURL,
	})
	if err != nil {
		return fmt.Errorf("record remediation outcome for incident %s: %w", outcome.IncidentID, err)
	}
	if rowsAffected == 0 {
		// The incident already resolved through another path (e.g. a prior
		// outcome report, or the runner's retry logic re-sending after a
		// transient network error masked an earlier success). Treat this as
		// an idempotent no-op rather than an error, so retried outcome
		// reports never fail (#295, and required so #343's now-strict runner
		// retry doesn't fail on a late duplicate report).
		s.logger.Info("remediation outcome ignored: incident already resolved",
			"incident_id", outcome.IncidentID, "reported_state", state)
	}
	return nil
}

// normalizeAlertPolicySlug is a convenience wrapper used by the worker.
func normalizeAlertPolicySlug(policyName string) string {
	return alertregistry.PolicySlug(strings.TrimSpace(policyName))
}
