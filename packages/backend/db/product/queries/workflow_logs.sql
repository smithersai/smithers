-- name: BackfillOneWorkflowLogBudget :one
-- The database function locks and recounts exactly one uninitialized run. A
-- NULL result means the resumable rollout is complete; filter it into the
-- ordinary pgx.ErrNoRows signal expected by the background worker.
SELECT result.workflow_run_id::bigint
FROM backfill_one_workflow_log_budget() AS result(workflow_run_id)
WHERE result.workflow_run_id IS NOT NULL;

-- name: InsertWorkflowLog :one
WITH run_lock AS (
    SELECT workflow_runs.id FROM workflow_runs WHERE workflow_runs.id = sqlc.arg(workflow_run_id) FOR UPDATE
)
INSERT INTO workflow_logs (workflow_run_id, workflow_step_id, sequence, stream, entry)
SELECT run_lock.id, sqlc.arg(workflow_step_id), sqlc.arg(sequence), sqlc.arg(stream), sqlc.arg(entry)
FROM run_lock
RETURNING *;

-- name: InsertWorkflowLogNextSequence :one
WITH run_lock AS (
    SELECT workflow_runs.id FROM workflow_runs WHERE workflow_runs.id = sqlc.arg(workflow_run_id) FOR UPDATE
),
step_lock AS (
    SELECT pg_advisory_xact_lock(sqlc.arg(workflow_step_id)) AS locked FROM run_lock
),
log_state AS (
    SELECT
        COALESCE((
            SELECT MAX(wl.sequence)
            FROM workflow_logs wl
            WHERE wl.workflow_step_id = sqlc.arg(workflow_step_id)
        ), 0)::bigint + 1 AS next_sequence
    FROM step_lock
),
inserted AS (
    INSERT INTO workflow_logs (workflow_run_id, workflow_step_id, sequence, stream, entry)
    SELECT
        sqlc.arg(workflow_run_id),
        sqlc.arg(workflow_step_id),
        log_state.next_sequence,
        sqlc.arg(stream),
        sqlc.arg(entry)
    FROM log_state
    RETURNING *
)
SELECT *
FROM inserted;

-- name: InsertWorkflowRunLogNextSequence :one
WITH run_lock AS (
    SELECT workflow_runs.id FROM workflow_runs WHERE workflow_runs.id = sqlc.arg(workflow_run_id) FOR UPDATE
),
sequence_lock AS (
    SELECT pg_advisory_xact_lock(sqlc.arg(workflow_run_id)) AS locked FROM run_lock
),
log_state AS (
    SELECT
        COALESCE((
            SELECT MAX(wrl.sequence)
            FROM workflow_run_logs wrl
            WHERE wrl.workflow_run_id = sqlc.arg(workflow_run_id)
        ), 0)::bigint + 1 AS next_sequence
    FROM sequence_lock
),
inserted AS (
    INSERT INTO workflow_run_logs (workflow_run_id, workflow_step_id, sequence, stream, entry)
    SELECT
        sqlc.arg(workflow_run_id),
        sqlc.arg(workflow_step_id),
        log_state.next_sequence,
        sqlc.arg(stream),
        sqlc.arg(entry)
    FROM log_state
    RETURNING id, workflow_run_id, workflow_step_id, sequence, stream, entry, created_at
)
SELECT id, workflow_run_id, workflow_step_id, sequence, stream, entry, created_at
FROM inserted;

-- name: NotifyWorkflowLog :exec
SELECT pg_notify(
    'workflow_step_logs_' || sqlc.arg(step_id)::bigint::text,
    sqlc.arg(payload)::text
);

-- name: NotifyWorkflowRunLog :exec
SELECT pg_notify(
    'workflow_run_' || sqlc.arg(run_id)::bigint::text,
    sqlc.arg(payload)::text
);

-- name: GetWorkflowRunByIDAndRepo :one
SELECT id, repository_id, workflow_definition_id, status, trigger_event, trigger_ref, trigger_commit_sha, agent_token_hash, agent_token_expires_at, started_at, completed_at, created_at, updated_at
FROM workflow_runs
WHERE id = sqlc.arg(run_id)
  AND repository_id = sqlc.arg(repository_id);

-- name: ListWorkflowStepsByRunID :many
-- Ticket 0147: repository_id included in the projection so the row struct
-- carries the denormalized column the realtime run-inspection stream scopes
-- on. The column is NOT NULL and populated by the
-- trg_workflow_steps_repository_id trigger on INSERT.
SELECT id, workflow_run_id, repository_id, name, position, status, started_at, completed_at, created_at, updated_at
FROM workflow_steps
WHERE workflow_run_id = sqlc.arg(run_id)
ORDER BY position;

-- name: ListWorkflowLogsSince :many
SELECT wl.id, wl.workflow_run_id, wl.workflow_step_id, wl.sequence, wl.stream, wl.entry, wl.created_at
FROM workflow_logs wl
WHERE wl.workflow_run_id = sqlc.arg(run_id)
  AND wl.id > sqlc.arg(after_id)
UNION ALL
SELECT rl.id, rl.workflow_run_id, rl.workflow_step_id, rl.sequence, rl.stream, rl.entry, rl.created_at
FROM workflow_run_logs rl
WHERE rl.workflow_run_id = sqlc.arg(run_id)
  AND rl.id > sqlc.arg(after_id)
ORDER BY id ASC
LIMIT sqlc.arg(page_size);

-- name: GetWorkflowLogStreamHead :one
WITH run_lock AS (
    SELECT workflow_runs.id FROM workflow_runs WHERE workflow_runs.id = sqlc.arg(run_id) FOR UPDATE
)
SELECT GREATEST(
    COALESCE((SELECT MAX(id) FROM workflow_logs WHERE workflow_run_id = run_lock.id), 0),
    COALESCE((SELECT MAX(id) FROM workflow_run_logs WHERE workflow_run_id = run_lock.id), 0)
)::bigint AS head FROM run_lock;
