-- Revocation events identify workspace credentials by sandbox id. Support the
-- controller's bulk grant invalidation without scanning every access
-- permission row.
CREATE INDEX IF NOT EXISTS sandbox_access_permissions_sandbox_idx
    ON sandbox_access_permissions (sandbox_id, identity_id);
