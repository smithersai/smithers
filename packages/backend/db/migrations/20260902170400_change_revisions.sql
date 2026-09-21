-- Preserve every immutable commit incarnation of a stable jj change. The
-- recorded parent commit belongs to this revision, so later parent rewrites
-- cannot change the meaning of its default diff.
CREATE TABLE change_revisions (
    id                    BIGSERIAL PRIMARY KEY,
    repository_id         BIGINT NOT NULL,
    change_id             VARCHAR(255) NOT NULL,
    seq                   BIGINT NOT NULL CHECK (seq > 0),
    commit_id             VARCHAR(255) NOT NULL,
    parent_commit_id      VARCHAR(255) NOT NULL DEFAULT '',
    source                VARCHAR(16) NOT NULL CHECK (source IN ('push', 'rebase', 'agent', 'undo')),
    agent_session_id      UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
    workspace_snapshot_id UUID REFERENCES workspace_snapshots(id) ON DELETE SET NULL,
    operation_ids         TEXT[] NOT NULL DEFAULT '{}',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (repository_id, change_id)
        REFERENCES changes(repository_id, change_id) ON DELETE CASCADE,
    UNIQUE (repository_id, change_id, seq),
    UNIQUE (repository_id, change_id, commit_id)
);

CREATE INDEX idx_change_revisions_change_seq
    ON change_revisions (repository_id, change_id, seq DESC);
CREATE INDEX idx_change_revisions_agent_session
    ON change_revisions (agent_session_id) WHERE agent_session_id IS NOT NULL;
CREATE INDEX idx_change_revisions_workspace_snapshot
    ON change_revisions (workspace_snapshot_id) WHERE workspace_snapshot_id IS NOT NULL;
