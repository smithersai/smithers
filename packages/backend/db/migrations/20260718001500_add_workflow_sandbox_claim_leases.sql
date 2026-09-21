-- Durable ownership for whole-workflow sandbox execution.
--
-- Keep the lease in a companion table instead of adding columns to
-- workflow_runs: old binaries use SELECT/RETURNING * for workflow_runs, so a
-- companion table preserves their row shape during a rolling deployment.
CREATE TABLE workflow_sandbox_claims (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    generation BIGINT NOT NULL DEFAULT 0
        CONSTRAINT workflow_sandbox_claims_generation_nonnegative CHECK (generation >= 0),
    claim_token UUID,
    claimed_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    CONSTRAINT workflow_sandbox_claims_active_fields_match CHECK (
        (claim_token IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
        OR
        (claim_token IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_workflow_sandbox_claims_active_token
    ON workflow_sandbox_claims (claim_token)
    WHERE claim_token IS NOT NULL;

CREATE INDEX idx_workflow_sandbox_claims_expiry
    ON workflow_sandbox_claims (lease_expires_at, workflow_run_id)
    WHERE claim_token IS NOT NULL;

-- A previous-version scheduler terminalizes by status alone. Once a new
-- scheduler owns a run, reject that unfenced write. New terminalization sets
-- transaction-local claim context and binds the UPDATE to the active row.
-- Also reject queued -> terminal writes for sandbox runs: after cancel/resume
-- a stale previous worker otherwise matches its old `status IN
-- ('queued','running')` predicate before the replacement worker is claimed.
CREATE OR REPLACE FUNCTION guard_workflow_sandbox_terminal_claim()
RETURNS TRIGGER AS $$
DECLARE
    active_claim workflow_sandbox_claims%ROWTYPE;
BEGIN
    IF OLD.execution_plane IS DISTINCT FROM 'sandbox'
       OR NEW.status NOT IN ('success', 'failure') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'queued' THEN
        RETURN NULL;
    END IF;

    SELECT *
    INTO active_claim
    FROM workflow_sandbox_claims
    WHERE workflow_run_id = OLD.id
      AND claim_token IS NOT NULL;

    IF FOUND
       AND (
           current_setting('smithers.workflow_sandbox_claim_token', true)
               IS DISTINCT FROM active_claim.claim_token::text
           OR current_setting('smithers.workflow_sandbox_claim_generation', true)
               IS DISTINCT FROM active_claim.generation::text
       ) THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_runs_40_sandbox_terminal_claim_guard
    BEFORE UPDATE OF status ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION guard_workflow_sandbox_terminal_claim();

-- Every terminal/cancel transition invalidates the active generation in the
-- same transaction as the workflow status change. A resumed run therefore
-- cannot be completed by its pre-cancel worker, even before a new worker has
-- claimed the queued generation.
CREATE OR REPLACE FUNCTION invalidate_workflow_sandbox_claim()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.execution_plane = 'sandbox'
       AND NEW.status IN ('success', 'failure', 'cancelled')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE workflow_sandbox_claims
        SET generation = generation + 1,
            claim_token = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL
        WHERE workflow_run_id = NEW.id
          AND claim_token IS NOT NULL;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_runs_90_invalidate_sandbox_claim
    AFTER UPDATE OF status ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION invalidate_workflow_sandbox_claim();

-- Tombstoning a workspace and stopping its sessions must be one atomic state
-- transition, including when a previous-version binary issues the original
-- one-row workspace UPDATE. CreateWorkspaceSession locks the parent workspace
-- first, so this trigger also closes the concurrent insert race.
CREATE OR REPLACE FUNCTION stop_workspace_sessions_on_tombstone()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL
       AND (OLD.deleted_at IS NULL OR NEW.status IS DISTINCT FROM OLD.status) THEN
        UPDATE workspace_sessions
        SET status = 'stopped',
            updated_at = NOW()
        WHERE workspace_id = NEW.id
          AND status IN ('pending', 'starting', 'running');
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workspaces_stop_sessions_on_tombstone
    AFTER UPDATE OF deleted_at, status ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION stop_workspace_sessions_on_tombstone();

-- Enforce the live-parent check below the query layer as well so a
-- previous-version API pod cannot create a session after a new-version pod
-- tombstones the workspace. The parent FOR UPDATE lock gives inserts and the
-- tombstone transition one deterministic serialization point.
CREATE OR REPLACE FUNCTION guard_workspace_session_live_parent_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1
    FROM workspaces
    WHERE id = NEW.workspace_id
      AND repository_id = NEW.repository_id
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workspace_sessions_live_parent_insert
    BEFORE INSERT ON workspace_sessions
    FOR EACH ROW
    EXECUTE FUNCTION guard_workspace_session_live_parent_insert();

-- Detached provisioners use a pending/starting -> running CAS, but retain a
-- database backstop for rolling deployments. No parent lock is needed here:
-- the session row already serializes with the tombstone's AFTER trigger. If
-- the provisioner wins, the tombstone subsequently stops it; if deletion wins,
-- this trigger observes deleted_at and suppresses resurrection.
CREATE OR REPLACE FUNCTION guard_workspace_session_active_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('pending', 'starting', 'running')
       AND NOT EXISTS (
           SELECT 1
           FROM workspaces
           WHERE id = NEW.workspace_id
             AND deleted_at IS NULL
       ) THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workspace_sessions_active_status_guard
    BEFORE UPDATE OF status ON workspace_sessions
    FOR EACH ROW
    EXECUTE FUNCTION guard_workspace_session_active_status();
