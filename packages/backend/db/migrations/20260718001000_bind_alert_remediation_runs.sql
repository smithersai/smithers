-- Revision: 20260718001000.
-- Bind each alert-remediation job to the exact workflow run that may report
-- its outcome.  The random token is created with the job (inside alert
-- admission's transaction), then persisted in workflow_runs.dispatch_inputs.
-- A worker that stops after committing the run but before recording its ID can
-- therefore find and adopt that same run instead of dispatching a duplicate.

ALTER TABLE alert_remediation_jobs
    ADD COLUMN dispatch_token TEXT NOT NULL
        DEFAULT encode(gen_random_bytes(32), 'hex')
        CHECK (dispatch_token ~ '^[0-9a-f]{64}$'),
    ADD COLUMN workflow_run_id BIGINT
        REFERENCES workflow_runs(id) ON DELETE SET NULL;

ALTER TABLE alert_remediation_jobs
    ADD CONSTRAINT alert_remediation_jobs_dispatch_token_key
        UNIQUE (dispatch_token);

CREATE UNIQUE INDEX idx_alert_remediation_jobs_workflow_run
    ON alert_remediation_jobs (workflow_run_id)
    WHERE workflow_run_id IS NOT NULL;

-- A stale-claim takeover can overlap a very slow original dispatcher.  The
-- admission-time token is stable across both workers, so enforce idempotency at
-- the run insert itself instead of relying only on the worker's preflight
-- lookup.  The losing dispatcher observes a uniqueness error and adopts the
-- committed winner by token.
CREATE UNIQUE INDEX idx_workflow_runs_alert_remediation_dispatch_token
    ON workflow_runs ((dispatch_inputs ->> 'remediation_dispatch_token'))
    WHERE trigger_event = 'monitoring_alert'
      AND execution_plane = 'runner'
      AND dispatch_inputs ? 'remediation_dispatch_token';

-- State delivery is monotonic even for legacy/reconciliation statements that
-- predate the guarded outcome queries. The first delivered draft PR is
-- immutable and may only resolve when the monitoring incident closes;
-- resolved is wholly terminal. RETURN OLD also preserves URLs, counters, and
-- times from a stale statement while making the update an idempotent no-op.
CREATE FUNCTION guard_alert_incident_terminal_state()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state = 'resolved'
       OR (OLD.state = 'pr_opened' AND NEW.state <> 'resolved') THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_alert_incidents_terminal_state_guard
    BEFORE UPDATE OF state ON alert_incidents
    FOR EACH ROW
    EXECUTE FUNCTION guard_alert_incident_terminal_state();
