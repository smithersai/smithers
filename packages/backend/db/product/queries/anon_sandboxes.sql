-- ---- Anonymous sandboxes (../multi SPEC.md §3 signed-out open) ----
-- See db/product/migrations/0001_product_baseline.sql. Rows carry no user
-- linkage by design; access is a token capability checked in the service.

-- name: LockAnonSandboxAdmission :exec
-- Serializes anonymous-sandbox admission for the rest of the transaction so
-- the concurrency and per-IP cap counts and the insert that follows them are
-- one atomic decision across API replicas.
SELECT pg_advisory_xact_lock(hashtextextended('anon-sandbox-admission', 0));

-- name: CreateAnonSandbox :one
INSERT INTO anon_sandboxes (repo_full_name, branch, token_hash, client_ip, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetAnonSandbox :one
SELECT * FROM anon_sandboxes
WHERE id = $1
  AND deleted_at IS NULL;

-- name: UpdateAnonSandboxStatusCAS :one
-- Compare-and-set transition so the async provisioner, the reaper, and an
-- explicit delete can never fight over the same row: the row moves only from
-- the status the caller last observed.
UPDATE anon_sandboxes
SET status = sqlc.arg(new_status),
    provisioning_stage = sqlc.arg(provisioning_stage),
    vm_id = CASE WHEN sqlc.arg(vm_id)::text <> '' THEN sqlc.arg(vm_id)::text ELSE vm_id END,
    updated_at = NOW()
WHERE id = $1
  AND status = sqlc.arg(expected_status)
  AND deleted_at IS NULL
RETURNING *;

-- name: TouchAnonSandboxStage :exec
UPDATE anon_sandboxes
SET provisioning_stage = $2,
    updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL;

-- name: CountActiveAnonSandboxes :one
SELECT COUNT(*) FROM anon_sandboxes
WHERE status IN ('pending', 'starting', 'running')
  AND deleted_at IS NULL;

-- name: CountActiveAnonSandboxesForIP :one
SELECT COUNT(*) FROM anon_sandboxes
WHERE client_ip = $1
  AND status IN ('pending', 'starting', 'running')
  AND deleted_at IS NULL;

-- name: ListReapableAnonSandboxes :many
-- Everything the reaper must tear down: past-TTL rows, failed provisions
-- (their VM may exist), and pending/starting rows stranded past the
-- provisioning deadline (crashed API pod mid-provision).
SELECT * FROM anon_sandboxes
WHERE deleted_at IS NULL
  AND (
    expires_at < NOW()
    OR status = 'failed'
    OR (status IN ('pending', 'starting') AND created_at < NOW() - INTERVAL '15 minutes')
  )
LIMIT $1;

-- name: SoftDeleteAnonSandbox :one
UPDATE anon_sandboxes
SET status = 'deleted',
    deleted_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND deleted_at IS NULL
RETURNING *;
