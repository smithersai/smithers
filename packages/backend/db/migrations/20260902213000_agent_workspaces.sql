-- RFD-004: agent runs are workspaces; workspace heads are pushed to repo-host.
--
-- workspaces.kind gains 'agent' (an agent run's computer, listed under the
-- branch with the human workspaces), workspaces.agent_session_id links the
-- row to the run that owns it, head_push_token_id records the scoped token
-- the guest head reporter pushes with so suspend/destroy can revoke it.
-- agent_sessions.workspace_id is the reverse link. change_revisions.workspace_id
-- records which computer a revision came from.
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_kind_check;
ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_kind_check CHECK (kind IN ('container', 'vm', 'desktop', 'agent'));
ALTER TABLE workspaces
    ADD COLUMN agent_session_id UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
    ADD COLUMN head_push_token_id BIGINT REFERENCES access_tokens(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX uq_workspaces_agent_session
    ON workspaces (agent_session_id)
    WHERE agent_session_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE agent_sessions
    ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX idx_agent_sessions_workspace
    ON agent_sessions (workspace_id) WHERE workspace_id IS NOT NULL;

ALTER TABLE change_revisions
    ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX idx_change_revisions_workspace
    ON change_revisions (workspace_id) WHERE workspace_id IS NOT NULL;
