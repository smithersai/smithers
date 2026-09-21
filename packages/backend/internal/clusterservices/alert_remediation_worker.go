package clusterservices

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/services"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services/alertregistry"
)

const (
	defaultAlertRemediationWorkerInterval   = 5 * time.Second
	defaultAlertRemediationWorkerClaimLimit = int32(5)

	// defaultAlertRemediationVisibilityTimeout bounds how long a job may sit
	// in 'processing' before it is considered abandoned by a crashed worker
	// and reclaimed by a later poll (#21).
	defaultAlertRemediationVisibilityTimeout = 15 * time.Minute

	// defaultAlertRemediationMaxAttempts caps how many times a job may be
	// claimed (initial claim + reclaims) before it is terminally failed
	// instead of reclaimed forever (#21).
	defaultAlertRemediationMaxAttempts = int32(3)

	// services.AlertRemediationTriggerEvent is the webhook trigger event dispatched for
	// remediation runs; remediate.tsx subscribes via on.webhook("monitoring_alert").
)

// AlertRemediationWorkerQuerier contains the DB methods needed by the worker.
type AlertRemediationWorkerQuerier interface {
	ClaimAlertRemediationJobs(ctx context.Context, arg db.ClaimAlertRemediationJobsParams) ([]db.AlertRemediationJob, error)
	FailTerminalAlertRemediationIncidents(ctx context.Context) ([]int64, error)
	FailExhaustedAlertRemediationJobs(ctx context.Context, arg db.FailExhaustedAlertRemediationJobsParams) ([]int64, error)
	FailCompletedLegacyAlertRemediationIncidents(ctx context.Context) ([]int64, error)
	MarkAlertRemediationJobDone(ctx context.Context, id int64) error
	RetryAlertRemediationJob(ctx context.Context, arg db.RetryAlertRemediationJobParams) (int64, error)
	FailAlertRemediationJobAndIncident(ctx context.Context, arg db.FailAlertRemediationJobAndIncidentParams) (bool, error)
	GetAlertIncident(ctx context.Context, id int64) (db.AlertIncident, error)
	UpdateAlertIncidentStateGuarded(ctx context.Context, arg db.UpdateAlertIncidentStateGuardedParams) (int64, error)
	GetWorkflowDefinitionByPath(ctx context.Context, arg db.GetWorkflowDefinitionByPathParams) (db.WorkflowDefinition, error)
	FindAlertRemediationWorkflowRun(ctx context.Context, arg db.FindAlertRemediationWorkflowRunParams) (db.WorkflowRun, error)
	HasLegacyAlertRemediationWorkflowRun(ctx context.Context, arg db.HasLegacyAlertRemediationWorkflowRunParams) (bool, error)
	BindAlertRemediationJobWorkflowRunAtAttempt(ctx context.Context, arg db.BindAlertRemediationJobWorkflowRunAtAttemptParams) (int64, error)
}

// AlertRemediationRunDispatcher creates workflow runs for remediation jobs.
type AlertRemediationRunDispatcher interface {
	DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
}

// AlertRemediationWorker polls alert_remediation_jobs and dispatches the
// registered remediation workflow (a webhook trigger with event
// "monitoring_alert") against the configured repository.
type AlertRemediationWorker struct {
	queries            AlertRemediationWorkerQuerier
	dispatcher         AlertRemediationRunDispatcher
	registry           *alertregistry.Registry
	repositoryID       int64
	repositoryFullName string
	logger             *slog.Logger
	interval           time.Duration
	claimLimit         int32
	visibilityTimeout  time.Duration
	maxAttempts        int32
}

