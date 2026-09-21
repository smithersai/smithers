-- Persist explicit completion for branch-memory cleanup snapshots. A retry
-- must recapture all pages until this marker is set, including empty sets.
ALTER TABLE memory_cleanup_tasks
    ADD COLUMN snapshot_completed_at TIMESTAMPTZ;
