-- Denormalized workflow trigger registrations for fast event lookup.

CREATE TABLE IF NOT EXISTS workflow_triggers (
    id                     BIGSERIAL PRIMARY KEY,
    repository_id          BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_definition_id BIGINT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    workflow_path          TEXT NOT NULL,
    event_type             VARCHAR(64) NOT NULL,
    event_action           VARCHAR(64) NOT NULL DEFAULT '',
    enabled                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, workflow_path, event_type, event_action)
);

CREATE INDEX IF NOT EXISTS idx_workflow_triggers_repo_event
    ON workflow_triggers (repository_id, event_type, event_action)
    WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_workflow_triggers_definition
    ON workflow_triggers (workflow_definition_id);
