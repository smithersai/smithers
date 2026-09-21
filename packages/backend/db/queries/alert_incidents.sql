-- name: CreateAlertIncident :one
-- An already-associated delivery must never create a new canonical incident.
WITH created AS (
    INSERT INTO alert_incidents (
        incident_id, policy_name, condition_name, state, summary, incident_url, runbook, workflow, source
    )
    SELECT $1, $2, $3, 'open', $4, $5, $6, $7,
           CASE WHEN $1 LIKE 'canary-%' THEN 'canary' ELSE 'monitoring' END
    WHERE NOT EXISTS (SELECT 1 FROM alert_incident_deliveries WHERE incident_id = $1)
    ON CONFLICT (incident_id) DO NOTHING
    RETURNING *
), recorded AS (
    INSERT INTO alert_incident_deliveries (incident_id, canonical_incident_id)
    SELECT incident_id, id FROM created
)
SELECT * FROM created;

-- name: GetAlertIncident :one
SELECT * FROM alert_incidents WHERE id = $1;

-- name: GetAlertIncidentByIncidentID :one
SELECT * FROM alert_incidents WHERE incident_id = $1;

-- name: CountActiveAlertIncidentsForPolicy :one
SELECT COUNT(*) FROM alert_incidents
WHERE policy_name = $1
  AND state IN ('open', 'remediating', 'pr_opened')
  AND id <> $2;

-- name: CountAlertRemediationJobsForPolicySince :one
SELECT COUNT(*)
FROM alert_remediation_jobs j
JOIN alert_incidents i ON i.id = j.incident_id
WHERE i.policy_name = $1
  AND j.created_at >= $2;

-- name: UpdateAlertIncidentState :exec
UPDATE alert_incidents
SET state = $2,
    resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END,
    updated_at = NOW()
WHERE id = $1;

-- name: ResolveAlertIncidentByIncidentID :exec
-- Run under the admission lock. CTEs share a snapshot, so exclude this delivery
-- explicitly when checking for other live occurrences. Unknown closes retain
-- a tombstone to prevent a delayed open from resurrecting the incident.
WITH closed AS (
    UPDATE alert_incident_deliveries
    SET closed_at = COALESCE(closed_at, now())
    WHERE alert_incident_deliveries.incident_id = $1
    RETURNING canonical_incident_id
), resolved AS (
    UPDATE alert_incidents
    SET state = 'resolved', resolved_at = COALESCE(resolved_at, now()), updated_at = now()
    WHERE id IN (SELECT canonical_incident_id FROM closed)
      AND state IN ('open', 'remediating', 'pr_opened')
      AND NOT EXISTS (
          SELECT 1 FROM alert_incident_deliveries AS other
          WHERE other.canonical_incident_id = alert_incidents.id
            AND other.incident_id <> $1 AND other.closed_at IS NULL
      )
), tombstone AS (
    INSERT INTO alert_incidents (
        incident_id, policy_name, condition_name, state, summary,
        incident_url, runbook, workflow, resolved_at, source
    )
    SELECT $1, '', '', 'resolved', '', '', '', '', now(),
           CASE WHEN $1 LIKE 'canary-%' THEN 'canary' ELSE 'monitoring' END
    WHERE NOT EXISTS (SELECT 1 FROM closed)
    ON CONFLICT (incident_id) DO NOTHING
    RETURNING id, incident_id
)
INSERT INTO alert_incident_deliveries (incident_id, canonical_incident_id, closed_at)
SELECT incident_id, id, now() FROM tombstone;

-- name: RecordAlertIncidentRemediationOutcome :exec
UPDATE alert_incidents
SET state = $2,
    remediation_pr_url = $3,
    attempts = attempts + 1,
    resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END,
    updated_at = NOW()
WHERE id = $1;

-- name: CreateAlertRemediationJob :one
INSERT INTO alert_remediation_jobs (incident_id)
VALUES ($1)
RETURNING id,
          incident_id,
          status,
          attempts,
          error,
          available_at,
          processed_at,
          created_at,
          updated_at,
          dispatch_token,
          workflow_run_id;

