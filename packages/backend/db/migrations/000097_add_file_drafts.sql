-- File drafts: the live-synced multiplayer editing buffer behind the web file
-- editor. One row per (repository, bookmark, path) — the draft IS the shared
-- buffer, exactly like pair_session_draft is for co-compose: local keystrokes
-- land as version-gated whole-buffer writes (CAS upsert, stale versions 409),
-- and every collaborator's editor converges by streaming the row back through
-- the Electric `file_drafts` shape (repo-read-gated, scoped per bookmark).
--
-- Drafts are working state, not history: committing a draft to the branch (or
-- discarding it) tombstones the row via deleted_at so subscribed clients see a
-- visible -> hidden transition through Electric's standard diff machinery.
-- `base_change_id` records the jj change the editor loaded the file from, so
-- the commit path can detect that the branch tip moved underneath the draft
-- (stale-base) instead of silently clobbering newer work.
CREATE TABLE IF NOT EXISTS file_drafts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    bookmark       TEXT NOT NULL,
    path           TEXT NOT NULL,
    content        TEXT NOT NULL DEFAULT '',
    version        BIGINT NOT NULL DEFAULT 0,
    base_change_id TEXT NOT NULL DEFAULT '',
    updated_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    deleted_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The CAS conflict target: one live draft per (repo, bookmark, path).
    CONSTRAINT uq_file_drafts_repo_bookmark_path UNIQUE (repository_id, bookmark, path)
);

-- The Electric shape reads `repository_id IN (...) AND bookmark = '...' AND
-- deleted_at IS NULL`; this partial index serves both the shape's initial
-- snapshot query and the REST list endpoint.
CREATE INDEX IF NOT EXISTS idx_file_drafts_repo_bookmark_live
    ON file_drafts (repository_id, bookmark)
    WHERE deleted_at IS NULL;
