package clusterservices

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestIncidentLifecycleSQL(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	q := deploymentdb.New(tx)
	policy := "incident-sql-" + uuid.NewString()
	create := func(id, condition string) clusterdb.AlertIncident {
		row, err := q.CreateAlertIncident(ctx, clusterdb.CreateAlertIncidentParams{IncidentID: id, PolicyName: policy, ConditionName: condition})
		require.NoError(t, err)
		return clusterdb.AlertIncident(row)
	}
	a := create("canary-"+uuid.NewString(), "Backend canary probe failing")
	b := create(uuid.NewString(), "monitoring")
	c := create("canary-"+uuid.NewString(), "Playwright canary test failing")
	require.Equal(t, "canary", a.Source)
	require.Equal(t, "monitoring", b.Source)
	_, err = tx.Exec(ctx, "UPDATE alert_incidents SET state='pr_opened' WHERE id=$1", a.ID)
	require.NoError(t, err)
	mutate := func(action string, id int64) {
		rows, err := q.AdminMutateAlertIncidents(ctx, clusterdb.AdminMutateAlertIncidentsParams{Action: action, Actor: "operator", Ids: []int64{id}, Until: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}, Note: pgtype.Text{String: "fixed", Valid: true}})
		require.NoError(t, err)
		require.Len(t, rows, 1)
	}
	mutate("acknowledge", a.ID)
	mutate("snooze", b.ID)
	hits, err := q.IncrementActiveAlertIncident(ctx, clusterdb.IncrementActiveAlertIncidentParams{PolicyName: policy, ConditionName: a.ConditionName, IncidentID: "canary-new", Summary: "latest"})
	require.NoError(t, err)
	require.Equal(t, int64(1), hits)
	refreshed, err := q.GetAlertIncident(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, int32(2), refreshed.Occurrences)
	require.Equal(t, "latest", refreshed.Summary)
	require.Equal(t, "operator", refreshed.AcknowledgedBy.String)
	views := map[string][]int64{"active": {a.ID, b.ID, c.ID}, "open": {c.ID}, "acknowledged": {a.ID}, "snoozed": {b.ID}, "resolved": {}, "all": {a.ID, b.ID, c.ID}}
	for state, want := range views {
		rows, err := q.ListAlertIncidents(ctx, clusterdb.ListAlertIncidentsParams{StateFilter: state, Policy: pgtype.Text{String: policy, Valid: true}, PageLimit: 200})
		require.NoError(t, err)
		ids := []int64{}
		for _, r := range rows {
			ids = append(ids, r.ID)
		}
		require.ElementsMatch(t, want, ids, state)
	}
	before, err := q.GetAlertIncidentStateCounts(ctx)
	require.NoError(t, err)
	mutate("unacknowledge", a.ID)
	after, err := q.GetAlertIncidentStateCounts(ctx)
	require.NoError(t, err)
	require.Equal(t, before.AcknowledgedCount-1, after.AcknowledgedCount)
	require.Equal(t, before.OpenCount+1, after.OpenCount)
	_, err = tx.Exec(ctx, "UPDATE alert_incidents SET snoozed_until=now()-interval '1 second' WHERE id=$1", b.ID)
	require.NoError(t, err)
	afterExpiry, err := q.GetAlertIncidentStateCounts(ctx)
	require.NoError(t, err)
	require.Equal(t, after.SnoozedCount-1, afterExpiry.SnoozedCount)
	require.Equal(t, after.OpenCount+1, afterExpiry.OpenCount)
	mutate("resolve", a.ID)
	resolved, err := q.GetAlertIncident(ctx, a.ID)
	require.NoError(t, err)
	require.NoError(t, q.ResolveAlertIncidentByIncidentID(ctx, a.IncidentID))
	closed, err := q.GetAlertIncident(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, resolved.ResolvedAt, closed.ResolvedAt)
	require.Equal(t, "operator", closed.ResolvedBy.String)
	require.Equal(t, "fixed", closed.ResolutionNote.String)
	// A delayed open for a resolved delivery cannot refresh a newer incident.
	d := create("canary-"+uuid.NewString(), a.ConditionName)
	hits, err = q.IncrementActiveAlertIncident(ctx, clusterdb.IncrementActiveAlertIncidentParams{PolicyName: policy, ConditionName: a.ConditionName, IncidentID: a.IncidentID})
	require.NoError(t, err)
	require.Zero(t, hits)
	// Healthy workflow resolves only the matching canary source and condition.
	monitoring := create(uuid.NewString(), a.ConditionName)
	require.NoError(t, NewCanaryReportService(q).ReportResults(ctx, CanaryReportInput{Suite: "workflow", RunID: "healthy", Results: []CanaryReportResult{{Test: "probe", Status: "success"}}}, time.Now()))
	for _, row := range []clusterdb.AlertIncident{d, c, monitoring} {
		got, err := q.GetAlertIncident(ctx, row.ID)
		require.NoError(t, err)
		if row.ID == d.ID {
			require.Equal(t, "resolved", got.State)
			require.Equal(t, "canary:healthy", got.ResolvedBy.String)
			require.Equal(t, "suite passed", got.ResolutionNote.String)
		} else {
			require.Equal(t, "open", got.State)
		}
	}
}