// NewAlertRemediationWorker constructs the worker. repositoryID identifies the
// repository hosting the remediation workflow definitions (our own repo).
func NewAlertRemediationWorker(
	queries AlertRemediationWorkerQuerier,
	dispatcher AlertRemediationRunDispatcher,
	registry *alertregistry.Registry,
	repositoryID int64,
	repositoryFullName ...string,
) *AlertRemediationWorker {
	fullName := ""
	if len(repositoryFullName) > 0 {
		fullName = strings.TrimSpace(repositoryFullName[0])
	}
	return &AlertRemediationWorker{
		queries:            queries,
		dispatcher:         dispatcher,
		registry:           registry,
		repositoryID:       repositoryID,
		repositoryFullName: fullName,
		logger:             slog.Default(),
		interval:           defaultAlertRemediationWorkerInterval,
		claimLimit:         defaultAlertRemediationWorkerClaimLimit,
		visibilityTimeout:  defaultAlertRemediationVisibilityTimeout,
		maxAttempts:        defaultAlertRemediationMaxAttempts,
	}
}

// Start runs the polling loop until context cancellation.
func (w *AlertRemediationWorker) Start(ctx context.Context) {
	w.logger.Info("alert remediation worker started", "repository_id", w.repositoryID)
	for {
		if err := w.PollOnce(ctx); err != nil {
			if ctx.Err() != nil {
				w.logger.Info("alert remediation worker stopping", "reason", ctx.Err())
				return
			}
			w.logger.Error("alert remediation worker poll error", "error", err)
		}

		select {
		case <-ctx.Done():
			w.logger.Info("alert remediation worker stopped")
			return
		case <-time.After(w.interval):
		}
	}
}

// PollOnce claims and processes a batch of alert remediation jobs.
func (w *AlertRemediationWorker) PollOnce(ctx context.Context) error {
	if w == nil || w.queries == nil || w.dispatcher == nil {
		return nil
	}

	terminalIncidentIDs, err := w.queries.FailTerminalAlertRemediationIncidents(ctx)
	if err != nil {
		return fmt.Errorf("reconcile terminal alert remediation runs: %w", err)
	}
	for _, incidentID := range terminalIncidentIDs {
		w.logger.Error("alert remediation run terminated without an outcome callback", "incident_id", incidentID)
	}

	legacyIncidentIDs, err := w.queries.FailCompletedLegacyAlertRemediationIncidents(ctx)
	if err != nil {
		return fmt.Errorf("reconcile terminal legacy alert remediation runs: %w", err)
	}
	for _, incidentID := range legacyIncidentIDs {
		w.logger.Error("legacy alert remediation run terminated without a bound callback", "incident_id", incidentID)
	}

	// Terminalize jobs that have been reclaimed past their attempt budget
	// instead of leaving them to be reclaimed forever (#21).
	exhaustedIncidentIDs, err := w.queries.FailExhaustedAlertRemediationJobs(ctx, db.FailExhaustedAlertRemediationJobsParams{
		VisibilityTimeout: w.visibilityTimeout.Seconds(),
		MaxAttempts:       w.maxAttempts,
	})
	if err != nil {
		return fmt.Errorf("fail exhausted alert remediation jobs: %w", err)
	}
	for _, incidentID := range exhaustedIncidentIDs {
		w.logger.Error("alert remediation attempts exhausted; job and incident failed atomically", "incident_id", incidentID)
	}

	jobs, err := w.queries.ClaimAlertRemediationJobs(ctx, db.ClaimAlertRemediationJobsParams{
		Limit:             w.claimLimit,
		VisibilityTimeout: w.visibilityTimeout.Seconds(),
		MaxAttempts:       w.maxAttempts,
	})
	if err != nil {
		return fmt.Errorf("claim alert remediation jobs: %w", err)
	}

	for _, job := range jobs {
		if err := w.processJob(ctx, job); err != nil {
			w.handleProcessError(ctx, job, err)
		}
	}

	return nil
}

