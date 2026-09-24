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
-- releasing). Returns no row when the lock is still live. The new holder
-- starts a new generation, so approvals granted by the old holder lapse.
UPDATE branch_locks
SET user_id = $3,
    workspace_id = $4,
    generation = gen_random_uuid(),
    heartbeat_at = NOW(),
    updated_at = NOW()
WHERE repository_id = $1
  AND branch = $2
  AND heartbeat_at < $5
RETURNING *;

-- name: HeartbeatBranchLock :execrows
-- Renew liveness. The holder and joiners approved for the current lock
-- generation may both heartbeat.
UPDATE branch_locks
SET heartbeat_at = NOW(), updated_at = NOW()
WHERE branch_locks.repository_id = $1
  AND branch_locks.branch = $2
  AND (
    branch_locks.user_id = $3
    OR EXISTS (
        SELECT 1 FROM branch_lock_join_requests j
        WHERE j.repository_id = branch_locks.repository_id
          AND j.branch = branch_locks.branch
          AND j.lock_generation = branch_locks.generation
          AND j.requester_id = $3
          AND j.status = 'approved'
    )
  );

-- name: ReleaseBranchLock :execrows
DELETE FROM branch_locks
WHERE repository_id = $1
  AND branch = $2
  AND user_id = $3;

-- name: CreateBranchLockJoinRequest :one
-- lock_generation binds the request to the holder's current acquisition. The
-- insert reads the generation from the lock row itself (share-locked until the
-- request commits), so a request against a generation the branch no longer
-- carries inserts nothing (ErrNoRows) instead of an orphan no inbox shows.
INSERT INTO branch_lock_join_requests (repository_id, branch, requester_id, lock_generation)
SELECT l.repository_id, l.branch, sqlc.arg(requester_id)::bigint, l.generation
FROM branch_locks l
WHERE l.repository_id = sqlc.arg(repository_id)
  AND l.branch = sqlc.arg(branch)
  AND l.generation = sqlc.arg(lock_generation)
FOR SHARE OF l
RETURNING *;

-- name: GetBranchLockJoinRequest :one
SELECT * FROM branch_lock_join_requests
WHERE id = $1;

-- name: GetBranchLockJoinRequestForRequester :one
-- The requester's latest ask against the current lock generation.
SELECT * FROM branch_lock_join_requests
WHERE repository_id = $1
  AND branch = $2
  AND requester_id = $3
  AND lock_generation = $4
ORDER BY created_at DESC
LIMIT 1;

-- name: HasApprovedBranchLockJoin :one
-- An approved request is the membership record that lets a second user
-- acquire (and heartbeat) the held branch. It counts only for the lock
-- generation the holder approved it under, never for a later holder.
SELECT EXISTS (
    SELECT 1 FROM branch_lock_join_requests
    WHERE repository_id = $1
      AND branch = $2
      AND requester_id = $3
      AND lock_generation = $4
      AND status = 'approved'
) AS approved;

-- name: ListPendingBranchLockJoinRequests :many
-- The holder's inbox for one branch and lock generation.
SELECT * FROM branch_lock_join_requests
WHERE repository_id = $1
  AND branch = $2
  AND lock_generation = $3
  AND status = 'pending'
ORDER BY created_at ASC;

-- name: ListPendingBranchLockJoinRequestsForHolder :many
-- Every pending ask across the branches the holder currently locks.
SELECT j.* FROM branch_lock_join_requests j
JOIN branch_locks l
  ON l.repository_id = j.repository_id
 AND l.branch = j.branch
 AND l.generation = j.lock_generation
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
