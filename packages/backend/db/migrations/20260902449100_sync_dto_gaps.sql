-- Persist the provider identity shown by the Linear connection card and the
-- per-repository ref counts shown by the GitHub mirror status card.
-- smithers:migration-contract-reviewed: additive columns with defaults only

ALTER TABLE linear_integrations
    ADD COLUMN IF NOT EXISTS linear_actor_name VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS linear_actor_email VARCHAR(320) NOT NULL DEFAULT '';

ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS mirror_behind_refs INTEGER NOT NULL DEFAULT 0
        CHECK (mirror_behind_refs >= 0),
    ADD COLUMN IF NOT EXISTS mirror_failed_refs INTEGER NOT NULL DEFAULT 0
        CHECK (mirror_failed_refs >= 0);

CREATE INDEX IF NOT EXISTS idx_linear_sync_ops_feed
    ON linear_sync_ops (integration_id, created_at DESC, id DESC);