-- name: FindAlertRemediationWorkflowRun :one
-- Recover a committed dispatch after a worker stops before it can bind the run
-- ID back to the job. The unguessable token was allocated with the job, before
-- dispatch, so a retry adopts the original run instead of creating another.
SELECT wr.*
FROM workflow_runs AS wr
WHERE wr.trigger_event = 'monitoring_alert'
  AND wr.execution_plane = 'runner'
  AND wr.dispatch_inputs ->> 'remediation_job_id' = sqlc.arg(job_id)::text
  AND wr.dispatch_inputs ->> 'remediation_dispatch_token' = sqlc.arg(dispatch_token)
ORDER BY wr.id ASC
LIMIT 1;

-- name: HasLegacyAlertRemediationWorkflowRun :one
-- During the one-release rollout, a previous-version worker can commit a run
-- before it records incident state. Such runs have no dispatch token, so the
-- new worker must fence on the immutable incident identities instead of
-- treating a token lookup miss as permission to dispatch again.
SELECT EXISTS (
    SELECT 1
    FROM workflow_runs AS wr
    WHERE wr.trigger_event = 'monitoring_alert'
      AND wr.execution_plane = 'runner'
      AND NOT (wr.dispatch_inputs ? 'remediation_dispatch_token')
      AND wr.dispatch_inputs ->> 'incident_row_id' = sqlc.arg(incident_row_id)::text
      AND wr.dispatch_inputs ->> 'incident_id' = sqlc.arg(incident_id)::text
);

-- name: FailTerminalAlertRemediationIncidents :many
-- The workflow normally reports its outcome while its final task is still
-- running. If the run reaches any terminal state without that callback (runner
-- crash, cancellation, setup failure, or a failed callback), fail the still-open
-- incident so it can never remain remediating forever. A concurrent successful
-- callback may still promote failed -> resolved; resolved itself is never
-- overwritten.
UPDATE alert_incidents AS i
SET state = 'failed',
    updated_at = NOW()
FROM alert_remediation_jobs AS j,
     workflow_runs AS wr
WHERE j.incident_id = i.id
  AND j.workflow_run_id = wr.id
  AND wr.status IN ('success', 'failure', 'cancelled')
  AND i.state IN ('open', 'remediating')
RETURNING i.id;

-- name: AuthorizeAlertRemediationOutcomeRun :execrows
-- The HTTP layer supplies a workflow run loaded from a verified, currently
-- running task token. Re-check every persisted relationship here and bind the
-- job atomically before allowing its incident to be updated.
UPDATE alert_remediation_jobs AS j
SET workflow_run_id = wr.id,
    updated_at = NOW()
FROM alert_incidents AS i,
     workflow_runs AS wr,
     workflow_definitions AS wd,
     workflow_tasks AS wt,
     workflow_steps AS ws
WHERE j.id = sqlc.arg(job_id)
  AND j.incident_id = sqlc.arg(incident_row_id)
  AND j.dispatch_token = sqlc.arg(dispatch_token)
  AND (j.workflow_run_id IS NULL OR j.workflow_run_id = sqlc.arg(workflow_run_id))
  AND i.id = j.incident_id
  AND i.incident_id = sqlc.arg(incident_id)
  AND wr.id = sqlc.arg(workflow_run_id)
  AND wr.repository_id = sqlc.arg(repository_id)
  AND wr.workflow_definition_id = sqlc.arg(workflow_definition_id)
  AND wr.trigger_event = 'monitoring_alert'
  AND wr.execution_plane = 'runner'
  AND wr.dispatch_inputs ->> 'incident_row_id' = j.incident_id::text
  AND wr.dispatch_inputs ->> 'incident_id' = i.incident_id
  AND wr.dispatch_inputs ->> 'remediation_job_id' = j.id::text
  AND wr.dispatch_inputs ->> 'remediation_dispatch_token' = j.dispatch_token
  AND wd.id = wr.workflow_definition_id
  AND wd.repository_id = wr.repository_id
  AND i.workflow <> ''
  AND wd.path = i.workflow
  AND wt.id = sqlc.arg(task_id)
  AND wt.workflow_run_id = wr.id
  AND wt.repository_id = wr.repository_id
  AND wt.status = 'running'
  AND wt.runner_id = sqlc.arg(runner_id)
  AND wt.attempt = sqlc.arg(task_attempt)
  AND wt.payload ->> 'job' = sqlc.arg(expected_job)::text
  AND ws.id = wt.workflow_step_id
  AND ws.workflow_run_id = wr.id
  AND ws.repository_id = wr.repository_id
  AND ws.name = sqlc.arg(expected_job)::text;

