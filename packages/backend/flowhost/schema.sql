-- Durable authority for one canonical TypeScript host per authorized
-- workspace/catalog binding. These rows do not contain graph or run state;
-- Control's journal remains the only runtime authority.
CREATE TABLE IF NOT EXISTS flow_runtime_host_bindings (
    id UUID PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    binding_kind TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    catalog_key TEXT NOT NULL,
    service_name TEXT NOT NULL,
    runtime_artifact_digest TEXT NOT NULL CHECK (runtime_artifact_digest ~ '^[0-9a-f]{64}$'),
    source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
    owner_generation BIGINT NOT NULL CHECK (owner_generation > 0),
    credential_ciphertext TEXT NOT NULL,
    credential_hash BYTEA NOT NULL CHECK (octet_length(credential_hash) = 32),
    state TEXT NOT NULL CHECK (state IN ('pending', 'starting', 'running', 'failed')),
    last_error_code TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, principal_id, binding_kind, binding_id, catalog_key),
    UNIQUE (workspace_id, catalog_key),
    CHECK (tenant_id <> '' AND principal_id <> '' AND binding_kind <> '' AND binding_id <> ''),
    CHECK (catalog_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CHECK (service_name ~ '^[A-Za-z0-9_.@:-]{1,128}$'),
    CHECK (credential_ciphertext <> '')
);

CREATE INDEX IF NOT EXISTS flow_runtime_host_bindings_repository
    ON flow_runtime_host_bindings (repository_id, user_id, workspace_id);
