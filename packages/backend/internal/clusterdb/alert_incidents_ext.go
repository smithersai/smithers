package clusterdb

import (
	"context"
)

// Hand-written guarded variants of the sqlc-generated alert_incidents state
// transitions. These add WHERE-clause guards that the generated
// UpdateAlertIncidentState / RecordAlertIncidentRemediationOutcome do not
// have, so a stale worker retry or a late duplicate outcome report can never
// resurrect or clobber a terminal incident (see issues #295, #324, #21).
//
// This lives in a hand-written ext file (matching the established pattern in
// alert_remediation_jobs_ext.go) rather than db/cluster/queries/alert_incidents.sql
// because this cluster is scoped to avoid `zig build sqlc` regeneration.
// Follow-up handoff (tracked outside this cluster, not a TODO in this diff):
// the db-schema-queries cluster should fold these guards into
// db/cluster/queries/alert_incidents.sql and regenerate so the unguarded generated
// functions above can be deleted.

const updateAlertIncidentStateGuarded = `
UPDATE alert_incidents
SET state = $2,
    resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END,
    updated_at = NOW()
WHERE id = $1
  AND state = 'open'
  AND $2 = 'remediating'
`

// UpdateAlertIncidentStateGuardedParams mirrors UpdateAlertIncidentStateParams.
type UpdateAlertIncidentStateGuardedParams struct {
	ID    int64  `json:"id"`
	State string `json:"state"`
}

// UpdateAlertIncidentStateGuarded performs the worker's one monotonic
// transition, open -> remediating. A stale acknowledgement after a callback
// has reached pr_opened/resolved/failed is always a no-op.
func (q *Queries) UpdateAlertIncidentStateGuarded(ctx context.Context, arg UpdateAlertIncidentStateGuardedParams) (int64, error) {
	tag, err := q.db.Exec(ctx, updateAlertIncidentStateGuarded, arg.ID, arg.State)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const recordAlertIncidentRemediationOutcomeGuarded = `
UPDATE alert_incidents
SET state = $2,
    remediation_pr_url = $3,
    attempts = attempts + 1,
    resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END,
    updated_at = NOW()
WHERE id = $1
  AND state <> 'resolved'
  AND (state <> 'failed' OR $2 IN ('resolved', 'pr_opened'))
  AND NOT (state = 'pr_opened' AND $2 <> 'resolved')
  AND NOT (state = $2 AND remediation_pr_url = $3)
`

// RecordAlertIncidentRemediationOutcomeGuardedParams mirrors
// RecordAlertIncidentRemediationOutcomeParams.
type RecordAlertIncidentRemediationOutcomeGuardedParams struct {
	ID               int64  `json:"id"`
	State            string `json:"state"`
	RemediationPrUrl string `json:"remediation_pr_url"`
}

// RecordAlertIncidentRemediationOutcomeGuarded records a workflow-reported
// remediation outcome unless the incident has already resolved. Repeated
// identical reports are idempotent; a late resolved or draft-PR report may
// repair an earlier failure, while a late failure can never erase a draft PR.
func (q *Queries) RecordAlertIncidentRemediationOutcomeGuarded(ctx context.Context, arg RecordAlertIncidentRemediationOutcomeGuardedParams) (int64, error) {
	tag, err := q.db.Exec(ctx, recordAlertIncidentRemediationOutcomeGuarded, arg.ID, arg.State, arg.RemediationPrUrl)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
