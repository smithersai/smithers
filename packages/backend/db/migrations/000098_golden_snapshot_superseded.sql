-- Golden snapshot GC (2026-07-06). Superseded golden snapshots were never
-- garbage-collected: every 24h bake produced a new 'ready' row + Freestyle
-- snapshot and the prior one leaked forever (DB row + paid Freestyle storage).
-- A 'superseded' status lets the refresher two-phase collect them: phase 1
-- marks stale 'ready' rows superseded (removing them from Current()'s candidate
-- set the instant the new bake lands); phase 2 — on a later sweep, only for
-- rows superseded long enough ago that no other pod's Current() cache can still
-- reference them — best-effort deletes the Freestyle snapshot and the row. This
-- ordering guarantees a snapshot id is never handed to a VM create after its
-- backing Freestyle snapshot is deleted, and the newest 'ready' row (which
-- latestReadyGoldenSnapshotSQL returns) is never touched.
ALTER TABLE sandbox_golden_snapshots
    DROP CONSTRAINT IF EXISTS sandbox_golden_snapshots_status_check;

ALTER TABLE sandbox_golden_snapshots
    ADD CONSTRAINT sandbox_golden_snapshots_status_check
    CHECK (status IN ('baking', 'ready', 'failed', 'superseded'));
