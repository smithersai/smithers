ALTER TABLE workspaces
    ADD COLUMN failure_code TEXT,
    ADD COLUMN failure_message TEXT;

-- Historical failures predate structured diagnostics. Give them the same
-- stable fallback used for new failures so the invariant can be installed
-- without hiding the fact that their original cause is unavailable.
UPDATE workspaces
SET failure_code = 'provisioning_failed',
    failure_message = 'workspace provisioning failed'
WHERE status = 'failed';

-- Some lifecycle CAS helpers intentionally live outside sqlc. Normalize every
-- transition at the table boundary so those helpers, internal status reports,
-- and future callers cannot create a failed row without diagnostics or leave
-- stale failure details on a recovered workspace.
CREATE OR REPLACE FUNCTION normalize_workspace_failure_details()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'failed' THEN
        NEW.failure_code = COALESCE(NULLIF(btrim(NEW.failure_code), ''), 'provisioning_failed');
        NEW.failure_message = COALESCE(NULLIF(btrim(NEW.failure_message), ''), 'workspace provisioning failed');
    ELSE
        NEW.failure_code = NULL;
        NEW.failure_message = NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workspaces_normalize_failure_details
    BEFORE INSERT OR UPDATE OF status, failure_code, failure_message ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION normalize_workspace_failure_details();

ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_failure_detail_check CHECK (
        (status = 'failed'
            AND failure_code IS NOT NULL AND btrim(failure_code) <> ''
            AND failure_message IS NOT NULL AND btrim(failure_message) <> '')
        OR (status <> 'failed' AND failure_code IS NULL AND failure_message IS NULL)
    );
