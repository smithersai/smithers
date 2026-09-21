-- Sync queue for local-first daemon mode.
-- Queues outbound mutations from the local client to the server.
CREATE TABLE IF NOT EXISTS _sync_queue (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    method        VARCHAR(8) NOT NULL,
    path          TEXT NOT NULL,
    body          JSONB,
    local_id      TEXT,
    remote_id     TEXT,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'synced', 'conflict', 'failed')),
    error_message TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON _sync_queue (status, created_at);

-- ID remap table for local-first sync (local UUID → server-assigned ID).
CREATE TABLE IF NOT EXISTS _id_remap (
    local_id      TEXT PRIMARY KEY,
    remote_id     TEXT,
    resource_type TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    remapped_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_id_remap_resource_type ON _id_remap (resource_type);
CREATE INDEX IF NOT EXISTS idx_id_remap_remote_id ON _id_remap (remote_id) WHERE remote_id IS NOT NULL;
