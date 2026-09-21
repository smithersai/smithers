-- linear_integrations.webhook_key was added to db/schema.sql and to the sqlc
-- queries (db/queries/linear_integrations.sql) without a migration, so every
-- deployed database lacked the column and GET /api/integrations/linear failed
-- with SQLSTATE 42703. This brings migrations back in line with the snapshot.
ALTER TABLE linear_integrations
    ADD COLUMN IF NOT EXISTS webhook_key VARCHAR(64) NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_linear_integrations_webhook_key
    ON linear_integrations (webhook_key)
    WHERE webhook_key <> '';
