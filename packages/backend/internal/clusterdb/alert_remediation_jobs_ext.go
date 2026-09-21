package clusterdb

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
)

const bindAlertRemediationJobWorkflowRunAtAttempt = `
UPDATE alert_remediation_jobs
SET workflow_run_id = $1,
    updated_at = NOW()
WHERE id = $2
  AND incident_id = $3
  AND dispatch_token = $4
  AND status = 'processing'
  AND attempts = $5
  AND (workflow_run_id IS NULL OR workflow_run_id = $1)
`

type BindAlertRemediationJobWorkflowRunAtAttemptParams struct {
	WorkflowRunID    pgtype.Int8 `json:"workflow_run_id"`
	JobID            int64       `json:"job_id"`
	IncidentRowID    int64       `json:"incident_row_id"`
	DispatchToken    string      `json:"dispatch_token"`
	ExpectedAttempts int32       `json:"expected_attempts"`
}

// BindAlertRemediationJobWorkflowRunAtAttempt binds a run only to the claim
// generation that dispatched it. WorkflowRunService calls this inside the
// same transaction that inserts the run, so a stale claimant can neither
// terminalize the job around an unbound commit nor let an expired dispatcher
// attach a late run to a newer attempt.
func (q *Queries) BindAlertRemediationJobWorkflowRunAtAttempt(ctx context.Context, arg BindAlertRemediationJobWorkflowRunAtAttemptParams) (int64, error) {
	tag, err := q.db.Exec(ctx,
		bindAlertRemediationJobWorkflowRunAtAttempt,
		arg.WorkflowRunID,
		arg.JobID,
		arg.IncidentRowID,
		arg.DispatchToken,
		arg.ExpectedAttempts,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const claimAlertRemediationJobs = `
WITH claimed AS (
	SELECT id
	FROM alert_remediation_jobs
	WHERE (
		(status = 'pending' AND available_at <= NOW())
		OR (status = 'processing' AND updated_at < NOW() - make_interval(secs => $2))
	)
	AND attempts < $3
	ORDER BY available_at ASC, id ASC
	FOR UPDATE SKIP LOCKED
	LIMIT $1
)
UPDATE alert_remediation_jobs j
SET status = 'processing',
    attempts = j.attempts + 1,
    updated_at = NOW()
FROM claimed
WHERE j.id = claimed.id
RETURNING j.id, j.incident_id, j.status, j.attempts, j.error,
          j.available_at, j.processed_at, j.created_at, j.updated_at,
          j.dispatch_token, j.workflow_run_id
`

// ClaimAlertRemediationJobsParams controls both the pending-job claim and the
// stale-processing reclaim (a worker that crashed or was killed after
// claiming a job leaves it stuck in 'processing' forever otherwise; see
// issue #21).
type ClaimAlertRemediationJobsParams struct {
	Limit             int32
	VisibilityTimeout float64 // seconds; jobs stuck in 'processing' longer than this are reclaimed
	MaxAttempts       int32
}

// ClaimAlertRemediationJobs atomically claims alert remediation jobs using
// FOR UPDATE SKIP LOCKED so concurrent workers do not double-process the same
// job. It claims two kinds of rows in one pass:
//   - pending jobs whose available_at has elapsed (the normal case), and
//   - processing jobs whose updated_at is older than VisibilityTimeout (a
//     stale claim left behind by a crashed worker).
//
// Jobs that have already reached MaxAttempts are excluded; those are
// terminalized separately by FailExhaustedAlertRemediationJobs.
func (q *Queries) ClaimAlertRemediationJobs(ctx context.Context, arg ClaimAlertRemediationJobsParams) ([]AlertRemediationJob, error) {
	rows, err := q.db.Query(ctx, claimAlertRemediationJobs, arg.Limit, arg.VisibilityTimeout, arg.MaxAttempts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]AlertRemediationJob, 0)
	for rows.Next() {
		var item AlertRemediationJob
		if err := rows.Scan(
			&item.ID,
			&item.IncidentID,
			&item.Status,
			&item.Attempts,
			&item.Error,
			&item.AvailableAt,
			&item.ProcessedAt,
			&item.CreatedAt,
			&item.UpdatedAt,
			&item.DispatchToken,
			&item.WorkflowRunID,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

const markAlertRemediationJobDone = `
UPDATE alert_remediation_jobs
SET status = 'done',
    error = '',
    processed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status = 'processing'
`

// MarkAlertRemediationJobDone marks a job done. The status='processing'
// guard ensures a stale-claimed job that was already reclaimed and
// terminalized elsewhere cannot be silently resurrected as done (#324).
func (q *Queries) MarkAlertRemediationJobDone(ctx context.Context, id int64) error {
	_, err := q.db.Exec(ctx, markAlertRemediationJobDone, id)
	return err
}

const markAlertRemediationJobFailed = `
UPDATE alert_remediation_jobs
SET status = 'failed',
    error = $2,
    processed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status = 'processing'
`

type MarkAlertRemediationJobFailedParams struct {
	ID    int64  `json:"id"`
	Error string `json:"error"`
}

// MarkAlertRemediationJobFailed marks a job failed. The status='processing'
// guard mirrors MarkAlertRemediationJobDone (#324).
func (q *Queries) MarkAlertRemediationJobFailed(ctx context.Context, arg MarkAlertRemediationJobFailedParams) error {
	_, err := q.db.Exec(ctx, markAlertRemediationJobFailed, arg.ID, strings.TrimSpace(arg.Error))
	return err
}

const retryAlertRemediationJob = `
UPDATE alert_remediation_jobs
SET status = 'pending',
    error = $3,
    available_at = NOW() + make_interval(secs => $4),
    updated_at = NOW()
WHERE id = $1
  AND status = 'processing'
  AND attempts = $2
`

type RetryAlertRemediationJobParams struct {
	ID                int64   `json:"id"`
	ExpectedAttempts  int32   `json:"expected_attempts"`
	Error             string  `json:"error"`
	RetryAfterSeconds float64 `json:"retry_after_seconds"`
}

// RetryAlertRemediationJob releases one exact claim generation for bounded
// backoff. The attempts fence prevents an expired worker from requeueing a job
// that a newer claimant is already processing.
func (q *Queries) RetryAlertRemediationJob(ctx context.Context, arg RetryAlertRemediationJobParams) (int64, error) {
	tag, err := q.db.Exec(ctx, retryAlertRemediationJob,
		arg.ID,
		arg.ExpectedAttempts,
		strings.TrimSpace(arg.Error),
		arg.RetryAfterSeconds,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const failAlertRemediationJobAndIncident = `
WITH failed_job AS (
	UPDATE alert_remediation_jobs AS j
	SET status = 'failed',
	    error = $3,
	    processed_at = NOW(),
	    updated_at = NOW()
	WHERE j.id = $1
	  AND j.status = 'processing'
	  AND j.attempts = $2
	  AND NOT EXISTS (
	      SELECT 1
	      FROM workflow_runs AS wr
	      WHERE wr.trigger_event = 'monitoring_alert'
	        AND wr.execution_plane = 'runner'
	        AND wr.status NOT IN ('success', 'failure', 'cancelled')
	        AND (
	          (
	            wr.dispatch_inputs ->> 'remediation_job_id' = j.id::text
	            AND wr.dispatch_inputs ->> 'remediation_dispatch_token' = j.dispatch_token
	          )
	          OR (
	            NOT (wr.dispatch_inputs ? 'remediation_dispatch_token')
	            AND wr.dispatch_inputs ->> 'incident_row_id' = j.incident_id::text
	          )
	        )
	  )
	RETURNING incident_id
), failed_incident AS (
	UPDATE alert_incidents i
	SET state = 'failed',
	    updated_at = NOW()
	WHERE i.id IN (SELECT incident_id FROM failed_job)
	  AND i.state IN ('open', 'remediating')
	RETURNING i.id
)
SELECT EXISTS (SELECT 1 FROM failed_job)
`

type FailAlertRemediationJobAndIncidentParams struct {
	ID               int64  `json:"id"`
	ExpectedAttempts int32  `json:"expected_attempts"`
	Error            string `json:"error"`
}

// FailAlertRemediationJobAndIncident terminalizes one exact claim generation
// and its still-active incident in a single statement. Resolved incidents are
// preserved, and an expired worker cannot fail a newer attempt.
func (q *Queries) FailAlertRemediationJobAndIncident(ctx context.Context, arg FailAlertRemediationJobAndIncidentParams) (bool, error) {
	var failed bool
	err := q.db.QueryRow(ctx, failAlertRemediationJobAndIncident,
		arg.ID,
		arg.ExpectedAttempts,
		strings.TrimSpace(arg.Error),
	).Scan(&failed)
	return failed, err
}

const failExhaustedAlertRemediationJobs = `
WITH failed_jobs AS (
	UPDATE alert_remediation_jobs AS j
	SET status = 'failed',
	    error = 'exceeded max remediation attempts after stale claim',
	    processed_at = NOW(),
	    updated_at = NOW()
	WHERE j.status = 'processing'
	  AND j.updated_at < NOW() - make_interval(secs => $1)
	  AND j.attempts >= $2
	  AND NOT EXISTS (
	      SELECT 1
	      FROM workflow_runs AS wr
	      WHERE wr.trigger_event = 'monitoring_alert'
	        AND wr.execution_plane = 'runner'
	        AND wr.status NOT IN ('success', 'failure', 'cancelled')
	        AND (
	          (
	            wr.dispatch_inputs ->> 'remediation_job_id' = j.id::text
	            AND wr.dispatch_inputs ->> 'remediation_dispatch_token' = j.dispatch_token
	          )
	          OR (
	            NOT (wr.dispatch_inputs ? 'remediation_dispatch_token')
	            AND wr.dispatch_inputs ->> 'incident_row_id' = j.incident_id::text
	          )
	        )
	  )
	RETURNING incident_id
), failed_incidents AS (
	UPDATE alert_incidents i
	SET state = 'failed',
	    updated_at = NOW()
	WHERE i.id IN (SELECT incident_id FROM failed_jobs)
	  AND i.state IN ('open', 'remediating')
	RETURNING i.id
)
SELECT id FROM failed_incidents
`

// FailExhaustedAlertRemediationJobsParams controls terminalization of jobs
// that have been reclaimed too many times to be worth retrying again (#21).
type FailExhaustedAlertRemediationJobsParams struct {
	VisibilityTimeout float64 // seconds
	MaxAttempts       int32
}

// FailExhaustedAlertRemediationJobs terminally fails jobs that are stuck in
// 'processing' past the visibility timeout and have already exhausted their
// attempt budget, instead of reclaiming them forever. The same statement
// atomically fails each still-active incident, avoiding a permanently stranded
// incident if a separate best-effort state update loses its connection after
// the job becomes terminal. It returns incidents actually transitioned.
func (q *Queries) FailExhaustedAlertRemediationJobs(ctx context.Context, arg FailExhaustedAlertRemediationJobsParams) ([]int64, error) {
	rows, err := q.db.Query(ctx, failExhaustedAlertRemediationJobs, arg.VisibilityTimeout, arg.MaxAttempts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	incidentIDs := make([]int64, 0)
	for rows.Next() {
		var incidentID int64
		if err := rows.Scan(&incidentID); err != nil {
			return nil, err
		}
		incidentIDs = append(incidentIDs, incidentID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return incidentIDs, nil
}

const failCompletedLegacyAlertRemediationIncidents = `
WITH terminal_legacy_jobs AS (
	SELECT j.id, j.incident_id
	FROM alert_remediation_jobs AS j
	JOIN alert_incidents AS i ON i.id = j.incident_id
	WHERE j.workflow_run_id IS NULL
	  AND j.status IN ('processing', 'done', 'failed')
	  AND i.state IN ('open', 'remediating')
	  AND EXISTS (
	      SELECT 1
	      FROM workflow_runs AS wr
	      WHERE wr.trigger_event = 'monitoring_alert'
	        AND wr.execution_plane = 'runner'
	        AND NOT (wr.dispatch_inputs ? 'remediation_dispatch_token')
	        AND wr.dispatch_inputs ->> 'incident_row_id' = i.id::text
	        AND wr.dispatch_inputs ->> 'incident_id' = i.incident_id
	  )
	  AND NOT EXISTS (
	      SELECT 1
	      FROM workflow_runs AS wr
	      WHERE wr.trigger_event = 'monitoring_alert'
	        AND wr.execution_plane = 'runner'
	        AND wr.status NOT IN ('success', 'failure', 'cancelled')
	        AND NOT (wr.dispatch_inputs ? 'remediation_dispatch_token')
	        AND wr.dispatch_inputs ->> 'incident_row_id' = i.id::text
	        AND wr.dispatch_inputs ->> 'incident_id' = i.incident_id
	  )
	FOR UPDATE OF j, i
), failed_jobs AS (
	UPDATE alert_remediation_jobs AS j
	SET status = 'failed',
	    error = 'legacy remediation run terminated without a bound outcome callback',
	    processed_at = COALESCE(j.processed_at, NOW()),
	    updated_at = NOW()
	FROM terminal_legacy_jobs AS legacy
	WHERE j.id = legacy.id
	RETURNING legacy.incident_id
), failed_incidents AS (
	UPDATE alert_incidents AS i
	SET state = 'failed',
	    updated_at = NOW()
	WHERE i.id IN (SELECT incident_id FROM failed_jobs)
	  AND i.state IN ('open', 'remediating')
	RETURNING i.id
)
SELECT id FROM failed_incidents
`

// FailCompletedLegacyAlertRemediationIncidents reconciles runs created by an
// old API replica during the one-time protocol rollout. Those runs predate
// dispatch tokens and cannot use the exact-bound callback. While any matching
// legacy run is active, the incident stays active and blocks fresh admission;
// once all matching runs are terminal, the job and incident fail atomically.
func (q *Queries) FailCompletedLegacyAlertRemediationIncidents(ctx context.Context) ([]int64, error) {
	rows, err := q.db.Query(ctx, failCompletedLegacyAlertRemediationIncidents)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	incidentIDs := make([]int64, 0)
	for rows.Next() {
		var incidentID int64
		if err := rows.Scan(&incidentID); err != nil {
			return nil, err
		}
		incidentIDs = append(incidentIDs, incidentID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return incidentIDs, nil
}
