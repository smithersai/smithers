-- Private cluster queries kept separate from the product graph.

-- name: ListAlertIncidents :many
-- State filters are lifecycle views; snoozing does not change active state.
SELECT * FROM alert_incidents
WHERE (sqlc.narg(policy)::text IS NULL OR policy_name = sqlc.narg(policy)::text)
  AND CASE sqlc.arg(state_filter)::text
    WHEN 'all' THEN TRUE
    WHEN 'active' THEN state IN ('open', 'remediating', 'pr_opened')
    WHEN 'open' THEN state IN ('open', 'remediating', 'pr_opened')
      AND acknowledged_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= now())
    WHEN 'acknowledged' THEN state IN ('open', 'remediating', 'pr_opened') AND acknowledged_at IS NOT NULL
    WHEN 'snoozed' THEN state IN ('open', 'remediating', 'pr_opened') AND snoozed_until > now()
    WHEN 'resolved' THEN state IN ('resolved', 'failed')
    ELSE FALSE
  END
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);


-- name: ListAlertRemediationJobsForIncidents :many
-- Jobs half of the incident feed, batched over one page of incident ids so the
-- listing costs one extra round trip instead of one per incident. dispatch_token
-- authorizes the outcome callback, so it is deliberately never selected here.
SELECT id,
       incident_id,
       status,
       attempts,
       error,
       available_at,
       processed_at,
       created_at,
       updated_at,
       workflow_run_id
FROM alert_remediation_jobs
WHERE incident_id = ANY(sqlc.arg(incident_ids)::bigint[])
ORDER BY incident_id ASC, created_at DESC, id ASC;


-- name: GetAlertIncidentStateCounts :one
-- Incident tallies for the status summary. The WHERE clause repeats the partial
-- index predicate on idx_alert_incidents_policy_active so the count never scans
-- the resolved history. 'pr_opened' is an in-flight remediation (the workflow
-- opened a fix PR and the incident has not resolved), so it shares the
-- remediating bucket the same way the status aggregate buckets it; otherwise
-- those rows would be scanned and then counted in neither column.
SELECT
    COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= now()))::bigint AS open_count,
    COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::bigint AS acknowledged_count,
    COUNT(*) FILTER (WHERE snoozed_until > now())::bigint AS snoozed_count,
    COUNT(*) FILTER (WHERE state IN ('remediating', 'pr_opened'))::bigint AS remediating_count
FROM alert_incidents
WHERE state IN ('open', 'remediating', 'pr_opened');


-- name: CountActiveSandboxVMs :one
-- Micro-VMs currently holding a compute reservation, which is the same set that
-- sandbox_hosts.allocated_vms charges for. Suspended and stopped guests have
-- handed compute back and are not active even though their disk is retained.
SELECT COUNT(*)::bigint AS active_vms
FROM sandbox_instances
WHERE deleted_at IS NULL
  AND reservation_held;
