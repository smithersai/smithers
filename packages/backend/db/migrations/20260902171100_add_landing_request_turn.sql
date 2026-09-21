-- Track whose turn a landing request is on and retain the agent session that
-- authored it so reviewer feedback can resume that session.
ALTER TABLE landing_requests
    ADD COLUMN author_agent_session_id UUID,
    ADD COLUMN turn_party VARCHAR(16) NOT NULL DEFAULT 'reviewer'
        CHECK (turn_party IN ('author', 'reviewer')),
    ADD COLUMN turn_actor_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN turn_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN turn_reason VARCHAR(16) NOT NULL DEFAULT 'request'
        CHECK (turn_reason IN ('comment', 'revision', 'request')),
    ADD COLUMN turn_revision_id BIGINT NOT NULL DEFAULT 0;

-- Existing agent-authored requests predate the direct session link. Recover
-- the newest known author session from their revision provenance when possible.
WITH ranked_sessions AS (
    SELECT
        lr.id AS landing_request_id,
        cr.agent_session_id,
        ROW_NUMBER() OVER (
            PARTITION BY lr.id
            ORDER BY cr.created_at DESC, cr.id DESC
        ) AS rank
    FROM landing_requests AS lr
    JOIN landing_request_changes AS lrc ON lrc.landing_request_id = lr.id
    JOIN change_revisions AS cr
      ON cr.repository_id = lr.repository_id
     AND cr.change_id = lrc.change_id
    WHERE cr.agent_session_id IS NOT NULL
)
UPDATE landing_requests AS lr
SET author_agent_session_id = recovered.agent_session_id,
    turn_actor_id = recovered.agent_session_id::text
FROM ranked_sessions AS recovered
WHERE lr.id = recovered.landing_request_id
  AND recovered.rank = 1;

UPDATE landing_requests
SET turn_actor_id = author_id::text
WHERE turn_actor_id = '';

WITH latest_revisions AS (
    SELECT lr.id AS landing_request_id, MAX(cr.id) AS revision_id
    FROM landing_requests AS lr
    JOIN landing_request_changes AS lrc ON lrc.landing_request_id = lr.id
    JOIN change_revisions AS cr
      ON cr.repository_id = lr.repository_id
     AND cr.change_id = lrc.change_id
    GROUP BY lr.id
)
UPDATE landing_requests AS lr
SET turn_revision_id = latest.revision_id
FROM latest_revisions AS latest
WHERE lr.id = latest.landing_request_id;

ALTER TABLE landing_requests
    ADD CONSTRAINT landing_requests_author_agent_session_id_fkey
    FOREIGN KEY (author_agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL;

CREATE INDEX idx_landing_requests_author_agent_session
    ON landing_requests (author_agent_session_id)
    WHERE author_agent_session_id IS NOT NULL;
