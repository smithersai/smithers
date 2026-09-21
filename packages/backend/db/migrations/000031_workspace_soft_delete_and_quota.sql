-- Ticket 0105: sandbox quota + soft-delete semantics
--
-- Adds workspaces.deleted_at (soft-delete tombstone) and an index that
-- supports the per-user active-workspace quota count (100/user).
--
-- Why soft-delete (vs hard delete):
--   * Aligns with 0116 (workspaces production shape) which syncs tombstones
--     via Electric; a hard delete would leave connected clients with stale
--     rows and no way to reconcile.
--   * Reversible — lets support un-tombstone a workspace without restoring
--     from backups.
--   * Consistent with the spec promise "delete one to continue" (0105): a
--     tombstoned row is excluded from the quota count, so the next create
--     succeeds.
--
-- Any query that fed into "is this workspace visible / active?" must treat
-- deleted_at IS NOT NULL as gone. That rewrite lives alongside this migration
-- in db/queries/workspace.sql.

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index supporting the quota count: SELECT COUNT(*) FROM workspaces
-- WHERE user_id = $1 AND deleted_at IS NULL. Only indexes live rows so it
-- stays compact even if a user has cycled through many workspaces.
CREATE INDEX IF NOT EXISTS idx_workspaces_user_active
    ON workspaces (user_id)
    WHERE deleted_at IS NULL;

-- The unique "one active primary workspace per user+repo" index must stop
-- matching tombstoned rows, otherwise a soft-deleted primary workspace would
-- block re-creation on the same repo.
DROP INDEX IF EXISTS uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id)
    WHERE is_fork = FALSE
      AND deleted_at IS NULL
      AND (
          status IN ('running', 'suspended')
          OR (status = 'starting' AND vm_id <> '')
      );

-- Status index — same treatment, don't point at dead rows.
DROP INDEX IF EXISTS idx_workspaces_status;
CREATE INDEX idx_workspaces_status ON workspaces (status)
    WHERE deleted_at IS NULL
      AND status IN ('pending', 'starting', 'running', 'suspended');
