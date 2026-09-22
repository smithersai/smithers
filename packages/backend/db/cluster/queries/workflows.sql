-- Private cluster queries kept separate from the product graph.

-- name: ListExpiredQueuedRunnerWorkflowRuns :many
-- A run with no task currently executing must not wait indefinitely for a
-- runner. A separate worker calls the normal cancellation path so credentials,
-- commit status, and check run are settled together. Limit each sweep.
SELECT wr.id, wr.repository_id
FROM workflow_runs wr
WHERE wr.execution_plane = 'runner'
  AND wr.status IN ('queued', 'running')
  AND EXISTS (
      SELECT 1 FROM workflow_tasks wt
      WHERE wt.workflow_run_id = wr.id
        AND wt.status = 'pending'
        AND wt.available_at <= NOW() - INTERVAL '120 seconds'
  )
  AND NOT EXISTS (
      SELECT 1 FROM workflow_tasks wt
      WHERE wt.workflow_run_id = wr.id
        AND wt.status IN ('assigned', 'running')
  )
ORDER BY wr.created_at, wr.id
LIMIT sqlc.arg(limit_count);

-- name: MarkQueuedRunnerWorkflowRunTimeout :execrows
-- Lock and recheck with a fresh task snapshot after any competing claim.
-- The reason fences later claims until the normal cancellation path finishes.
UPDATE workflow_runs wr
SET cancel_reason = 'runner_queue_timeout', updated_at = NOW()
WHERE wr.id = sqlc.arg(run_id)
  AND wr.repository_id = sqlc.arg(repository_id)
  AND runner_queue_timeout_admissible(wr.id, wr.repository_id);

-- name: GetRunnerWorkflowTaskStatus :one
SELECT status
FROM workflow_tasks
WHERE id = sqlc.arg(task_id)
  AND runner_id = sqlc.arg(runner_id);


-- name: ClaimRunnerWorkflowTask :one
-- Production runner claim is deliberately one PostgreSQL statement. The
-- legacy ClaimIdleRunner -> ClaimPendingTask -> MarkWorkflowTaskRunning flow
-- can leave a busy runner and a running task behind when the later step update
-- fails: ReleaseRunner correctly refuses to release a runner that still owns
-- active work. Lock the idle runner and the complete task/run/step candidate,
-- then make every state transition through data-modifying CTE dependencies so
-- any database error rolls the whole claim back.
WITH runner_candidate AS MATERIALIZED (
    SELECT rp.id, pg_try_advisory_xact_lock(534, 1) AS admission_lock
    FROM runner_pool rp
    WHERE rp.id = sqlc.arg(runner_id)::bigint
      AND rp.status = 'idle'
    FOR UPDATE OF rp SKIP LOCKED
),
task_candidate AS MATERIALIZED (
    SELECT wt.id, wt.workflow_step_id
    FROM workflow_tasks wt
    JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
    JOIN workflow_steps ws ON ws.id = wt.workflow_step_id
    JOIN repositories repo ON repo.id = wt.repository_id
    CROSS JOIN runner_candidate rc
    WHERE wt.status = 'pending'
      AND wt.available_at <= NOW()
      AND wr.status IN ('queued', 'running')
      AND wr.execution_plane = 'runner'
      AND wr.cancel_reason <> 'runner_queue_timeout'
      AND ws.status IN ('queued', 'running')
      -- The VOLATILE function takes fresh snapshots after the advisory gate is
      -- acquired; inline COUNTs would see a stale statement-start snapshot.
      AND runner_claim_admissible(wt.repository_id,
          wr.trigger_event IN ('manual_dispatch', 'workflow_dispatch'),
          rc.admission_lock)
    ORDER BY wt.priority DESC, wt.created_at ASC, wt.id ASC
    -- Serializes claims from separate runs of the same repository, so the
    -- active-task cap cannot be exceeded by simultaneous runner polls.
    FOR UPDATE OF wt, wr, ws, repo SKIP LOCKED
    LIMIT 1
),
claimed_task AS (
    UPDATE workflow_tasks wt
    SET status = 'running',
        attempt = wt.attempt + 1,
        runner_id = rc.id,
        assigned_at = NOW(),
        started_at = COALESCE(wt.started_at, NOW()),
        updated_at = NOW()
    FROM task_candidate tc
    CROSS JOIN runner_candidate rc
    WHERE wt.id = tc.id
      AND wt.status = 'pending'
    RETURNING wt.*
),
running_step AS (
    UPDATE workflow_steps ws
    SET status = 'running',
        started_at = COALESCE(ws.started_at, NOW()),
        updated_at = NOW()
    FROM claimed_task ct
    WHERE ws.id = ct.workflow_step_id
      AND ws.status IN ('queued', 'running')
    RETURNING ws.id
),
claimed_runner AS (
    UPDATE runner_pool rp
    SET status = 'busy',
        updated_at = NOW()
    FROM runner_candidate rc
    CROSS JOIN running_step rs
    WHERE rp.id = rc.id
      AND rp.status = 'idle'
    RETURNING rp.id
)
SELECT ct.*
FROM claimed_task ct
JOIN running_step rs ON rs.id = ct.workflow_step_id
JOIN claimed_runner cr ON cr.id = ct.runner_id;


-- name: ClearTerminalWorkflowTaskRunnerOwnership :execrows
-- Trusted runner settlement clears the old lease before releasing runner_pool.
-- Exact task+runner matching makes a delayed acknowledgement harmless after
-- that runner has moved on to another task.
UPDATE workflow_tasks
SET runner_id = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(task_id)
  AND runner_id = sqlc.arg(runner_id)
  AND status IN ('done', 'failed', 'cancelled');

