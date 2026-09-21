-- The workspace coding host's own run identity for one dispatched agent turn.
-- A dispatched turn is started over the workspace gateway, which answers with
-- the host's runId; every gateway projection a poller reads is selected by
-- that id. Without it a restarted poller cannot find the turn it was
-- streaming, and a finished turn cannot be reconciled with its workflow run.
--
-- It is a side table rather than a workflow_runs column on purpose: adding a
-- column changes the SELECT/RETURNING * row shape that previous-version
-- binaries consume during a rolling deployment, which is the same reason
-- workflow_sandbox_claims lives outside the table. Expand-only.
CREATE TABLE workflow_run_coding_hosts (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    host_run_id     TEXT NOT NULL
        CONSTRAINT workflow_run_coding_hosts_host_run_id_present CHECK (host_run_id <> ''),
    flow_id         TEXT NOT NULL
        CONSTRAINT workflow_run_coding_hosts_flow_id_present CHECK (flow_id <> ''),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflow_run_coding_hosts_workspace
    ON workflow_run_coding_hosts (workspace_id, workflow_run_id);