func TestIncidentLifecycleConcurrentDedupe(t *testing.T) {
	pool := getAgentTestPool(t)
	q := deploymentdb.New(pool)
	ctx := context.Background()
	policy := "concurrent-" + uuid.NewString()
	defer pool.Exec(ctx, "DELETE FROM alert_incidents WHERE policy_name=$1", policy)
	svc := NewAlertIncidentService(q, nil, WithAlertRemediationEnabled(false))
	const deliveries = 8
	errs := make(chan error, deliveries)
	var wg sync.WaitGroup
	for i := 0; i < deliveries; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs <- svc.HandleAlertIncident(ctx, MonitoringAlertIncident{IncidentID: fmt.Sprintf("canary-%s-%d", policy, i), PolicyName: policy, ConditionName: "condition", State: "open", Summary: fmt.Sprint(i)})
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	rows, err := q.ListAlertIncidents(ctx, clusterdb.ListAlertIncidentsParams{StateFilter: "active", Policy: pgtype.Text{String: policy, Valid: true}, PageLimit: 200})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, int32(deliveries), rows[0].Occurrences)
	var associations int
	require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM alert_incident_deliveries WHERE canonical_incident_id=$1", rows[0].ID).Scan(&associations))
	require.Equal(t, deliveries, associations)
	jobs, err := q.ListAlertRemediationJobsForIncidents(ctx, []int64{rows[0].ID})
	require.NoError(t, err)
	require.Empty(t, jobs)
}

func TestIncidentLifecycleAuditTransaction(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	q := deploymentdb.New(tx)
	row, err := q.CreateAlertIncident(ctx, clusterdb.CreateAlertIncidentParams{IncidentID: "audit-" + uuid.NewString(), PolicyName: "audit-policy"})
	require.NoError(t, err)
	// An unknown admin fails the audit FK, and must roll back the resolution.
	badCtx := services.ContextWithAdminAuditActor(ctx, services.AdminAuditActor{UserID: 9223372036854775807, Username: "missing"})
	_, err = NewAdminIncidentsService(q).Resolve(badCtx, row.ID, nil)
	require.Error(t, err)
	got, err := q.GetAlertIncident(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "open", got.State)
	// Create only the admin fixture needed by the audit foreign key.
	name := "incident-admin-" + uuid.NewString()
	var actorID int64
	require.NoError(t, tx.QueryRow(ctx, "INSERT INTO users (username,lower_username) VALUES ($1,$1) RETURNING id", name).Scan(&actorID))
	adminCtx := services.ContextWithAdminAuditActor(ctx, services.AdminAuditActor{UserID: actorID, Username: name})
	svc := NewAdminIncidentsService(q)
	note := "manual fix"
	result, err := svc.Resolve(adminCtx, row.ID, &note)
	require.NoError(t, err)
	require.Equal(t, "resolved", result.State)
	again, err := svc.Resolve(adminCtx, row.ID, nil)
	require.NoError(t, err)
	require.Equal(t, result.ClosedAt, again.ClosedAt)
	require.Equal(t, "manual fix", *again.ResolutionNote)
	var audits int
	require.NoError(t, tx.QueryRow(ctx, "SELECT count(*) FROM audit_log WHERE actor_id=$1 AND event_type='admin.incident.resolve'", actorID).Scan(&audits))
	require.Equal(t, 2, audits)
	affected, err := svc.Bulk(adminCtx, AdminIncidentBulkInput{Action: "resolve", IDs: []int64{row.ID}})
	require.NoError(t, err)
	require.Zero(t, affected)
}

