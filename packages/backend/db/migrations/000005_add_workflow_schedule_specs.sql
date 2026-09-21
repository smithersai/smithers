CREATE TABLE IF NOT EXISTS workflow_schedule_specs (
    id                     BIGSERIAL PRIMARY KEY,
    workflow_definition_id BIGINT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    repository_id          BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    cron_expression        TEXT NOT NULL,
    next_fire_at           TIMESTAMPTZ NOT NULL,
    prev_fire_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_definition_id, cron_expression)
);

CREATE INDEX IF NOT EXISTS idx_workflow_schedule_specs_next_fire
    ON workflow_schedule_specs (next_fire_at ASC);
