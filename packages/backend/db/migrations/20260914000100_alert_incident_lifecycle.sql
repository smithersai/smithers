ALTER TABLE alert_incidents
  ADD COLUMN source TEXT NOT NULL DEFAULT 'monitoring',
  ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN acknowledged_at TIMESTAMPTZ,
  ADD COLUMN acknowledged_by TEXT,
  ADD COLUMN snoozed_until TIMESTAMPTZ,
  ADD COLUMN resolved_by TEXT,
  ADD COLUMN resolution_note TEXT;
UPDATE alert_incidents SET source = 'canary' WHERE incident_id LIKE 'canary-%';
CREATE INDEX idx_alert_incidents_policy_condition_active
  ON alert_incidents (policy_name, condition_name, id)
  WHERE state IN ('open', 'remediating', 'pr_opened');

-- Permit lifecycle metadata changes on pr_opened without weakening outcome guards.
CREATE OR REPLACE FUNCTION guard_alert_incident_terminal_state()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state = 'resolved'
       OR (OLD.state = 'pr_opened' AND (NEW.state NOT IN ('pr_opened', 'resolved')
           OR (NEW.state = 'pr_opened' AND (NEW.remediation_pr_url IS DISTINCT FROM OLD.remediation_pr_url
               OR NEW.attempts IS DISTINCT FROM OLD.attempts)))) THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Keep delivery identities after deduplication and resolution. A close only
-- resolves the canonical incident after every associated delivery has closed.
CREATE TABLE alert_incident_deliveries (
    incident_id TEXT PRIMARY KEY,
    canonical_incident_id BIGINT NOT NULL REFERENCES alert_incidents(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ
);
CREATE INDEX idx_alert_incident_deliveries_live
    ON alert_incident_deliveries (canonical_incident_id) WHERE closed_at IS NULL;
INSERT INTO alert_incident_deliveries (incident_id, canonical_incident_id, created_at, closed_at)
SELECT incident_id, id, created_at,
       CASE WHEN state IN ('resolved', 'failed') THEN COALESCE(resolved_at, updated_at) END
FROM alert_incidents;
