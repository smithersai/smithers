-- Revision: 20260718001100.
-- Provider-neutral sandbox placement state for the self-hosted Microsandbox
-- control plane. Product rows continue to carry their stable provider-local
-- IDs during the expand phase; these tables own placement and reconciliation.

CREATE TABLE sandbox_hosts (
    id text PRIMARY KEY,
    provider text NOT NULL DEFAULT 'microsandbox',
    identity_public_key bytea NOT NULL CHECK (octet_length(identity_public_key) = 32),
    identity_signed_at timestamptz NOT NULL,
    base_url text NOT NULL,
    boot_id text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT 'ready'
        CHECK (state IN ('ready', 'draining', 'stale', 'fenced')),
    placement_generation bigint NOT NULL DEFAULT 1 CHECK (placement_generation > 0),
    capacity_cpu_millis bigint NOT NULL CHECK (capacity_cpu_millis >= 0),
    capacity_memory_bytes bigint NOT NULL CHECK (capacity_memory_bytes >= 0),
    capacity_disk_bytes bigint NOT NULL CHECK (capacity_disk_bytes >= 0),
    capacity_vms integer NOT NULL CHECK (capacity_vms >= 0),
    allocated_cpu_millis bigint NOT NULL DEFAULT 0 CHECK (allocated_cpu_millis >= 0),
    allocated_memory_bytes bigint NOT NULL DEFAULT 0 CHECK (allocated_memory_bytes >= 0),
    allocated_disk_bytes bigint NOT NULL DEFAULT 0 CHECK (allocated_disk_bytes >= 0),
    allocated_vms integer NOT NULL DEFAULT 0 CHECK (allocated_vms >= 0),
    observed_allocated_cpu_millis bigint NOT NULL DEFAULT 0 CHECK (observed_allocated_cpu_millis >= 0),
    observed_allocated_memory_bytes bigint NOT NULL DEFAULT 0 CHECK (observed_allocated_memory_bytes >= 0),
    observed_allocated_disk_bytes bigint NOT NULL DEFAULT 0 CHECK (observed_allocated_disk_bytes >= 0),
    observed_allocated_vms integer NOT NULL DEFAULT 0 CHECK (observed_allocated_vms >= 0),
    capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
    runtime_version text NOT NULL DEFAULT '',
    worker_image text NOT NULL DEFAULT '',
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    lease_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sandbox_hosts_schedulable_idx
    ON sandbox_hosts (state, lease_expires_at, allocated_vms, heartbeat_at);

CREATE TABLE sandbox_instances (
    id text PRIMARY KEY,
    provider text NOT NULL,
    provider_local_id text NOT NULL,
    worker_id text REFERENCES sandbox_hosts(id) ON DELETE SET NULL,
    placement_generation bigint NOT NULL DEFAULT 1 CHECK (placement_generation > 0),
    desired_state text NOT NULL DEFAULT 'running'
        CHECK (desired_state IN ('created', 'running', 'stopped', 'deleted')),
    observed_state text NOT NULL DEFAULT 'starting'
        CHECK (observed_state IN ('created', 'starting', 'running', 'stopping', 'stopped', 'restart_pending', 'recovering', 'deleting', 'degraded', 'failed', 'deleted')),
    resource_kind text,
    resource_id text,
    image_ref text NOT NULL DEFAULT '',
    snapshot_id text,
    recovery_snapshot_id text,
    recovery_point_at timestamptz,
    request_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
    recovery_services jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(recovery_services) = 'array'),
    requested_cpu_millis bigint NOT NULL DEFAULT 1000 CHECK (requested_cpu_millis >= 0),
    requested_memory_bytes bigint NOT NULL DEFAULT 0 CHECK (requested_memory_bytes >= 0),
    requested_disk_bytes bigint NOT NULL DEFAULT 0 CHECK (requested_disk_bytes >= 0),
    lease_owner text,
    lease_expires_at timestamptz,
    last_heartbeat_at timestamptz,
    cleanup_pending boolean NOT NULL DEFAULT false,
    recovery_reason text NOT NULL DEFAULT ''
        CHECK (recovery_reason IN ('', 'worker_lost', 'planned_drain', 'secrets_required')),
    last_error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (provider, provider_local_id)
);

