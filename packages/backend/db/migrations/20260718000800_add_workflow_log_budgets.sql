-- Revision: 20260718000800.
-- Keep workflow log admission O(1) and enforce it below every application
-- writer. The counters cover both legacy step-scoped workflow_logs and the
-- newer workflow_run_logs table so rolling-version/direct inserts cannot
-- bypass either the byte or zero-byte entry ceiling.
ALTER TABLE workflow_runs
    ADD COLUMN IF NOT EXISTS log_bytes BIGINT NOT NULL DEFAULT 0
        CONSTRAINT workflow_runs_log_bytes_nonnegative CHECK (log_bytes >= 0),
    ADD COLUMN IF NOT EXISTS log_entry_count BIGINT NOT NULL DEFAULT 0
        CONSTRAINT workflow_runs_log_entry_count_nonnegative CHECK (log_entry_count >= 0);

-- Existing runs are deliberately absent until their two log tables have been
-- recounted under the run-row lock. New runs are initialized immediately, so
-- rolling-version writers receive strict admission without waiting for the
-- bounded background backfill.
CREATE TABLE workflow_log_budget_initializations (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    initialized_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION initialize_new_workflow_log_budget()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO workflow_log_budget_initializations (workflow_run_id)
    VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_runs_initialize_log_budget
    AFTER INSERT ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION initialize_new_workflow_log_budget();

CREATE OR REPLACE FUNCTION reserve_workflow_log_budget()
RETURNS TRIGGER AS $$
DECLARE
    v_entry_bytes BIGINT := OCTET_LENGTH(NEW.entry)::bigint;
    v_initialized BOOLEAN;
BEGIN
    -- Every mutation takes the run-row lock, including while this legacy run
    -- is still uninitialized. The bounded backfill takes the same lock before
    -- recounting, so it sees all prior commits and later writers cannot slip
    -- between the recount and initialization marker.
    SELECT EXISTS (
        SELECT 1
        FROM workflow_log_budget_initializations AS initialized
        WHERE initialized.workflow_run_id = NEW.workflow_run_id
    )
    INTO v_initialized
    FROM workflow_runs AS run
    WHERE run.id = NEW.workflow_run_id
    FOR UPDATE OF run;

    -- Preserve the foreign key's canonical missing-parent error.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Existing runs retain legacy admission only until their exact counters
    -- are initialized by BackfillOneWorkflowLogBudget.
    IF NOT v_initialized THEN
        RETURN NEW;
    END IF;

    UPDATE workflow_runs
    SET log_bytes = log_bytes + v_entry_bytes,
        log_entry_count = log_entry_count + 1
    WHERE id = NEW.workflow_run_id
      AND log_bytes <= 52428800::bigint - v_entry_bytes
      AND log_entry_count < 100000::bigint;

    IF FOUND THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'workflow run % log storage limit reached', NEW.workflow_run_id
        USING ERRCODE = '54000',
              CONSTRAINT = 'workflow_run_log_budget';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_workflow_log_budget()
RETURNS TRIGGER AS $$
DECLARE
    v_initialized BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM workflow_log_budget_initializations AS initialized
        WHERE initialized.workflow_run_id = OLD.workflow_run_id
    )
    INTO v_initialized
    FROM workflow_runs AS run
    WHERE run.id = OLD.workflow_run_id
    FOR UPDATE OF run;

    IF NOT FOUND OR NOT v_initialized THEN
        RETURN OLD;
    END IF;

    UPDATE workflow_runs
    SET log_bytes = GREATEST(log_bytes - OCTET_LENGTH(OLD.entry)::bigint, 0),
        log_entry_count = GREATEST(log_entry_count - 1, 0)
    WHERE id = OLD.workflow_run_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_workflow_log_budget_identity()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id
       OR NEW.entry IS DISTINCT FROM OLD.entry THEN
        RAISE EXCEPTION 'workflow log run and entry are immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Process exactly one legacy run per transaction. The first statement locks
-- the parent row; log INSERT/DELETE triggers take the same lock before their
-- mutations, so the following aggregate is an exact stable cut. PostgreSQL's
-- default VOLATILE function semantics give each embedded query a fresh
-- READ COMMITTED snapshot after the lock has been acquired.
CREATE OR REPLACE FUNCTION backfill_one_workflow_log_budget()
RETURNS BIGINT AS $$
DECLARE
    v_workflow_run_id BIGINT;
    v_log_bytes BIGINT;
    v_log_entry_count BIGINT;
BEGIN
    SELECT run.id
    INTO v_workflow_run_id
    FROM workflow_runs AS run
    WHERE NOT EXISTS (
        SELECT 1
        FROM workflow_log_budget_initializations AS initialized
        WHERE initialized.workflow_run_id = run.id
    )
    ORDER BY run.id
    FOR UPDATE OF run SKIP LOCKED
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT
        COALESCE(SUM(table_log_bytes), 0)::bigint,
        COALESCE(SUM(table_log_entry_count), 0)::bigint
    INTO v_log_bytes, v_log_entry_count
    FROM (
        SELECT
            COALESCE(SUM(OCTET_LENGTH(entry)::bigint), 0)::bigint AS table_log_bytes,
            COUNT(*)::bigint AS table_log_entry_count
        FROM workflow_logs
        WHERE workflow_run_id = v_workflow_run_id
        UNION ALL
        SELECT
            COALESCE(SUM(OCTET_LENGTH(entry)::bigint), 0)::bigint AS table_log_bytes,
            COUNT(*)::bigint AS table_log_entry_count
        FROM workflow_run_logs
        WHERE workflow_run_id = v_workflow_run_id
    ) AS usage;

    UPDATE workflow_runs
    SET log_bytes = v_log_bytes,
        log_entry_count = v_log_entry_count
    WHERE id = v_workflow_run_id;

    INSERT INTO workflow_log_budget_initializations (workflow_run_id)
    VALUES (v_workflow_run_id)
    ON CONFLICT (workflow_run_id) DO NOTHING;

    RETURN v_workflow_run_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_logs_reserve_budget
    BEFORE INSERT ON workflow_logs
    FOR EACH ROW EXECUTE FUNCTION reserve_workflow_log_budget();

CREATE TRIGGER trg_workflow_run_logs_reserve_budget
    BEFORE INSERT ON workflow_run_logs
    FOR EACH ROW EXECUTE FUNCTION reserve_workflow_log_budget();

CREATE TRIGGER trg_workflow_logs_release_budget
    BEFORE DELETE ON workflow_logs
    FOR EACH ROW EXECUTE FUNCTION release_workflow_log_budget();

CREATE TRIGGER trg_workflow_run_logs_release_budget
    BEFORE DELETE ON workflow_run_logs
    FOR EACH ROW EXECUTE FUNCTION release_workflow_log_budget();

CREATE TRIGGER trg_workflow_logs_guard_budget_identity
    BEFORE UPDATE OF workflow_run_id, entry ON workflow_logs
    FOR EACH ROW EXECUTE FUNCTION guard_workflow_log_budget_identity();

CREATE TRIGGER trg_workflow_run_logs_guard_budget_identity
    BEFORE UPDATE OF workflow_run_id, entry ON workflow_run_logs
    FOR EACH ROW EXECUTE FUNCTION guard_workflow_log_budget_identity();
