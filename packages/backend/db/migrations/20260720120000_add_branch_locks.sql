-- Revision: 20260720120000.
-- Branch locks: one person checks out a branch at a time. Opening a workspace
-- on a branch acquires the (repository, branch) lock; while it is held every
-- other user gets a conflict and may request to join (approved by the holder,
-- following pair-session invite rules), fork the branch, or cancel. The lock
-- is liveness-based: the client heartbeats while the workspace is open and a
-- lock whose heartbeat goes stale may be taken over, so a crashed or
-- disconnected holder cannot wedge a branch forever. Join requests are the
-- audit trail of the ask; an approved request is what lets a second user
-- acquire the held branch.

CREATE TABLE IF NOT EXISTS branch_locks (
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch         VARCHAR(255) NOT NULL CHECK (LENGTH(branch) BETWEEN 1 AND 255),
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id   UUID,
    heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, branch)
);

CREATE INDEX IF NOT EXISTS idx_branch_locks_user
    ON branch_locks (user_id);

CREATE INDEX IF NOT EXISTS idx_branch_locks_heartbeat
    ON branch_locks (heartbeat_at);

CREATE TABLE IF NOT EXISTS branch_lock_join_requests (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch         VARCHAR(255) NOT NULL CHECK (LENGTH(branch) BETWEEN 1 AND 255),
    requester_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status         VARCHAR(16) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
    resolver_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at    TIMESTAMPTZ
);

-- One open ask per requester per branch; resolved rows accumulate for audit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_lock_join_requests_pending
    ON branch_lock_join_requests (repository_id, branch, requester_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_branch_lock_join_requests_holder
    ON branch_lock_join_requests (repository_id, branch)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_branch_lock_join_requests_requester
    ON branch_lock_join_requests (requester_id, status);
