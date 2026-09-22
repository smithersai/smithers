-- Durable authority for one canonical TypeScript host per authorized
-- workspace/catalog binding. These rows do not contain graph or run state;
-- Control's journal remains the only runtime authority.
CREATE TABLE flow_runtime_host_bindings (
    id UUID PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    binding_kind TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    repository_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    workspace_id UUID NOT NULL,
    catalog_key TEXT NOT NULL,
    service_name TEXT NOT NULL,
    runtime_artifact_digest TEXT NOT NULL CHECK (runtime_artifact_digest ~ '^[0-9a-f]{64}$'),
    source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
    owner_generation BIGINT NOT NULL CHECK (owner_generation > 0),
    credential_ciphertext TEXT NOT NULL,
    credential_hash BYTEA NOT NULL CHECK (octet_length(credential_hash) = 32),
    state TEXT NOT NULL CHECK (state IN ('pending', 'starting', 'running', 'failed', 'retired')),
    last_error_code TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, catalog_key),
    CHECK (tenant_id <> '' AND principal_id <> '' AND binding_kind <> '' AND binding_id <> ''),
    CHECK (catalog_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CHECK (service_name ~ '^[A-Za-z0-9_.@:-]{1,128}$'),
    CHECK (credential_ciphertext <> '')
);

CREATE INDEX flow_runtime_host_bindings_repository
    ON flow_runtime_host_bindings (repository_id, user_id, workspace_id);

-- These immutable identifiers deliberately survive parent deletion. A live
-- binding is admitted only while Store holds a share lock on its workspace.
-- Workspace deletion (also reached through repository/user FK cascades) leaves
-- a durable cleanup record, never a lost process/bearer or a blocked deletion.
CREATE FUNCTION retire_deleted_workspace_flow_hosts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE flow_runtime_host_bindings
       SET state = 'retired', updated_at = clock_timestamp()
     WHERE workspace_id = OLD.id AND state <> 'retired';
    RETURN OLD;
END;
$$;
CREATE TRIGGER retire_deleted_workspace_flow_hosts
    BEFORE DELETE ON workspaces FOR EACH ROW
    EXECUTE FUNCTION retire_deleted_workspace_flow_hosts();

CREATE FUNCTION retire_tombstoned_workspace_flow_hosts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL THEN
        UPDATE flow_runtime_host_bindings
           SET state = 'retired', updated_at = clock_timestamp()
         WHERE workspace_id = NEW.id AND state <> 'retired';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER retire_tombstoned_workspace_flow_hosts
    AFTER UPDATE OF deleted_at ON workspaces FOR EACH ROW
    EXECUTE FUNCTION retire_tombstoned_workspace_flow_hosts();

CREATE INDEX flow_runtime_host_bindings_retired
    ON flow_runtime_host_bindings (updated_at, id) WHERE state = 'retired';
