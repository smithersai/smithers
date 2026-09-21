ALTER TABLE releases
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

UPDATE releases
SET published_at = created_at
WHERE is_draft = FALSE
  AND published_at IS NULL;

DROP INDEX IF EXISTS idx_releases_repo_id;
CREATE INDEX idx_releases_repo_id ON releases (repository_id, (COALESCE(published_at, created_at)) DESC, id DESC);
