-- When a mythical lane started its current attempt, and which pooled
-- provider account served each workspace's model calls.
--
-- lane_started_at is written with the launch that opens an attempt's lane
-- (coding/request admitted in the same transaction), so the monitor shows a
-- lane's elapsed time rather than the item's last save.
ALTER TABLE mythical_items ADD COLUMN lane_started_at timestamptz;

-- The account pool (0025) picks an account per model call. Every call a
-- workspace's pool credential makes that an account answers successfully is
-- counted against that account and the model the call named. No credential
-- material is stored here.
CREATE TABLE workspace_provider_uses (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    model varchar(128) NOT NULL DEFAULT '',
    calls bigint NOT NULL DEFAULT 1 CHECK (calls > 0),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, connection_id, model)
);
