-- Selected execution identity, not evidence that a guest has started. Gateway
-- health supplies capability proof. Never replace a binding on setup retry.
CREATE TABLE workspace_capability_bindings (
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    required_capability text NOT NULL CHECK (required_capability = 'repository-jobs/v1'),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repository_id, user_id, required_capability),
    UNIQUE (workspace_id, required_capability)
);