func (w *AlertRemediationWorker) handleProcessError(ctx context.Context, job db.AlertRemediationJob, processErr error) {
	errorMessage := strings.TrimSpace(processErr.Error())
	errorMessage = truncateAlertRemediationError(errorMessage, 4096)
	if job.Attempts < w.maxAttempts {
		retryDelay := alertRemediationRetryDelay(job.Attempts)
		rowsAffected, err := w.queries.RetryAlertRemediationJob(ctx, db.RetryAlertRemediationJobParams{
			ID:                job.ID,
			ExpectedAttempts:  job.Attempts,
			Error:             errorMessage,
			RetryAfterSeconds: retryDelay.Seconds(),
		})
		if err != nil {
			// Leave the row processing. Visibility-timeout recovery can retry this
			// exact job even when the immediate release lost its DB connection.
			w.logger.Error("failed to schedule alert remediation retry", "job_id", job.ID, "attempt", job.Attempts, "error", err, "process_error", processErr)
			return
		}
		if rowsAffected == 1 {
			w.logger.Warn("alert remediation job scheduled for retry", "job_id", job.ID, "attempt", job.Attempts, "retry_after", retryDelay, "error", processErr)
			return
		}
		w.logger.Warn("alert remediation retry ignored because claim generation changed", "job_id", job.ID, "attempt", job.Attempts, "error", processErr)
		return
	}

	failed, err := w.queries.FailAlertRemediationJobAndIncident(ctx, db.FailAlertRemediationJobAndIncidentParams{
		ID:               job.ID,
		ExpectedAttempts: job.Attempts,
		Error:            errorMessage,
	})
	if err != nil {
		// As above, retaining processing state is recoverable; a partially failed
		// job+incident transition is impossible because the DB method is atomic.
		w.logger.Error("failed to terminalize alert remediation job and incident", "job_id", job.ID, "attempt", job.Attempts, "error", err, "process_error", processErr)
		return
	}
	if failed {
		w.logger.Error("alert remediation job exhausted after processing error", "job_id", job.ID, "attempt", job.Attempts, "error", processErr)
		return
	}
	w.logger.Warn("alert remediation failure ignored because claim generation changed", "job_id", job.ID, "attempt", job.Attempts, "error", processErr)
}

func truncateAlertRemediationError(message string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	message = strings.ToValidUTF8(message, "�")
	if len(message) <= maxBytes {
		return message
	}
	message = message[:maxBytes]
	for !utf8.ValidString(message) {
		message = message[:len(message)-1]
	}
	return message
}

func alertRemediationRetryDelay(attempt int32) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := 5 * time.Second
	for i := int32(1); i < attempt && i < 6; i++ {
		delay *= 2
	}
	return delay
}

