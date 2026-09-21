-- Attribute server-visible jj operations to the workspace that owns their
-- operation log and to every stable change the operation touched. A NULL
-- workspace identifies an operation imported from a local computer, which
-- the server can display but cannot undo.
ALTER TABLE jj_operations
    ADD COLUMN workspace_id UUID,
    ADD COLUMN change_ids TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE jj_operations
    ADD CONSTRAINT jj_operations_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

-- An undo commonly restores a commit that already appeared in this change's
-- history. Keep ordinary push/rebase/agent observations idempotent while
-- allowing that restored commit to become a new, explicit undo revision.
-- smithers:migration-contract-reviewed: smithersai/plue#457, the dropped unique key is immediately replaced by idx_change_revisions_non_undo_commit, which keeps the same guarantee for every non-undo revision.
ALTER TABLE change_revisions
    DROP CONSTRAINT change_revisions_repository_id_change_id_commit_id_key;

CREATE UNIQUE INDEX idx_change_revisions_non_undo_commit
    ON change_revisions (repository_id, change_id, commit_id)
    WHERE source <> 'undo';

-- Existing revision links already identify the blast radius. Preserve them
-- when upgrading, and recover workspace ownership through the verified
-- revision snapshot when that workspace still exists.
WITH linked AS (
    SELECT
        revision.repository_id,
        operation_id,
        ARRAY_AGG(DISTINCT revision.change_id ORDER BY revision.change_id) AS change_ids,
        (ARRAY_AGG(DISTINCT workspace.id) FILTER (WHERE workspace.id IS NOT NULL))[1] AS workspace_id
    FROM change_revisions AS revision
    CROSS JOIN LATERAL UNNEST(revision.operation_ids) AS operation_id
    LEFT JOIN workspace_snapshots AS snapshot ON snapshot.id = revision.workspace_snapshot_id
    LEFT JOIN workspaces AS workspace ON workspace.id::text = snapshot.workspace_id
    GROUP BY revision.repository_id, operation_id
)
UPDATE jj_operations AS operation
SET change_ids = linked.change_ids,
    workspace_id = COALESCE(operation.workspace_id, linked.workspace_id)
FROM linked
WHERE operation.repository_id = linked.repository_id
  AND operation.operation_id = linked.operation_id;

CREATE INDEX idx_jj_operations_workspace_created_at
    ON jj_operations (workspace_id, created_at DESC, id DESC)
    WHERE workspace_id IS NOT NULL;

CREATE INDEX idx_jj_operations_change_ids_gin
    ON jj_operations USING GIN (change_ids);
