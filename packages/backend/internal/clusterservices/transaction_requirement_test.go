package clusterservices

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// These stores deliberately expose the domain surface without transaction
// support. A hosted wiring error must fail before any domain method is called.
type nonTransactionalRunner struct{ RunnerQuerier }
type nonTransactionalIncident struct{ AdminIncidentsQuerier }

func TestHostedMutationsRejectNonTransactionalStores(t *testing.T) {
	ctx := context.Background()
	t.Run("runner", func(t *testing.T) {
		svc := NewRunnerService(nonTransactionalRunner{}, WithRunnerTransactions())
		require.ErrorContains(t, svc.Terminate(ctx, 1), "requires transactions")
	})
	t.Run("alert", func(t *testing.T) {
		q := &fakeAlertIncidentQuerier{}
		svc := NewAlertIncidentService(q, testAlertRegistry(t), WithAlertTransactions())
		require.ErrorContains(t, svc.HandleAlertIncident(ctx, MonitoringAlertIncident{State: "open", PolicyName: "unknown"}), "requires transactions")
		require.Empty(t, q.createdIncidents)
		require.Empty(t, q.enqueuedJobs)
	})
	t.Run("mutation and audit", func(t *testing.T) {
		svc := &AdminIncidentsService{queries: nonTransactionalIncident{}, requireTransactions: true}
		called := false
		require.ErrorContains(t, svc.transaction(ctx, func(AdminIncidentsQuerier) error { called = true; return nil }), "requires transactions")
		require.False(t, called)
	})
}