-- name: IncrementActiveAlertIncident :execrows
-- Called inside the per-policy advisory lock. Recorded IDs can only refresh
-- their original canonical incident, never a newer incident with the same key.
WITH active AS (
    SELECT i.id FROM alert_incidents AS i
    WHERE i.state IN ('open', 'remediating', 'pr_opened')
      AND (
          EXISTS (
              SELECT 1 FROM alert_incident_deliveries AS delivered
              WHERE delivered.incident_id = sqlc.arg(incident_id)
                AND delivered.canonical_incident_id = i.id AND delivered.closed_at IS NULL
          )
          OR (
              i.policy_name = sqlc.arg(policy_name) AND i.condition_name = sqlc.arg(condition_name)
              AND NOT EXISTS (
                  SELECT 1 FROM alert_incident_deliveries WHERE incident_id = sqlc.arg(incident_id)
              )
              AND NOT EXISTS (
                  SELECT 1 FROM alert_incidents AS delivered
                  WHERE delivered.incident_id = sqlc.arg(incident_id) AND delivered.state IN ('resolved', 'failed')
              )
          )
      )
    ORDER BY i.id LIMIT 1 FOR UPDATE
), recorded AS (
    INSERT INTO alert_incident_deliveries (incident_id, canonical_incident_id)
    SELECT sqlc.arg(incident_id), id FROM active
    ON CONFLICT (incident_id) DO NOTHING
)
UPDATE alert_incidents
SET occurrences = occurrences + 1, last_seen_at = now(),
    summary = sqlc.arg(summary), updated_at = now()
WHERE id IN (SELECT id FROM active)
  AND state IN ('open', 'remediating', 'pr_opened');

-- name: GetAlertIncidentForUpdate :one
SELECT * FROM alert_incidents WHERE id = $1 FOR UPDATE;

-- name: AdminMutateAlertIncidents :many
-- Single and bulk operations share state transitions. A resolved row is never
-- rewritten; bulk selections operate on active rows (resolve also accepts failed).
UPDATE alert_incidents
SET acknowledged_at = CASE
      WHEN sqlc.arg(action)::text = 'acknowledge' THEN COALESCE(acknowledged_at, now())
      WHEN sqlc.arg(action)::text = 'unacknowledge' THEN NULL ELSE acknowledged_at END,
    acknowledged_by = CASE
      WHEN sqlc.arg(action)::text = 'acknowledge' THEN COALESCE(acknowledged_by, sqlc.arg(actor)::text)
      WHEN sqlc.arg(action)::text = 'unacknowledge' THEN NULL ELSE acknowledged_by END,
    state = CASE WHEN sqlc.arg(action)::text = 'resolve' THEN 'resolved' ELSE state END,
    resolved_at = CASE WHEN sqlc.arg(action)::text = 'resolve' THEN now() ELSE resolved_at END,
    resolved_by = CASE WHEN sqlc.arg(action)::text = 'resolve' THEN sqlc.arg(actor)::text ELSE resolved_by END,
    resolution_note = CASE WHEN sqlc.arg(action)::text = 'resolve' THEN sqlc.narg(note)::text ELSE resolution_note END,
    snoozed_until = CASE WHEN sqlc.arg(action)::text = 'snooze' THEN sqlc.narg(until)::timestamptz ELSE snoozed_until END,
    updated_at = now()
WHERE (id = ANY(sqlc.arg(ids)::bigint[]) OR policy_name = sqlc.narg(policy)::text)
  AND (state IN ('open', 'remediating', 'pr_opened') OR (sqlc.arg(action)::text = 'resolve' AND state = 'failed'))
RETURNING *;

-- name: ResolveCanaryAlertIncidents :execrows
UPDATE alert_incidents
SET state = 'resolved', resolved_at = now(), updated_at = now(),
    resolved_by = sqlc.arg(resolved_by), resolution_note = 'suite passed'
WHERE source = 'canary' AND condition_name = sqlc.arg(condition_name)
  AND state IN ('open', 'remediating', 'pr_opened');