func TestIncidentLifecycleDeduplicatedDeliveryReplay(t *testing.T) {
	for _, resolution := range []string{"manual", "canary"} {
		t.Run(resolution, func(t *testing.T) {
			pool := getAgentTestPool(t)
			ctx := context.Background()
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			q := deploymentdb.New(tx)
			policy := "Smithers High Error Rate - " + uuid.NewString()
			svc := NewAlertIncidentService(q, testAlertRegistry(t))
			a := MonitoringAlertIncident{IncidentID: "canary-" + uuid.NewString(), PolicyName: policy, ConditionName: "Backend canary probe failing", State: "open"}
			b := a
			b.IncidentID = "canary-" + uuid.NewString()
			require.NoError(t, svc.HandleAlertIncident(ctx, a))
			require.NoError(t, svc.HandleAlertIncident(ctx, b))
			canonical, err := q.GetAlertIncidentByIncidentID(ctx, a.IncidentID)
			require.NoError(t, err)
			require.Equal(t, int32(2), canonical.Occurrences)
			var associated int64
			require.NoError(t, tx.QueryRow(ctx, "SELECT canonical_incident_id FROM alert_incident_deliveries WHERE incident_id=$1", b.IncidentID).Scan(&associated))
			require.Equal(t, canonical.ID, associated)
			jobs, err := q.ListAlertRemediationJobsForIncidents(ctx, []int64{canonical.ID})
			require.NoError(t, err)
			require.Len(t, jobs, 1, "initial delivery enqueues exactly one remediation")
			if resolution == "manual" {
				name := "replay-admin-" + uuid.NewString()
				var actorID int64
				require.NoError(t, tx.QueryRow(ctx, "INSERT INTO users (username,lower_username) VALUES ($1,$1) RETURNING id", name).Scan(&actorID))
				adminCtx := services.ContextWithAdminAuditActor(ctx, services.AdminAuditActor{UserID: actorID, Username: name})
				_, err = NewAdminIncidentsService(q).Resolve(adminCtx, canonical.ID, nil)
				require.NoError(t, err)
			} else {
				require.NoError(t, NewCanaryReportService(q).ReportResults(ctx, CanaryReportInput{Suite: "workflow", RunID: "replay-healthy", Results: []CanaryReportResult{{Test: "probe", Status: "success"}}}, time.Now()))
			}
			resolved, err := q.GetAlertIncident(ctx, canonical.ID)
			require.NoError(t, err)
			require.Equal(t, "resolved", resolved.State)
			require.NoError(t, svc.HandleAlertIncident(ctx, b))
			rows, err := q.ListAlertIncidents(ctx, clusterdb.ListAlertIncidentsParams{StateFilter: "all", Policy: pgtype.Text{String: policy, Valid: true}, PageLimit: 200})
			require.NoError(t, err)
			require.Len(t, rows, 1, "replayed deduplicated ID must not resurrect an incident")
			afterReplay, err := q.GetAlertIncident(ctx, canonical.ID)
			require.NoError(t, err)
			require.Equal(t, resolved, afterReplay)
			jobsAfter, err := q.ListAlertRemediationJobsForIncidents(ctx, []int64{canonical.ID})
			require.NoError(t, err)
			require.Equal(t, jobs, jobsAfter)

			// A new delivery may start a new incident, but the old ID cannot
			// refresh or close that new incident.
			c := a
			c.IncidentID = "canary-" + uuid.NewString()
			require.NoError(t, svc.HandleAlertIncident(ctx, c))
			newIncident, err := q.GetAlertIncidentByIncidentID(ctx, c.IncidentID)
			require.NoError(t, err)
			require.NoError(t, svc.HandleAlertIncident(ctx, b))
			b.State = "closed"
			require.NoError(t, svc.HandleAlertIncident(ctx, b))
			unchanged, err := q.GetAlertIncident(ctx, newIncident.ID)
			require.NoError(t, err)
			require.Equal(t, newIncident, unchanged)
			var jobCount int
			require.NoError(t, tx.QueryRow(ctx, "SELECT count(*) FROM alert_remediation_jobs j JOIN alert_incidents i ON i.id=j.incident_id WHERE i.policy_name=$1", policy).Scan(&jobCount))
			require.Equal(t, 2, jobCount, "only distinct incident admissions enqueue jobs")
		})
	}
}

