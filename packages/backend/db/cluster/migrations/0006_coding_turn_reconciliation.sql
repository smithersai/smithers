-- Keep the original session binding across later turns and process restarts.
CREATE TABLE workflow_run_coding_reconciliations (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_request JSONB CHECK (run_request IS NULL OR COALESCE(jsonb_typeof(run_request) = 'object' AND run_request->>'_tag' = 'Plan' AND run_request->>'planId' <> '' AND run_request->>'digest' <> '' AND jsonb_typeof(run_request->'envelope') = 'object' AND run_request->>'idempotencyKey' = 'agent-turn:' || workflow_run_id || ':run', FALSE)),
    attempted_at TIMESTAMPTZ,
    lease_owner TEXT NOT NULL DEFAULT '',
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancel_acknowledged_at TIMESTAMPTZ,
    reconciled_at TIMESTAMPTZ
);
CREATE INDEX idx_workflow_run_coding_reconciliations_pending
    ON workflow_run_coding_reconciliations (next_attempt_at, workflow_run_id)
    WHERE reconciled_at IS NULL;
INSERT INTO workflow_run_coding_reconciliations (workflow_run_id, session_id, workspace_id)
SELECT host.workflow_run_id, session.id, host.workspace_id
FROM workflow_run_coding_hosts host
JOIN agent_sessions session ON session.workflow_run_id = host.workflow_run_id;

CREATE FUNCTION register_coding_turn_reconciliation() RETURNS TRIGGER AS $$
BEGIN
    -- Admission already retained the original session, even if a newer turn
    -- has since replaced the session's current workflow binding.
    IF EXISTS (SELECT 1 FROM workflow_run_coding_reconciliations
               WHERE workflow_run_id = NEW.workflow_run_id AND workspace_id = NEW.workspace_id) THEN
        RETURN NEW;
    END IF;
    INSERT INTO workflow_run_coding_reconciliations (workflow_run_id, session_id, workspace_id)
    SELECT NEW.workflow_run_id, id, NEW.workspace_id FROM agent_sessions WHERE workflow_run_id = NEW.workflow_run_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'coding host requires an owning session' USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_coding_turn_reconciliation
    AFTER INSERT ON workflow_run_coding_hosts
    FOR EACH ROW EXECUTE FUNCTION register_coding_turn_reconciliation();
