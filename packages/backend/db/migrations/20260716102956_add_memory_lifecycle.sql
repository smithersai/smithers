-- Durable lifecycle state for the Hindsight memory companion. No memory
-- content is stored in the Plue database.

CREATE TABLE IF NOT EXISTS memory_provisioning_tasks (
    id               BIGSERIAL PRIMARY KEY,
    target_kind      VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'project')),
    target_id        BIGINT NOT NULL CHECK (target_id > 0),
    status           VARCHAR(16) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'done', 'failed')),
    attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    last_error       TEXT,
    available_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_provisioning_claim
    ON memory_provisioning_tasks (available_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_memory_provisioning_stale
    ON memory_provisioning_tasks (lease_expires_at)
    WHERE status = 'running';

CREATE TABLE IF NOT EXISTS memory_promotion_tasks (
    id                 BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_bookmark    VARCHAR(255) NOT NULL,
    target_bookmark    VARCHAR(255) NOT NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'running', 'done', 'failed')),
    outcome            VARCHAR(16) CHECK (outcome IN ('promoted', 'empty', 'skipped')),
    attempt            INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    last_error         TEXT,
    operation_id       TEXT,
    available_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at   TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (landing_request_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_promotion_claim
    ON memory_promotion_tasks (available_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_memory_promotion_stale
    ON memory_promotion_tasks (lease_expires_at)
    WHERE status = 'running';

CREATE TABLE IF NOT EXISTS memory_ingest_cursors (
    session_id            UUID PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    document_id           TEXT NOT NULL UNIQUE,
    last_message_sequence BIGINT NOT NULL DEFAULT -1 CHECK (last_message_sequence >= -1),
    last_operation_id     TEXT,
    accepted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memory_cleanup_tasks (
    id                    BIGSERIAL PRIMARY KEY,
    task_kind             VARCHAR(24) NOT NULL
                          CHECK (task_kind IN ('branch', 'project_bank', 'user_bank')),
    target_id             BIGINT NOT NULL CHECK (target_id > 0),
    bookmark              VARCHAR(255),
    deletion_event_at     TIMESTAMPTZ NOT NULL,
    idempotency_key       TEXT NOT NULL UNIQUE,
    status                VARCHAR(32) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('awaiting_source_delete', 'pending', 'running', 'done')),
    attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    last_error_class      VARCHAR(64),
    available_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at      TIMESTAMPTZ,
    finished_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((task_kind = 'branch' AND bookmark IS NOT NULL) OR
           (task_kind IN ('project_bank', 'user_bank') AND bookmark IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_memory_cleanup_claim
    ON memory_cleanup_tasks (available_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_memory_cleanup_stale
    ON memory_cleanup_tasks (lease_expires_at)
    WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_memory_cleanup_target
    ON memory_cleanup_tasks (task_kind, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_cleanup_items (
    cleanup_task_id BIGINT NOT NULL REFERENCES memory_cleanup_tasks(id) ON DELETE CASCADE,
    memory_id       TEXT NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalidated_at  TIMESTAMPTZ,
    PRIMARY KEY (cleanup_task_id, memory_id)
);

CREATE TABLE IF NOT EXISTS memory_write_freezes (
    id               BIGSERIAL PRIMARY KEY,
    target_kind      VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'project', 'all')),
    target_id        BIGINT,
    lease_token      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    operator_id      TEXT NOT NULL,
    reason           TEXT NOT NULL,
    acquired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ NOT NULL,
    released_at      TIMESTAMPTZ,
    CHECK ((target_kind = 'all' AND target_id IS NULL) OR
           (target_kind IN ('user', 'project') AND target_id > 0)),
    CHECK (expires_at > acquired_at AND expires_at <= acquired_at + INTERVAL '2 hours')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_write_freezes_active_target
    ON memory_write_freezes (target_kind, COALESCE(target_id, 0))
    WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_write_freezes_expiry
    ON memory_write_freezes (expires_at)
    WHERE released_at IS NULL;
