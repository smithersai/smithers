-- Durable Linear sync runs back the live progress card, while retry metadata
-- keeps a failed operation replayable without exposing its stored payload.
CREATE TABLE linear_sync_runs (
    id               BIGSERIAL PRIMARY KEY,
    integration_id   BIGINT NOT NULL REFERENCES linear_integrations(id) ON DELETE CASCADE,
    state            VARCHAR(16) NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending', 'running', 'completed', 'failed')),
    issues_done      INTEGER NOT NULL DEFAULT 0 CHECK (issues_done >= 0),
    issues_total     INTEGER NOT NULL DEFAULT 0 CHECK (issues_total >= 0),
    issues_failed    INTEGER NOT NULL DEFAULT 0 CHECK (issues_failed >= 0),
    comments_done    INTEGER NOT NULL DEFAULT 0 CHECK (comments_done >= 0),
    comments_total   INTEGER NOT NULL DEFAULT 0 CHECK (comments_total >= 0),
    comments_failed  INTEGER NOT NULL DEFAULT 0 CHECK (comments_failed >= 0),
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_linear_sync_runs_integration
    ON linear_sync_runs (integration_id, created_at DESC, id DESC);

ALTER TABLE linear_sync_ops
    ADD COLUMN run_id BIGINT REFERENCES linear_sync_runs(id) ON DELETE SET NULL,
    ADD COLUMN retry_of_id BIGINT REFERENCES linear_sync_ops(id) ON DELETE SET NULL,
    ADD COLUMN payload JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Widening swap, not a contract: 000067 declared
-- CHECK (status IN ('success','failed','skipped')) and this replaces it with a
-- strict superset that adds 'pending', in the same migration and the same
-- transaction. No existing row can violate the new constraint and no data
-- repair is needed to roll the application back.
-- smithers:migration-contract-reviewed: wave-1 integration, issue #468
ALTER TABLE linear_sync_ops DROP CONSTRAINT IF EXISTS linear_sync_ops_status_check;
ALTER TABLE linear_sync_ops
    ADD CONSTRAINT linear_sync_ops_status_check
    CHECK (status IN ('pending', 'success', 'failed', 'skipped'));

CREATE INDEX idx_linear_sync_ops_run
    ON linear_sync_ops (run_id, created_at DESC, id DESC)
    WHERE run_id IS NOT NULL;

CREATE INDEX idx_linear_sync_ops_retry_of
    ON linear_sync_ops (retry_of_id)
    WHERE retry_of_id IS NOT NULL;
