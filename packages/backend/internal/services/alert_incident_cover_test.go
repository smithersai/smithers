package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAlertIncident_Cov_NewNilAndNormalizeBranches(t *testing.T) {
	svc := NewAlertIncidentService(nil, testAlertRegistry(t))
	if svc.queries != nil || svc.registry == nil || svc.now == nil || svc.logger == nil {
		t.Fatalf("service defaults not initialized: %+v", svc)
	}

	if err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{IncidentID: "noop", State: "open"}); err != nil {
		t.Fatalf("nil-query HandleAlertIncident returned error: %v", err)
	}

	var nilSvc *AlertIncidentService
	if err := nilSvc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{State: "failed"}); err != nil {
		t.Fatalf("nil RecordRemediationOutcome returned error: %v", err)
	}

	if got := normalizeAlertPolicySlug("  Smithers High Error Rate - Prod  "); got != "smithers-high-error-rate" {
		t.Fatalf("slug = %q", got)
	}
}

func TestAlertIncident_Cov_ErrorBranches(t *testing.T) {
	t.Run("closed resolve error wraps incident id", func(t *testing.T) {
		q := &alertIncidentCovResolveErrQuerier{fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{}}
		err := NewAlertIncidentService(q, testAlertRegistry(t)).HandleAlertIncident(context.Background(), MonitoringAlertIncident{
			IncidentID: "0.closed", State: "closed",
		})
		if err == nil || !strings.Contains(err.Error(), "resolve alert incident 0.closed") {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("create error wraps", func(t *testing.T) {
		errBoom := errors.New("insert failed")
		svc := newTestAlertIncidentService(&fakeAlertIncidentQuerier{createErr: errBoom}, testAlertRegistry(t))
		err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{IncidentID: "0.open", State: "open"})
		if err == nil || !strings.Contains(err.Error(), "create alert incident 0.open") {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("outcome missing incident wraps", func(t *testing.T) {
		svc := newTestAlertIncidentService(&fakeAlertIncidentQuerier{incidentByID: map[string]db.AlertIncident{}}, testAlertRegistry(t))
		err := svc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{IncidentID: "missing", State: "failed"})
		if err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("err = %v", err)
		}
	})
}

type alertIncidentCovResolveErrQuerier struct {
	*fakeAlertIncidentQuerier
}

func (q *alertIncidentCovResolveErrQuerier) ResolveAlertIncidentByIncidentID(context.Context, string) error {
	return errors.New("resolve failed")
}
