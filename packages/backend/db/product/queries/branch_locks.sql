-- name: AcquireBranchLockInsert :one
-- Optimistic acquisition: succeeds only when no lock row exists for the
-- (repository, branch) pair. A unique-violation tells the service to try the
-- stale-takeover path or report the holder.
INSERT INTO branch_locks (repository_id, branch, user_id, workspace_id)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetBranchLock :one
SELECT * FROM branch_locks
WHERE repository_id = $1 AND branch = $2;

-- name: TakeOverStaleBranchLock :one
-- Steal a lock whose heartbeat has gone stale (holder crashed or left without
-- releasing). Returns no row when the lock is still live.
UPDATE branch_locks
SET user_id = $3,
    workspace_id = $4,
    heartbeat_at = NOW(),
    updated_at = NOW()
WHERE repository_id = $1
  AND branch = $2
  AND heartbeat_at < $5
RETURNING *;

-- name: HeartbeatBranchLock :execrows
-- Renew liveness. The holder and approved joiners may both heartbeat.
UPDATE branch_locks
SET heartbeat_at = NOW(), updated_at = NOW()
WHERE repository_id = $1
  AND branch = $2
  AND user_id = $3;

-- name: ReleaseBranchLock :execrows
DELETE FROM branch_locks
WHERE repository_id = $1
  AND branch = $2
  AND user_id = $3;

-- name: CreateBranchLockJoinRequest :one
INSERT INTO branch_lock_join_requests (repository_id, branch, requester_id)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetBranchLockJoinRequest :one
SELECT * FROM branch_lock_join_requests
WHERE id = $1;

-- name: GetBranchLockJoinRequestForRequester :one
SELECT * FROM branch_lock_join_requests
WHERE repository_id = $1
  AND branch = $2
  AND requester_id = $3
ORDER BY created_at DESC
LIMIT 1;

-- name: HasApprovedBranchLockJoin :one
-- An approved request is the membership record that lets a second user
-- acquire (and heartbeat) the held branch.
SELECT EXISTS (
    SELECT 1 FROM branch_lock_join_requests
    WHERE repository_id = $1
      AND branch = $2
      AND requester_id = $3
      AND status = 'approved'
) AS approved;

-- name: ListPendingBranchLockJoinRequests :many
-- The holder's inbox for one branch.
SELECT * FROM branch_lock_join_requests
WHERE repository_id = $1
  AND branch = $2
  AND status = 'pending'
ORDER BY created_at ASC;

-- name: ListPendingBranchLockJoinRequestsForHolder :many
-- Every pending ask across the branches the holder currently locks.
SELECT j.* FROM branch_lock_join_requests j
JOIN branch_locks l
  ON l.repository_id = j.repository_id AND l.branch = j.branch
WHERE l.user_id = $1
  AND j.status = 'pending'
ORDER BY j.created_at ASC;

-- name: ResolveBranchLockJoinRequest :one
UPDATE branch_lock_join_requests
SET status = $2,
    resolver_id = $3,
    resolved_at = NOW()
WHERE id = $1
  AND status = 'pending'
RETURNING *;

-- name: GetUsernameByID :one
SELECT username FROM users WHERE id = $1 AND deleted_at IS NULL;
