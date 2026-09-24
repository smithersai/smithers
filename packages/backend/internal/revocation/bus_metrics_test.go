package revocation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type failingLister struct{ latestErr, listErr error }

func (l failingLister) ListRevocationEventsAfter(context.Context, db.ListRevocationEventsAfterParams) ([]db.RevocationEvent, error) {
	return nil, l.listErr
}

func (l failingLister) LatestRevocationEventID(context.Context) (int64, error) {
	return 0, l.latestErr
}

func gatherValue(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) (float64, bool) {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
	metrics:
		for _, metric := range family.GetMetric() {
			for _, pair := range metric.GetLabel() {
				if want, ok := labels[pair.GetName()]; ok && want != pair.GetValue() {
					continue metrics
				}
			}
			switch {
			case metric.GetGauge() != nil:
				return metric.GetGauge().GetValue(), true
			case metric.GetCounter() != nil:
				return metric.GetCounter().GetValue(), true
			}
		}
	}
	return 0, false
}

func TestBus_MetricsReportPositionCursorAndAppliedEvents(t *testing.T) {
	log := newFakeLog()
	bus := newBus(log)
	reg := prometheus.NewRegistry()
	reg.MustRegister(bus.MetricsCollectors()...)

	if v, ok := gatherValue(t, reg, "smithers_revocation_bus_positioned", nil); !ok || v != 0 {
		t.Fatalf("positioned before start = %v (found %v), want 0", v, ok)
	}

	bus.PollInterval = 50 * time.Millisecond
	bus.acquire = func(context.Context) (notifier, error) { return &fakeConn{log: log}, nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := bus.Start(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !bus.Positioned() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := log.InsertRevocationEvent(context.Background(), Event{Kind: KindUserDisabled, UserID: 9}.ToParams()); err != nil {
		t.Fatal(err)
	}
	for bus.Cursor() < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	if v, _ := gatherValue(t, reg, "smithers_revocation_bus_positioned", nil); v != 1 {
		t.Fatalf("positioned = %v, want 1", v)
	}
	if v, _ := gatherValue(t, reg, "smithers_revocation_bus_cursor", nil); v != 1 {
		t.Fatalf("cursor = %v, want 1", v)
	}
	if v, _ := gatherValue(t, reg, "smithers_revocation_events_applied_total", map[string]string{"kind": string(KindUserDisabled)}); v != 1 {
		t.Fatalf("events applied = %v, want 1", v)
	}
}

func TestBus_MetricsCountCatchUpErrorsAndReconnects(t *testing.T) {
	bus := newBus(failingLister{listErr: errors.New("db down")})
	bus.PollInterval = 10 * time.Millisecond
	bus.catchUp(context.Background())
	if got := testutil.ToFloat64(bus.metrics.catchUpErrors); got != 1 {
		t.Fatalf("catch-up errors = %v, want 1", got)
	}

	attempts := 0
	bus.acquire = func(context.Context) (notifier, error) {
		attempts++
		return nil, errors.New("no connection")
	}
	bus.lister = nil
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	bus.run(ctx)
	if got := testutil.ToFloat64(bus.metrics.reconnects); got < 1 {
		t.Fatalf("reconnects = %v, want >= 1 after %d failed acquires", got, attempts)
	}
}
