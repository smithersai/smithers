-- ---- Repo gateways (durable `smithers gateway` VM per user+repo) ----

-- name: CreateRepoGateway :one
INSERT INTO repo_gateways (
    repository_id,
    user_id,
    workspace_id,
    status
)
VALUES ($1, $2, sqlc.narg(workspace_id)::uuid, sqlc.arg(status)::text)
RETURNING *;

-- name: GetActiveRepoGatewayForUserRepo :one
-- Returns the reusable gateway row for a user+repo pair. Mirrors
-- GetActiveWorkspaceForUserRepo: starting rows only count once a VM exists,
-- so a crashed provision does not permanently shadow the slot.
SELECT *
FROM repo_gateways
WHERE repository_id = $1
  AND user_id = $2
  AND workspace_id IS NOT DISTINCT FROM sqlc.narg(workspace_id)::uuid
  AND deleted_at IS NULL
  AND (
    status IN ('running', 'suspended')
    OR (status = 'starting' AND vm_id <> '')
  )
LIMIT 1;

-- name: UpdateRepoGatewayExecutionInfo :one
UPDATE repo_gateways
SET vm_id = sqlc.arg(vm_id)::text,
    base_url = sqlc.arg(base_url)::text,
    auth_token_hash = sqlc.arg(auth_token_hash)::text,
    auth_token_ciphertext = sqlc.arg(auth_token_ciphertext)::text,
    status = sqlc.arg(status)::text,
    updated_at = NOW()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: UpdateRepoGatewayStatus :one
UPDATE repo_gateways
SET status = sqlc.arg(status)::text,
    updated_at = NOW()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: TouchRepoGatewayActivity :exec
UPDATE repo_gateways
SET last_activity_at = NOW(),
    updated_at = NOW()
WHERE id = $1;

-- name: SoftDeleteRepoGateway :one
UPDATE repo_gateways
SET deleted_at = NOW(),
    status = 'stopped',
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: ListStaleRepoGateways :many
-- Reaper input: non-terminal gateway rows whose provision is presumed crashed
-- (older than the caller-supplied age in seconds, $1). 'starting' rows carry a
-- live VM + domain mapping to tear down; 'pending' rows crashed before the VM
-- existed; 'failed' rows had their VM torn down on the provision path but still
-- need soft-deleting. The age must exceed the worst-case provision wall-clock so
-- an in-flight provision is never reclaimed.
SELECT *
FROM repo_gateways
WHERE deleted_at IS NULL
  AND status IN ('pending', 'starting', 'failed')
  AND updated_at < NOW() - make_interval(secs => sqlc.arg(age_seconds)::bigint);

-- name: ListDiscardedWorkspaceGateways :many
-- Row-scoped cleanup survives a failed stop while the owning VM was asleep.
SELECT * FROM repo_gateways
WHERE workspace_id = sqlc.arg(workspace_id)::uuid
  AND vm_id = sqlc.arg(vm_id)::text
  AND deleted_at IS NOT NULL
ORDER BY created_at, id;

-- name: SetRepoGatewayLandingTokenID :exec
-- Records (or clears, with a NULL argument) the repository-scoped landing
-- credential a workspace gateway owns, so teardown revokes exactly that token.
UPDATE repo_gateways
SET landing_token_id = sqlc.narg(landing_token_id)::bigint,
    updated_at = NOW()
WHERE id = $1;

-- name: ClearDiscardedWorkspaceGatewayCredential :exec
-- Only after the named service is verified stopped and ingress revoked. The
-- landing token row is deleted separately; this only drops the reference.
UPDATE repo_gateways
SET auth_token_hash = '', auth_token_ciphertext = '', landing_token_id = NULL, updated_at = NOW()
WHERE id = $1 AND workspace_id IS NOT NULL AND deleted_at IS NOT NULL;

-- name: ListPendingWorkspaceGatewayCleanup :many
SELECT * FROM repo_gateways
WHERE workspace_id IS NOT NULL AND deleted_at IS NOT NULL
  AND auth_token_hash <> ''
ORDER BY updated_at, id
LIMIT 20;

-- name: TouchDiscardedWorkspaceGatewayCleanup :exec
-- Rotate failed attempts so sleeping VMs cannot starve later cleanup rows.
UPDATE repo_gateways SET updated_at = NOW()
WHERE id = $1 AND workspace_id IS NOT NULL AND deleted_at IS NOT NULL;

-- name: HasWritableWorkspaceShares :one
SELECT EXISTS (
    SELECT 1 FROM workspace_shares
    WHERE workspace_id = sqlc.arg(workspace_id)::uuid AND level = 'write'
);
