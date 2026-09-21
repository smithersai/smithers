-- Product queries extracted from the transitional Plue source.

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

