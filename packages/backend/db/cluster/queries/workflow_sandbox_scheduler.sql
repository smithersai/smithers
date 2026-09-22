-- Private cluster queries kept separate from the product graph.

-- name: ClaimQueuedWorkflowRuns :many
-- Atomically acquire renewable, generation-fenced ownership of queued
-- sandbox-plane workflow runs. Expired new-style leases are reclaimed
-- immediately. Previous-version schedulers did not persist a lease, so an
-- unleased running row is conservatively recoverable after three hours. That
-- legacy window covers the old scheduler's serial five-run batch at the
-- maximum per-run timeout; new claims recover on their renewable two-minute
-- lease. The execution_plane filter keeps runner and agent work off this plane.
WITH candidates AS MATERIALIZED (
    SELECT wr.id
    FROM workflow_runs AS wr
    LEFT JOIN workflow_sandbox_claims AS existing
      ON existing.workflow_run_id = wr.id
    WHERE wr.execution_plane = 'sandbox'
      AND (
        wr.status = 'queued'
        OR (
          wr.status = 'running'
          AND (
            (existing.claim_token IS NOT NULL AND existing.lease_expires_at <= NOW())
            OR
            (existing.claim_token IS NULL AND wr.updated_at <= NOW() - INTERVAL '3 hours')
          )
        )
      )
    ORDER BY wr.created_at ASC, wr.id ASC
    FOR UPDATE OF wr SKIP LOCKED
    LIMIT sqlc.arg(limit_count)
), leased AS (
    INSERT INTO workflow_sandbox_claims (
        workflow_run_id,
        generation,
        claim_token,
        claimed_at,
        lease_expires_at
    )
    SELECT
        candidates.id,
        1,
        gen_random_uuid(),
        NOW(),
        NOW() + INTERVAL '2 minutes'
    FROM candidates
    ON CONFLICT (workflow_run_id) DO UPDATE
    SET generation = workflow_sandbox_claims.generation + 1,
        claim_token = gen_random_uuid(),
        claimed_at = NOW(),
        lease_expires_at = NOW() + INTERVAL '2 minutes'
    WHERE workflow_sandbox_claims.claim_token IS NULL
       OR workflow_sandbox_claims.lease_expires_at <= NOW()
    RETURNING workflow_run_id, generation, claim_token, lease_expires_at
)
UPDATE workflow_runs AS wr
SET status = 'running',
    started_at = COALESCE(wr.started_at, NOW()),
    completed_at = NULL,
    updated_at = NOW()
FROM leased
WHERE wr.id = leased.workflow_run_id
RETURNING
    wr.id,
    wr.repository_id,
    wr.workflow_definition_id,
    wr.trigger_ref,
    wr.trigger_commit_sha,
    leased.claim_token,
    leased.generation AS claim_generation,
    leased.lease_expires_at AS claim_lease_expires_at;


-- name: RenewWorkflowSandboxClaim :one
UPDATE workflow_sandbox_claims AS claim
SET claimed_at = NOW(),
    lease_expires_at = NOW() + INTERVAL '2 minutes'
WHERE claim.workflow_run_id = sqlc.arg(id)
  AND claim.claim_token = sqlc.arg(claim_token)::uuid
  AND claim.generation = sqlc.arg(claim_generation)
  AND EXISTS (
    SELECT 1
    FROM workflow_runs AS wr
    WHERE wr.id = claim.workflow_run_id
      AND wr.execution_plane = 'sandbox'
      AND wr.status = 'running'
  )
RETURNING claim.lease_expires_at;


-- name: MarkWorkflowRunSuccess :one
WITH claim_context AS MATERIALIZED (
    SELECT
      set_config('smithers.workflow_sandbox_claim_token', sqlc.arg(claim_token)::text, true),
      set_config('smithers.workflow_sandbox_claim_generation', (sqlc.arg(claim_generation)::bigint)::text, true)
)
UPDATE workflow_runs AS wr
SET status = 'success',
    completed_at = NOW(),
    updated_at = NOW()
FROM workflow_sandbox_claims AS claim, claim_context
WHERE wr.id = sqlc.arg(id)
  AND wr.status = 'running'
  AND wr.execution_plane = 'sandbox'
  AND claim.workflow_run_id = wr.id
  AND claim.claim_token = sqlc.arg(claim_token)::uuid
  AND claim.generation = sqlc.arg(claim_generation)::bigint
RETURNING wr.*;


-- name: MarkWorkflowRunFailure :one
WITH claim_context AS MATERIALIZED (
    SELECT
      set_config('smithers.workflow_sandbox_claim_token', sqlc.arg(claim_token)::text, true),
      set_config('smithers.workflow_sandbox_claim_generation', (sqlc.arg(claim_generation)::bigint)::text, true)
)
UPDATE workflow_runs AS wr
SET status = 'failure',
    completed_at = NOW(),
    updated_at = NOW()
FROM workflow_sandbox_claims AS claim, claim_context
WHERE wr.id = sqlc.arg(id)
  AND wr.status = 'running'
  AND wr.execution_plane = 'sandbox'
  AND claim.workflow_run_id = wr.id
  AND claim.claim_token = sqlc.arg(claim_token)::uuid
  AND claim.generation = sqlc.arg(claim_generation)::bigint
RETURNING wr.*;