func TestIncidentLifecycleCloseDeliveryAssociation(t *testing.T) {
	for _, first := range []int{0, 1} {
		t.Run(fmt.Sprint(first), func(t *testing.T) {
			pool := getAgentTestPool(t)
			ctx := context.Background()
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			q := deploymentdb.New(tx)
			svc := NewAlertIncidentService(q, nil, WithAlertRemediationEnabled(false))
			policy := "close-association-" + uuid.NewString()
			deliveries := []MonitoringAlertIncident{
				{IncidentID: uuid.NewString(), PolicyName: policy, ConditionName: "condition", State: "open"},
				{IncidentID: uuid.NewString(), PolicyName: policy, ConditionName: "condition", State: "open"},
			}
			for _, delivery := range deliveries {
				require.NoError(t, svc.HandleAlertIncident(ctx, delivery))
			}
			canonical, err := q.GetAlertIncidentByIncidentID(ctx, deliveries[0].IncidentID)
			require.NoError(t, err)
			closeFirst := deliveries[first]
			closeFirst.State = "closed"
			require.NoError(t, svc.HandleAlertIncident(ctx, closeFirst))
			require.NoError(t, svc.HandleAlertIncident(ctx, closeFirst))
			require.NoError(t, svc.HandleAlertIncident(ctx, deliveries[first]), "a closed occurrence cannot reopen")
			stillActive, err := q.GetAlertIncident(ctx, canonical.ID)
			require.NoError(t, err)
			require.Equal(t, canonical, stillActive, "another live delivery keeps the incident open")
			closeLast := deliveries[1-first]
			closeLast.State = "closed"
			require.NoError(t, svc.HandleAlertIncident(ctx, closeLast))
			resolved, err := q.GetAlertIncident(ctx, canonical.ID)
			require.NoError(t, err)
			require.Equal(t, "resolved", resolved.State)
			for _, delivery := range deliveries {
				require.NoError(t, svc.HandleAlertIncident(ctx, delivery))
			}
			rows, err := q.ListAlertIncidents(ctx, clusterdb.ListAlertIncidentsParams{StateFilter: "all", Policy: pgtype.Text{String: policy, Valid: true}, PageLimit: 200})
			require.NoError(t, err)
			require.Len(t, rows, 1)
			unknown := MonitoringAlertIncident{IncidentID: uuid.NewString(), PolicyName: policy, State: "closed"}
			require.NoError(t, svc.HandleAlertIncident(ctx, unknown))
			unknown.State = "open"
			require.NoError(t, svc.HandleAlertIncident(ctx, unknown))
			tombstone, err := q.GetAlertIncidentByIncidentID(ctx, unknown.IncidentID)
			require.NoError(t, err)
			require.Equal(t, "resolved", tombstone.State)
		})
	}
}

func TestIncidentLifecycleDeliveryAdmissionRollback(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	// Force a real enqueue failure after incident and delivery insertion. The
	// service's savepoint must roll both back, leaving the delivery retryable.
	_, err = tx.Exec(ctx, `
		CREATE FUNCTION pg_temp.reject_incident_job() RETURNS trigger LANGUAGE plpgsql AS
		$$ BEGIN RAISE EXCEPTION 'injected enqueue failure'; END $$;
		CREATE TRIGGER reject_incident_job BEFORE INSERT ON alert_remediation_jobs
		FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_incident_job();`)
	require.NoError(t, err)
	q := deploymentdb.New(tx)
	svc := NewAlertIncidentService(q, testAlertRegistry(t))
	delivery := MonitoringAlertIncident{IncidentID: uuid.NewString(), PolicyName: "Smithers High Error Rate - " + uuid.NewString(), ConditionName: "condition", State: "open"}
	require.ErrorContains(t, svc.HandleAlertIncident(ctx, delivery), "injected enqueue failure")
	var count int
	require.NoError(t, tx.QueryRow(ctx, "SELECT count(*) FROM alert_incidents WHERE incident_id=$1", delivery.IncidentID).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, tx.QueryRow(ctx, "SELECT count(*) FROM alert_incident_deliveries WHERE incident_id=$1", delivery.IncidentID).Scan(&count))
	require.Zero(t, count)
	_, err = tx.Exec(ctx, "DROP TRIGGER reject_incident_job ON alert_remediation_jobs")
	require.NoError(t, err)
	require.NoError(t, svc.HandleAlertIncident(ctx, delivery))
	incident, err := q.GetAlertIncidentByIncidentID(ctx, delivery.IncidentID)
	require.NoError(t, err)
	jobs, err := q.ListAlertRemediationJobsForIncidents(ctx, []int64{incident.ID})
	require.NoError(t, err)
	require.Len(t, jobs, 1)
}