CREATE INDEX sandbox_instances_worker_state_idx
    ON sandbox_instances (worker_id, observed_state)
    WHERE deleted_at IS NULL;
CREATE INDEX sandbox_instances_resource_idx
    ON sandbox_instances (resource_kind, resource_id)
    WHERE deleted_at IS NULL;

CREATE TABLE sandbox_operations (
    idempotency_key text PRIMARY KEY,
    sandbox_id text REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    operation text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'succeeded', 'failed')),
    request_digest text NOT NULL,
    response jsonb,
    error_code text NOT NULL DEFAULT '',
    lease_expires_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sandbox_operations_expiry_idx ON sandbox_operations (expires_at);

CREATE TABLE sandbox_snapshots (
    id text PRIMARY KEY,
    provider text NOT NULL,
    provider_local_id text NOT NULL,
    source_sandbox_id text REFERENCES sandbox_instances(id) ON DELETE SET NULL,
    worker_id text REFERENCES sandbox_hosts(id) ON DELETE SET NULL,
    placement_generation bigint NOT NULL CHECK (placement_generation > 0),
    state text NOT NULL DEFAULT 'creating'
        CHECK (state IN ('creating', 'ready', 'exporting', 'exported', 'failed', 'deleting', 'deleted')),
    scope text NOT NULL DEFAULT 'disk' CHECK (scope = 'disk'),
    object_uri text,
    digest text,
    size_bytes bigint,
    cleanup_owner text,
    cleanup_lease_expires_at timestamptz,
    garbage_collectible boolean NOT NULL DEFAULT false,
    last_error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (provider, provider_local_id)
);

CREATE INDEX sandbox_snapshots_cleanup_idx
    ON sandbox_snapshots (state, updated_at, cleanup_lease_expires_at)
    WHERE deleted_at IS NULL;

CREATE TABLE sandbox_volumes (
    id text PRIMARY KEY,
    provider text NOT NULL,
    provider_local_id text NOT NULL,
    worker_id text REFERENCES sandbox_hosts(id) ON DELETE SET NULL,
    placement_generation bigint NOT NULL DEFAULT 1 CHECK (placement_generation > 0),
    state text NOT NULL DEFAULT 'created',
    quota_bytes bigint CHECK (quota_bytes IS NULL OR quota_bytes >= 0),
    object_uri text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (provider, provider_local_id)
);

CREATE TABLE sandbox_access_identities (
    id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE TABLE sandbox_access_permissions (
    id text PRIMARY KEY,
    identity_id text NOT NULL REFERENCES sandbox_access_identities(id) ON DELETE CASCADE,
    sandbox_id text NOT NULL REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    allowed_users text[] NOT NULL DEFAULT '{}',
    placement_generation bigint NOT NULL CHECK (placement_generation > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (identity_id, sandbox_id)
);

CREATE TABLE sandbox_access_grants (
    id text PRIMARY KEY,
    identity_id text NOT NULL REFERENCES sandbox_access_identities(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    protocol text NOT NULL DEFAULT 'ssh' CHECK (protocol IN ('ssh', 'terminal', 'preview')),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sandbox_access_grants_expiry_idx
    ON sandbox_access_grants (expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE sandbox_domain_mappings (
    domain text PRIMARY KEY,
    sandbox_id text NOT NULL REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    guest_port integer NOT NULL CHECK (guest_port > 0 AND guest_port <= 65535),
    placement_generation bigint NOT NULL CHECK (placement_generation > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sandbox_orphans (
    worker_id text NOT NULL REFERENCES sandbox_hosts(id) ON DELETE CASCADE,
    provider_local_id text NOT NULL,
    placement_generation bigint NOT NULL CHECK (placement_generation > 0),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    delete_after timestamptz NOT NULL,
    PRIMARY KEY (worker_id, provider_local_id, placement_generation)
);

CREATE INDEX sandbox_orphans_delete_idx
    ON sandbox_orphans (worker_id, delete_after);
