-- Normalize workspace lineage columns to the schema expected by current code.
--
-- Historical migrations added parent_workspace_id/source_snapshot_id as
-- TEXT NOT NULL DEFAULT ''. Current sqlc models and service code treat both as
-- nullable UUIDs:
--   * parent_workspace_id references workspaces(id) ON DELETE SET NULL
--   * source_snapshot_id references workspace_snapshots(id) ON DELETE SET NULL
--
-- Empty strings and any non-UUID legacy values are not valid lineage pointers,
-- so they are cleared to NULL during the type conversion.

ALTER TABLE workspaces
    DROP CONSTRAINT IF EXISTS workspaces_parent_workspace_id_fkey,
    DROP CONSTRAINT IF EXISTS workspaces_source_snapshot_id_fkey;

ALTER TABLE workspaces
    ALTER COLUMN parent_workspace_id DROP DEFAULT,
    ALTER COLUMN parent_workspace_id DROP NOT NULL,
    ALTER COLUMN parent_workspace_id TYPE UUID USING
        CASE
            WHEN parent_workspace_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN parent_workspace_id::text::uuid
            ELSE NULL
        END,
    ALTER COLUMN source_snapshot_id DROP DEFAULT,
    ALTER COLUMN source_snapshot_id DROP NOT NULL,
    ALTER COLUMN source_snapshot_id TYPE UUID USING
        CASE
            WHEN source_snapshot_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN source_snapshot_id::text::uuid
            ELSE NULL
        END;

UPDATE workspaces AS w
SET parent_workspace_id = NULL
WHERE parent_workspace_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM workspaces AS parent
      WHERE parent.id = w.parent_workspace_id
  );

UPDATE workspaces AS w
SET source_snapshot_id = NULL
WHERE source_snapshot_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM workspace_snapshots AS snapshot
      WHERE snapshot.id = w.source_snapshot_id
  );

ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_parent_workspace_id_fkey
        FOREIGN KEY (parent_workspace_id)
        REFERENCES workspaces(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT workspaces_source_snapshot_id_fkey
        FOREIGN KEY (source_snapshot_id)
        REFERENCES workspace_snapshots(id)
        ON DELETE SET NULL;
