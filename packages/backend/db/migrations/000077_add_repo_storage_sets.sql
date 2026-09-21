-- Repository storage sets are the logical placement targets for Git/jj data.
-- Repo-host nodes inside a set hold full local-disk replicas; quorum logic is
-- coordinated above these tables.

CREATE TABLE IF NOT EXISTS repo_storage_sets (
    id               TEXT PRIMARY KEY,
    desired_replicas INTEGER NOT NULL DEFAULT 3 CHECK (desired_replicas > 0),
    write_quorum     INTEGER NOT NULL DEFAULT 2 CHECK (write_quorum > 0),
    state            VARCHAR(16) NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active', 'draining', 'disabled')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (write_quorum <= desired_replicas)
);

CREATE TABLE IF NOT EXISTS repo_storage_nodes (
    id             TEXT PRIMARY KEY,
    storage_set_id TEXT NOT NULL REFERENCES repo_storage_sets(id) ON DELETE CASCADE,
    url            TEXT NOT NULL,
    zone           TEXT NOT NULL DEFAULT '',
    state          VARCHAR(16) NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active', 'draining', 'offline')),
    last_seen_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (storage_set_id, url)
);

CREATE INDEX IF NOT EXISTS idx_repo_storage_nodes_storage_set
    ON repo_storage_nodes (storage_set_id, state);

CREATE TABLE IF NOT EXISTS repo_replicas (
    repository_id    BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    node_id          TEXT NOT NULL REFERENCES repo_storage_nodes(id) ON DELETE CASCADE,
    generation       BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    state_hash       TEXT NOT NULL DEFAULT '',
    state            VARCHAR(16) NOT NULL DEFAULT 'stale'
                     CHECK (state IN ('current', 'stale', 'repairing', 'missing')),
    last_verified_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_repo_replicas_repository_state
    ON repo_replicas (repository_id, state, generation DESC);
CREATE INDEX IF NOT EXISTS idx_repo_replicas_node_state
    ON repo_replicas (node_id, state);

CREATE TABLE IF NOT EXISTS repo_write_locks (
    repository_id BIGINT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    generation    BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    locked_by     TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_write_locks_expires_at
    ON repo_write_locks (expires_at);

CREATE TABLE IF NOT EXISTS repo_replication_jobs (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_node_id TEXT REFERENCES repo_storage_nodes(id) ON DELETE SET NULL,
    target_node_id TEXT NOT NULL REFERENCES repo_storage_nodes(id) ON DELETE CASCADE,
    generation     BIGINT NOT NULL CHECK (generation >= 0),
    state          VARCHAR(16) NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
    attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error          TEXT NOT NULL DEFAULT '',
    run_after      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_replication_jobs_claim
    ON repo_replication_jobs (state, run_after, id);
CREATE INDEX IF NOT EXISTS idx_repo_replication_jobs_repository
    ON repo_replication_jobs (repository_id, generation DESC);
