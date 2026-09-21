-- Golden sandbox snapshots (2026-07-06). Every workspace/gateway VM was built
-- from a BARE base image: apt post-boot + Node/jj/bun/smithers downloads + the
-- repo clone ran on every single provision (1–3 minutes). Freestyle's own
-- pattern is a pre-baked snapshot: bake the toolchain once, boot every VM from
-- the snapshot, and the (idempotent, command -v-guarded) bootstrap degrades to
-- a fast verify. This table tracks the current golden snapshot per kind; the
-- partial unique index makes concurrent api pods elect a single baker.
CREATE TABLE sandbox_golden_snapshots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        TEXT NOT NULL,
    snapshot_id TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'baking' CHECK (status IN ('baking', 'ready', 'failed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX sandbox_golden_snapshots_one_baking
    ON sandbox_golden_snapshots (kind) WHERE status = 'baking';
CREATE INDEX sandbox_golden_snapshots_ready
    ON sandbox_golden_snapshots (kind, created_at DESC) WHERE status = 'ready';