func (w *AlertRemediationWorker) processJob(ctx context.Context, job db.AlertRemediationJob) error {
	incident, err := w.queries.GetAlertIncident(ctx, job.IncidentID)
	if err != nil {
		return fmt.Errorf("load incident %d: %w", job.IncidentID, err)
	}

	switch incident.State {
	case "resolved", "failed":
		// Terminal: the incident already reached a final state through
		// another path (e.g. a resolved outcome report, or a "closed" GCP
		// notification). Dispatching now would resurrect it (#295).
		w.logger.Info("alert remediation job skipped: incident already terminal",
			"job_id", job.ID, "incident_id", incident.ID, "state", incident.State)
		if err := w.queries.MarkAlertRemediationJobDone(ctx, job.ID); err != nil {
			return fmt.Errorf("mark job done: %w", err)
		}
		return nil
	}

	// A run is either bound in the same transaction that creates it (new
	// protocol), or recoverable by the job's admission-time token (a commit
	// from the small pre-binding compatibility window). Do this before looking
	// at the mutable alert registry: disabling/removing a policy must not make
	// an already-committed run permanently invisible to reconciliation.
	if job.WorkflowRunID.Valid && job.WorkflowRunID.Int64 > 0 {
		w.ackDispatchedJob(ctx, job, incident, job.WorkflowRunID.Int64, "bound")
		return nil
	}
	existingRun, err := w.queries.FindAlertRemediationWorkflowRun(ctx, db.FindAlertRemediationWorkflowRunParams{
		JobID:         strconv.FormatInt(job.ID, 10),
		DispatchToken: []byte(job.DispatchToken),
	})
	if err == nil {
		w.ackDispatchedJob(ctx, job, incident, existingRun.ID, "recovered")
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("recover remediation workflow for job %d: %w", job.ID, err)
	}
	legacyRunExists, err := w.queries.HasLegacyAlertRemediationWorkflowRun(ctx, db.HasLegacyAlertRemediationWorkflowRunParams{
		IncidentRowID: strconv.FormatInt(incident.ID, 10),
		IncidentID:    incident.IncidentID,
	})
	if err != nil {
		return fmt.Errorf("check legacy remediation workflow for incident %d: %w", incident.ID, err)
	}
	if legacyRunExists {
		// A previous-version dispatcher can commit the run before updating the
		// incident from open to remediating. Token lookup cannot find that run;
		// the exact legacy identity marker is therefore a dispatch fence. The
		// poll-level legacy reconciler terminalizes the pair after the run ends.
		w.logger.Warn("alert remediation job has a legacy workflow run without a durable token",
			"job_id", job.ID, "incident_id", incident.ID)
		return nil
	}

	entry := w.registry.Lookup(incident.PolicyName)
	if entry == nil || !entry.Remediable {
		// Registry changed since enqueue: nothing to do, drop the job.
		if err := w.queries.MarkAlertRemediationJobDone(ctx, job.ID); err != nil {
			return fmt.Errorf("mark job done: %w", err)
		}
		return nil
	}

	workflowPath := strings.TrimSpace(incident.Workflow)
	if workflowPath == "" {
		workflowPath = entry.Workflow
	}
	def, err := w.queries.GetWorkflowDefinitionByPath(ctx, db.GetWorkflowDefinitionByPathParams{
		RepositoryID: w.repositoryID,
		Path:         workflowPath,
	})
	if err != nil {
		return fmt.Errorf("resolve remediation workflow %q in repository %d: %w", workflowPath, w.repositoryID, err)
	}

	if incident.State == "remediating" || incident.State == "pr_opened" {
		// Compatibility path for an incident dispatched before durable run
		// bindings existed. Never create a second run merely because its legacy
		// dispatch cannot be reconstructed.
		w.logger.Warn("alert remediation job has legacy dispatched state without a recoverable run",
			"job_id", job.ID, "incident_id", incident.ID, "state", incident.State)
		// Do not mark an unbound legacy job done while its old run is still
		// active. PollOnce's legacy reconciler keeps the incident admission lock
		// until every matching run is terminal, then fails both rows atomically.
		return nil
	}

	definitionID := def.ID
	event := services.TriggerEvent{
		Type:   services.AlertRemediationTriggerEvent,
		Action: "opened",
		Inputs: map[string]interface{}{
			"incident_row_id":            incident.ID,
			"incident_id":                incident.IncidentID,
			"remediation_job_id":         job.ID,
			"remediation_dispatch_token": job.DispatchToken,
			"policy_name":                entry.PolicyDisplayNamePrefix,
			"policy_slug":                normalizeAlertPolicySlug(entry.PolicyDisplayNamePrefix),
			"runbook":                    incident.Runbook,
			"remediation_repository":     w.repositoryFullName,
		},
	}
	results, err := w.dispatcher.DispatchForEvent(ctx, services.DispatchForEventInput{
		RepositoryID:         w.repositoryID,
		WorkflowDefinitionID: &definitionID,
		AlertRemediationBinding: &services.AlertRemediationRunBinding{
			JobID:            job.ID,
			IncidentRowID:    job.IncidentID,
			DispatchToken:    job.DispatchToken,
			ExpectedAttempts: job.Attempts,
		},
		Event: event,
	})
	if err != nil {
		// A stale claimant may have won the database uniqueness race after our
		// preflight lookup. Dispatch reports that insert conflict as an error, but
		// the winner is now durable and must be adopted instead of failing the job.
		if recovered, recoverErr := w.queries.FindAlertRemediationWorkflowRun(ctx, db.FindAlertRemediationWorkflowRunParams{
			JobID:         strconv.FormatInt(job.ID, 10),
			DispatchToken: []byte(job.DispatchToken),
		}); recoverErr == nil {
			w.ackDispatchedJob(ctx, job, incident, recovered.ID, "concurrent")
			return nil
		} else if !errors.Is(recoverErr, pgx.ErrNoRows) {
			return fmt.Errorf("dispatch remediation workflow %d: %w (recover committed run: %v)", definitionID, err, recoverErr)
		}
		return fmt.Errorf("dispatch remediation workflow %d: %w", definitionID, err)
	}
	if len(results) != 1 || results[0].WorkflowRunID <= 0 || results[0].WorkflowDefinitionID != definitionID {
		// Be defensive around a dispatcher that committed a run but lost/corrupted
		// its in-memory result. The persisted token remains the source of truth.
		if recovered, recoverErr := w.queries.FindAlertRemediationWorkflowRun(ctx, db.FindAlertRemediationWorkflowRunParams{
			JobID:         strconv.FormatInt(job.ID, 10),
			DispatchToken: []byte(job.DispatchToken),
		}); recoverErr == nil {
			w.ackDispatchedJob(ctx, job, incident, recovered.ID, "recovered-result")
			return nil
		} else if !errors.Is(recoverErr, pgx.ErrNoRows) {
			return fmt.Errorf("dispatch remediation workflow %d returned %d invalid runs (recover committed run: %v)", definitionID, len(results), recoverErr)
		}
		return fmt.Errorf("dispatch remediation workflow %d returned %d invalid runs", definitionID, len(results))
	}

	w.ackDispatchedJob(ctx, job, incident, results[0].WorkflowRunID, "new")
	return nil
}

