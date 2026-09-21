CREATE TABLE IF NOT EXISTS alert_incidents (
    id                  BIGSERIAL PRIMARY KEY,
    incident_id         TEXT NOT NULL UNIQUE,
    policy_name         TEXT NOT NULL,
    condition_name      TEXT NOT NULL DEFAULT '',
    state               TEXT NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open', 'remediating', 'pr_opened', 'resolved', 'failed')),
    summary             TEXT NOT NULL DEFAULT '',
    incident_url        TEXT NOT NULL DEFAULT '',
    runbook             TEXT NOT NULL DEFAULT '',
    workflow            TEXT NOT NULL DEFAULT '',
    remediation_pr_url  TEXT NOT NULL DEFAULT '',
    attempts            INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_incidents_policy_active
    ON alert_incidents (policy_name)
    WHERE state IN ('open', 'remediating', 'pr_opened');
CREATE INDEX IF NOT EXISTS idx_alert_incidents_policy_created
    ON alert_incidents (policy_name, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_remediation_jobs (
    id            BIGSERIAL PRIMARY KEY,
    incident_id   BIGINT NOT NULL REFERENCES alert_incidents(id) ON DELETE CASCADE,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    error         TEXT NOT NULL DEFAULT '',
    available_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_remediation_jobs_pending_dequeue
    ON alert_remediation_jobs (available_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_alert_remediation_jobs_incident
    ON alert_remediation_jobs (incident_id, created_at DESC);
