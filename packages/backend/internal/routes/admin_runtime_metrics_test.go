package routes

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
)

type adminRuntimeMetricsFake struct {
	fail     string
	block    bool
	contexts []context.Context
}

func (f *adminRuntimeMetricsFake) check(ctx context.Context, name string) error {
	f.contexts = append(f.contexts, ctx)
	if f.block {
		<-ctx.Done()
		return ctx.Err()
	}
	if f.fail == name {
		return errors.New("database unavailable")
	}
	return nil
}
func (f *adminRuntimeMetricsFake) GetSandboxActiveVMsByKind(ctx context.Context) ([]clusterdb.GetSandboxActiveVMsByKindRow, error) {
	err := f.check(ctx, "active")
	return []clusterdb.GetSandboxActiveVMsByKindRow{{Kind: "workspace", Count: 3}, {Kind: "agent_session", Count: 0}}, err
}
func (f *adminRuntimeMetricsFake) GetSandboxInstancesByState(ctx context.Context) ([]clusterdb.GetSandboxInstancesByStateRow, error) {
	err := f.check(ctx, "instances")
	return []clusterdb.GetSandboxInstancesByStateRow{{ObservedState: "running", Count: 3}, {ObservedState: "failed", Count: 2}}, err
}
func (f *adminRuntimeMetricsFake) GetAdminQueueMetrics(ctx context.Context) ([]clusterdb.GetAdminQueueMetricsRow, error) {
	err := f.check(ctx, "queues")
	rows := []clusterdb.GetAdminQueueMetricsRow{}
	for _, q := range []string{"landing_tasks", "workflow_tasks_runner", "workflow_tasks_sandbox", "workflow_tasks_agent", "github_webhook_jobs", "webhook_deliveries", "alert_remediation_jobs", "storage_deletion_queue", "import_jobs", "repo_replication_jobs", "pair_prompt_queue"} {
		rows = append(rows, clusterdb.GetAdminQueueMetricsRow{Queue: q, Depth: 2, OldestAgeSeconds: 90})
	}
	return rows, err
}
func TestAdminRuntimeMetricsCollector(t *testing.T) {
	f := &adminRuntimeMetricsFake{}
	c := NewAdminRuntimeMetricsCollector(f)
	c.refresh(context.Background())
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(c)
	metrics, err := reg.Gather()
	require.NoError(t, err)
	require.Len(t, metrics, 5)
	for _, m := range metrics {
		if m.GetName() == "smithers_queue_depth" || m.GetName() == "smithers_queue_oldest_age_seconds" {
			require.Len(t, m.Metric, 11)
		}
	}
	require.NoError(t, testutil.CollectAndCompare(c, strings.NewReader(`# HELP smithers_sandbox_active_vms_db Sandbox instances holding compute reservations, by resource kind.
# TYPE smithers_sandbox_active_vms_db gauge
smithers_sandbox_active_vms_db{kind="workspace"} 3
smithers_sandbox_active_vms_db{kind="agent_session"} 0
`), "smithers_sandbox_active_vms_db"))
	for _, ctx := range f.contexts {
		deadline, ok := ctx.Deadline()
		require.True(t, ok)
		require.WithinDuration(t, time.Now().Add(3*time.Second), deadline, time.Second)
	}
}
func TestAdminRuntimeMetricsCollector_QueryFailureOmitsOnlyAffectedSeries(t *testing.T) {
	for _, tc := range []struct {
		fail  string
		count int
	}{{"active", 24}, {"instances", 24}, {"queues", 4}} {
		t.Run(tc.fail, func(t *testing.T) {
			c := NewAdminRuntimeMetricsCollector(&adminRuntimeMetricsFake{fail: tc.fail})
			c.refresh(context.Background())
			require.Equal(t, tc.count+3, testutil.CollectAndCount(c))
		})
	}
	require.Equal(t, 3, testutil.CollectAndCount(NewAdminRuntimeMetricsCollector(nil)))
}