// ackDispatchedJob durably binds the committed run before acknowledging the
// incident/job. If binding fails, the job intentionally remains processing;
// its stale-claim retry recovers the run from dispatch_inputs and retries the
// bind without dispatching another workflow.
func (w *AlertRemediationWorker) ackDispatchedJob(
	ctx context.Context,
	job db.AlertRemediationJob,
	incident db.AlertIncident,
	workflowRunID int64,
	dispatchKind string,
) {
	rowsAffected, err := w.queries.BindAlertRemediationJobWorkflowRunAtAttempt(ctx, db.BindAlertRemediationJobWorkflowRunAtAttemptParams{
		WorkflowRunID:    pgtype.Int8{Int64: workflowRunID, Valid: true},
		JobID:            job.ID,
		IncidentRowID:    job.IncidentID,
		DispatchToken:    job.DispatchToken,
		ExpectedAttempts: job.Attempts,
	})
	if err != nil || rowsAffected != 1 {
		w.logger.Error("post-dispatch: bind remediation workflow run failed; stale-claim recovery will retry",
			"job_id", job.ID, "incident_id", incident.ID, "workflow_run_id", workflowRunID,
			"dispatch_kind", dispatchKind, "rows_affected", rowsAffected, "error", err)
		return
	}

	if _, err := w.queries.UpdateAlertIncidentStateGuarded(ctx, db.UpdateAlertIncidentStateGuardedParams{
		ID:    incident.ID,
		State: "remediating",
	}); err != nil {
		w.logger.Error("post-dispatch: mark incident remediating failed; stale-claim reclaim will retry ack",
			"job_id", job.ID, "incident_id", incident.ID, "error", err)
		return
	}
	if err := w.queries.MarkAlertRemediationJobDone(ctx, job.ID); err != nil {
		w.logger.Error("post-dispatch: mark job done failed; job stays processing for reclaim",
			"job_id", job.ID, "incident_id", incident.ID, "error", err)
	}
}
