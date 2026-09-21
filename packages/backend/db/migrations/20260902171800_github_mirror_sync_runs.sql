-- Durable, pollable GitHub mirror runs and their per-ref outcomes.
-- A run belongs to the Smithers repository being pushed; deleting that
-- repository removes its historical sync activity as well.
-- smithers:migration-contract-reviewed: additive tables only, no data movement

CREATE TABLE IF NOT EXISTS github_mirror_sync_runs (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    requested_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    state          VARCHAR(16) NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_mirror_sync_runs_repository
    ON github_mirror_sync_runs (repository_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS github_mirror_sync_ref_results (
    id             BIGSERIAL PRIMARY KEY,
    run_id         BIGINT NOT NULL REFERENCES github_mirror_sync_runs(id) ON DELETE CASCADE,
    name           TEXT NOT NULL CHECK (LENGTH(name) BETWEEN 1 AND 1024),
    from_revision  TEXT NOT NULL DEFAULT '',
    to_revision    TEXT NOT NULL DEFAULT '',
    status         VARCHAR(16) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'succeeded', 'failed')),
    error          TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, name),
    CHECK (from_revision <> '' OR to_revision <> '')
);

CREATE INDEX IF NOT EXISTS idx_github_mirror_sync_ref_results_run
    ON github_mirror_sync_ref_results (run_id, name);