// This query remains blocked while full HTTP scrapes complete, including
// concurrent scrapes and another attempted refresh.
type blockingInventoryFake struct {
	adminRuntimeMetricsFake
	entered chan context.Context
	release chan struct{}
	calls   atomic.Int64
}

func (f *blockingInventoryFake) GetSandboxActiveVMsByKind(ctx context.Context) ([]clusterdb.GetSandboxActiveVMsByKindRow, error) {
	f.calls.Add(1)
	f.entered <- ctx
	select {
	case <-f.release:
		return f.adminRuntimeMetricsFake.GetSandboxActiveVMsByKind(ctx)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestAdminRuntimeMetricsCollector_ScrapesDuringBlockedRefresh(t *testing.T) {
	f := &blockingInventoryFake{entered: make(chan context.Context, 1), release: make(chan struct{})}
	c := NewAdminRuntimeMetricsCollector(f)
	metrics := NewSmithersMetrics()
	metrics.MustRegister(c)
	ctx, cancel := context.WithCancel(context.Background())
	done := c.Start(ctx)
	defer func() { cancel(); <-done }()
	queryCtx := <-f.entered
	deadline, ok := queryCtx.Deadline()
	require.True(t, ok)
	require.WithinDuration(t, time.Now().Add(3*time.Second), deadline, time.Second)
	c.refresh(ctx) // Must not launch a duplicate scan.
	finished := make(chan string, 8)
	for i := 0; i < cap(finished); i++ {
		go func() {
			w := httptest.NewRecorder()
			metrics.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
			finished <- w.Body.String()
		}()
	}
	for i := 0; i < cap(finished); i++ {
		select {
		case body := <-finished:
			require.Contains(t, body, `smithers_collector_stale{collector="sandbox_reservations"} 1`)
			require.NotContains(t, body, "smithers_sandbox_active_vms_db")
		case <-time.After(time.Second):
			t.Fatal("scrape waited for database")
		}
	}
	require.Equal(t, int64(1), f.calls.Load())
	close(f.release)
	require.Eventually(t, func() bool { return c.snapshot.Load() != nil }, time.Second, time.Millisecond)
	require.Equal(t, 29, testutil.CollectAndCount(c))
}

func TestAdminRuntimeMetricsCollector_DeadlineAndFreshness(t *testing.T) {
	f := &adminRuntimeMetricsFake{}
	c := NewAdminRuntimeMetricsCollector(f)
	c.refresh(context.Background())
	// A failed group retains its last success without replacing it with zero.
	previous := c.snapshot.Load()[0].updated
	f.fail = "active"
	c.refresh(context.Background())
	require.Equal(t, previous, c.snapshot.Load()[0].updated)
	require.Equal(t, 29, testutil.CollectAndCount(c))
	expired := *c.snapshot.Load()
	expired[0].updated = time.Now().Add(-61 * time.Second)
	c.snapshot.Store(&expired)
	require.Equal(t, 27, testutil.CollectAndCount(c))
	require.NoError(t, testutil.CollectAndCompare(c, strings.NewReader(`# HELP smithers_collector_stale One when the collector has no snapshot newer than its freshness limit.
# TYPE smithers_collector_stale gauge
smithers_collector_stale{collector="sandbox_reservations"} 1
smithers_collector_stale{collector="sandbox_inventory"} 0
smithers_collector_stale{collector="queues"} 0
`), "smithers_collector_stale"))
	f.fail = ""
	c.refresh(context.Background())
	require.Equal(t, 29, testutil.CollectAndCount(c))
	f.block = true
	c.timeout = 10 * time.Millisecond
	started := time.Now()
	c.refresh(context.Background())
	require.Less(t, time.Since(started), time.Second)
	require.Equal(t, context.DeadlineExceeded, f.contexts[len(f.contexts)-1].Err())
}
