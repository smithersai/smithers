-- Workspace kinds are distinct computers. Permit one active primary of each
-- kind for a user and repository while retaining the activation-race guard.
DROP INDEX IF EXISTS uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id, kind)
    WHERE is_fork = FALSE
      AND deleted_at IS NULL
      AND (
          status IN ('running', 'suspended')
          OR (status = 'starting' AND vm_id <> '')
      );
