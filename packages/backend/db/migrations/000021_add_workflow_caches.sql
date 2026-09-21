CREATE TABLE IF NOT EXISTS workflow_caches (
    id                BIGSERIAL PRIMARY KEY,
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_run_id   BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    bookmark_name     VARCHAR(255) NOT NULL,
    cache_key         VARCHAR(512) NOT NULL,
    cache_version     VARCHAR(64) NOT NULL DEFAULT 'static',
    object_key        TEXT NOT NULL,
    object_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (object_size_bytes >= 0),
    compression       VARCHAR(32) NOT NULL DEFAULT 'tar+gzip',
    status            VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'finalized')),
    hit_count         BIGINT NOT NULL DEFAULT 0,
    last_hit_at       TIMESTAMPTZ,
    finalized_at      TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, bookmark_name, cache_key, cache_version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_caches_repo_id
    ON workflow_caches (repository_id);
CREATE INDEX IF NOT EXISTS idx_workflow_caches_restore_lookup
    ON workflow_caches (
        repository_id,
        bookmark_name,
        cache_key,
        cache_version,
        status,
        expires_at DESC
    );
CREATE INDEX IF NOT EXISTS idx_workflow_caches_eviction
    ON workflow_caches (
        repository_id,
        status,
        expires_at,
        last_hit_at,
        finalized_at,
        updated_at,
        created_at
    );
