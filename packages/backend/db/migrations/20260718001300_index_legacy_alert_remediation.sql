-- atlas:txmode none

-- Revision: 20260718001300.
-- The compatibility reconciler probes only tokenless monitoring runs by the
-- two incident identifiers embedded in dispatch_inputs. Build its expression
-- index concurrently: workflow_runs can be large and remains writable while
-- old/new application replicas overlap during this one-release bridge.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_legacy_alert_incident
    ON workflow_runs (
        (dispatch_inputs ->> 'incident_row_id'),
        (dispatch_inputs ->> 'incident_id'),
        status
    )
    WHERE trigger_event = 'monitoring_alert'
      AND execution_plane = 'runner'
      AND NOT (dispatch_inputs ? 'remediation_dispatch_token');
