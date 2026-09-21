-- smithers build cache hosted per repository: the exact /ac + /cas protocol
-- the smithers-build CLI and the Smithers engine already speak, with action
-- entries in Postgres and artifact bytes in the blob store. Every row is
-- keyed by repository so two repositories never share a namespace. Public
-- read tokens (smithers_cachero_...) are a separate token kind that can only
-- read one repository's cache; they never touch access_tokens.
-- Additive only: four new tables, no backfill.
-- smithers:migration-contract-reviewed: additive tables only, no data movement
CREATE TABLE IF NOT EXISTS build_cache_entries (
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    key_digest         TEXT NOT NULL CHECK (octet_length(key_digest) BETWEEN 1 AND 512),
    body               TEXT NOT NULL CHECK (octet_length(body) <= 1048576),
    result_canonical   TEXT NOT NULL,
    created_at_ms      BIGINT CHECK (created_at_ms IS NULL OR created_at_ms >= 0),
    recorded_run_id    TEXT CHECK (recorded_run_id IS NULL OR octet_length(recorded_run_id) BETWEEN 1 AND 512),
    recorded_event_seq BIGINT CHECK (recorded_event_seq IS NULL OR recorded_event_seq >= 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_count       BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (repository_id, key_digest),
    CHECK ((recorded_run_id IS NULL) = (recorded_event_seq IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_build_cache_entries_repo_accessed
    ON build_cache_entries (repository_id, last_accessed_at);

CREATE TABLE IF NOT EXISTS build_cache_artifacts (
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    digest             CHAR(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    size_bytes         BIGINT NOT NULL CHECK (size_bytes >= 0),
    gcs_key            TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_count       BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (repository_id, digest)
);

CREATE INDEX IF NOT EXISTS idx_build_cache_artifacts_repo_accessed
    ON build_cache_artifacts (repository_id, last_accessed_at);

CREATE TABLE IF NOT EXISTS build_cache_entry_artifacts (
    repository_id      BIGINT NOT NULL,
    key_digest         TEXT NOT NULL,
    digest             CHAR(64) NOT NULL,
    PRIMARY KEY (repository_id, key_digest, digest),
    FOREIGN KEY (repository_id, key_digest)
        REFERENCES build_cache_entries(repository_id, key_digest) ON DELETE CASCADE,
    FOREIGN KEY (repository_id, digest)
        REFERENCES build_cache_artifacts(repository_id, digest) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_build_cache_entry_artifacts_digest
    ON build_cache_entry_artifacts (repository_id, digest);

CREATE TABLE IF NOT EXISTS build_cache_read_tokens (
    id                 BIGSERIAL PRIMARY KEY,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    name               VARCHAR(255) NOT NULL DEFAULT '',
    token_hash         VARCHAR(64) NOT NULL UNIQUE,
    token_last_eight   VARCHAR(8) NOT NULL DEFAULT '',
    last_used_at       TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_build_cache_read_tokens_repo_active
    ON build_cache_read_tokens (repository_id) WHERE revoked_at IS NULL;
