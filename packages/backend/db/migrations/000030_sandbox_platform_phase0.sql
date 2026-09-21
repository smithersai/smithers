-- Phase 0: Sandbox platform preparation
-- Rename provider-specific columns to provider-neutral names
-- and add new sandbox tables for the Firecracker sandbox platform.

-- 1. Rename freestyle_vm_id -> vm_id in workflow_tasks
ALTER TABLE workflow_tasks RENAME COLUMN freestyle_vm_id TO vm_id;
DROP INDEX IF EXISTS idx_workflow_tasks_freestyle_vm_id;
CREATE INDEX idx_workflow_tasks_vm_id
    ON workflow_tasks (vm_id)
    WHERE vm_id IS NOT NULL;

-- 2. Rename freestyle_vm_id -> vm_id in workspaces
ALTER TABLE workspaces RENAME COLUMN freestyle_vm_id TO vm_id;
-- Recreate the unique index with the new column name
DROP INDEX IF EXISTS uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id)
    WHERE is_fork = FALSE
      AND (
          status IN ('running', 'suspended')
          OR (status = 'starting' AND vm_id <> '')
      );

-- 3. Rename freestyle_snapshot_id -> snapshot_id in workspace_snapshots
ALTER TABLE workspace_snapshots RENAME COLUMN freestyle_snapshot_id TO snapshot_id;

-- 4. Add sandbox_hosts table
CREATE TABLE IF NOT EXISTS sandbox_hosts (
    id                     TEXT PRIMARY KEY,
    provider               TEXT NOT NULL,
    region                 TEXT NOT NULL,
    zone                   TEXT NOT NULL,
    instance_name          TEXT NOT NULL,
    private_addr           TEXT NOT NULL,
    state                  TEXT NOT NULL DEFAULT 'healthy'
                           CHECK (state IN ('healthy', 'draining', 'unhealthy', 'deleted')),
    firecracker_version    TEXT NOT NULL,
    kernel_image_version   TEXT NOT NULL,
    cpu_capacity           INTEGER NOT NULL,
    mem_capacity_mb        INTEGER NOT NULL,
    disk_capacity_bytes    BIGINT NOT NULL,
    cpu_allocated          INTEGER NOT NULL DEFAULT 0,
    mem_allocated_mb       INTEGER NOT NULL DEFAULT 0,
    disk_allocated_bytes   BIGINT NOT NULL DEFAULT 0,
    last_seen_at           TIMESTAMPTZ NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sandbox_hosts_state ON sandbox_hosts (state) WHERE state IN ('healthy', 'draining');

-- 5. Add sandbox_vms table
CREATE TABLE IF NOT EXISTS sandbox_vms (
    id                 TEXT PRIMARY KEY,
    workspace_id       UUID REFERENCES workspaces(id),
    agent_session_id   UUID REFERENCES agent_sessions(id),
    workflow_run_id    BIGINT REFERENCES workflow_runs(id),
    host_id            TEXT NOT NULL REFERENCES sandbox_hosts(id),
    kind               TEXT NOT NULL CHECK (kind IN ('workspace', 'preview', 'agent', 'workflow')),
    state              TEXT NOT NULL DEFAULT 'starting'
                       CHECK (state IN ('starting', 'running', 'suspended', 'stopped', 'failed', 'deleting')),
    guest_ip           TEXT NOT NULL DEFAULT '',
    guest_cid          INTEGER NOT NULL DEFAULT 0,
    vcpus              INTEGER NOT NULL,
    memory_mb          INTEGER NOT NULL,
    rootfs_size_mb     BIGINT NOT NULL,
    disk_ref           TEXT NOT NULL DEFAULT '',
    snapshot_ref       TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sandbox_vms_host_id ON sandbox_vms (host_id);
CREATE INDEX idx_sandbox_vms_workspace_id ON sandbox_vms (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX idx_sandbox_vms_state ON sandbox_vms (state) WHERE state IN ('starting', 'running', 'suspended');

-- 6. Add sandbox_access_tokens table
CREATE TABLE IF NOT EXISTS sandbox_access_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID REFERENCES workspaces(id),
    vm_id           TEXT NOT NULL,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    linux_user      TEXT NOT NULL,
    token_hash      BYTEA NOT NULL,
    token_type      TEXT NOT NULL CHECK (token_type IN ('ssh', 'terminal')),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sandbox_access_tokens_vm_id ON sandbox_access_tokens (vm_id);
CREATE INDEX idx_sandbox_access_tokens_expires_at ON sandbox_access_tokens (expires_at);

-- 7. Add sandbox_operations table
CREATE TABLE IF NOT EXISTS sandbox_operations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vm_id           TEXT NOT NULL,
    workspace_id    UUID,
    op_type         TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'running', 'done', 'failed')),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    error           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sandbox_operations_vm_id ON sandbox_operations (vm_id);
CREATE INDEX idx_sandbox_operations_state ON sandbox_operations (state) WHERE state IN ('pending', 'running');
