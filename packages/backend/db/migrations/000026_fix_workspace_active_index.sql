DROP INDEX IF EXISTS uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id)
    WHERE is_fork = FALSE
      AND (
          status IN ('running', 'suspended')
          OR (status = 'starting' AND freestyle_vm_id <> '')
      );
