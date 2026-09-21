-- Ticket 0107: generic devtools snapshot surface.
--
-- Agent runtime emits the current "what I'm looking at" snapshot via the
-- guest-agent MethodWriteDevtoolsSnapshot (gated by
-- CapabilityDevtoolsSnapshotsWrite, ticket 0131). Smithers persists one row per
-- (session_id, kind) using UPSERT semantics; the Electric shape
-- `devtools_snapshots` (see internal/electric/shapes.go -> ShapeDevtoolsSnapshots)
-- delivers the latest row to connected clients.
--
-- RETENTION POLICY: latest-per-kind. This table is NOT a history log. Old
-- snapshots for the same (session_id, kind) are clobbered on every write via
-- the composite UNIQUE constraint + ON CONFLICT DO UPDATE path. Pruning rows
-- attached to deleted sessions is handled by the ON DELETE CASCADE from
-- agent_sessions; no background sweeper exists in v1.
--
-- LARGE PAYLOADS: app-layer capped at 256 KiB in internal/services/devtools.go
-- and the guest-agent handler. Payloads larger than that (screenshots, big
-- file trees) must be uploaded to blob storage by the client and referenced
-- by URL inside the JSON payload. Blob storage integration is out of scope
-- for ticket 0107.
--
-- repository_id is NOT NULL + denormalized onto every row: the Electric
-- shape auth middleware rejects any subscription whose where-clause does
-- not filter by repository_id (internal/electric/auth.go). Deriving it
-- on the read path would require a JOIN which Electric does not support
-- in a shape filter.
--
-- Forward-only migration; atlas.sum regenerated via `atlas migrate hash`.

CREATE TABLE IF NOT EXISTS devtools_snapshots (
    session_id     UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('file_tree', 'screenshot', 'command_output', 'tool_state')),
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Latest-per-kind: enforced by the composite primary key. A second write
    -- for the same (session_id, kind) hits the UNIQUE constraint and the
    -- service layer's ON CONFLICT DO UPDATE clause clobbers the old row.
    PRIMARY KEY (session_id, kind)
);

-- Backs the production Electric shape (ShapeDevtoolsSnapshots). Clients open
-- one shape per (repo, [session...]) tuple; the leading repository_id column
-- lets the proxy's repo-scope filter use this index directly, and the
-- trailing session_id column supports the per-tab session filter.
CREATE INDEX IF NOT EXISTS idx_devtools_snapshots_repo_session
    ON devtools_snapshots (repository_id, session_id);
