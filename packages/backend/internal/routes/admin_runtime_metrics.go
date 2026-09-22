package routes

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/prometheus/client_golang/prometheus"
)

// AdminRuntimeMetricsQuerier reads durable sandbox inventory and queue backlog.
type AdminRuntimeMetricsQuerier interface {
	GetSandboxActiveVMsByKind(context.Context) ([]clusterdb.GetSandboxActiveVMsByKindRow, error)
	GetSandboxInstancesByState(context.Context) ([]clusterdb.GetSandboxInstancesByStateRow, error)
	GetAdminQueueMetrics(context.Context) ([]clusterdb.GetAdminQueueMetricsRow, error)
}

// AdminRuntimeMetricsCollector exports database snapshots, independent of API
// restarts. Scrapes read cached snapshots; stale groups omit their series.
type AdminRuntimeMetricsCollector struct {
	queries                       AdminRuntimeMetricsQuerier
	active, instances, depth, age *prometheus.Desc
	timeout                       time.Duration
	staleAfter                    time.Duration
	stale                         *prometheus.Desc
	snapshot                      atomic.Pointer[adminRuntimeSnapshot]
	refreshMu                     sync.Mutex
	startOnce                     sync.Once
	done                          chan struct{}
}

func NewAdminRuntimeMetricsCollector(q AdminRuntimeMetricsQuerier) *AdminRuntimeMetricsCollector {
	return &AdminRuntimeMetricsCollector{
		queries: q, timeout: 3 * time.Second, staleAfter: 60 * time.Second, done: make(chan struct{}),
		stale:     prometheus.NewDesc("smithers_collector_stale", "One when the collector has no snapshot newer than its freshness limit.", []string{"collector"}, nil),
		active:    prometheus.NewDesc("smithers_sandbox_active_vms_db", "Sandbox instances holding compute reservations, by resource kind.", []string{"kind"}, nil),
		instances: prometheus.NewDesc("smithers_sandbox_instances", "Non-deleted sandbox instances by observed state.", []string{"observed_state"}, nil),
		depth:     prometheus.NewDesc("smithers_queue_depth", "Persisted queue backlog, including delayed retries.", []string{"queue"}, nil),
		age:       prometheus.NewDesc("smithers_queue_oldest_age_seconds", "Age since creation of the oldest queued item; zero when empty.", []string{"queue"}, nil),
	}
}

func (c *AdminRuntimeMetricsCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{c.active, c.instances, c.depth, c.age, c.stale} {
		ch <- d
	}
}

type adminRuntimeMetricGroup struct {
	metrics []prometheus.Metric
	updated time.Time
}
type adminRuntimeSnapshot [3]adminRuntimeMetricGroup

// Start refreshes immediately and then every 15 seconds, with only one refresh
// in flight. The server context owns the loop's lifetime.
func (c *AdminRuntimeMetricsCollector) Start(ctx context.Context) <-chan struct{} {
	c.startOnce.Do(func() {
		go func() {
			defer close(c.done)
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			for {
				if ctx.Err() != nil {
					return
				}
				c.refresh(ctx)
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	})
	return c.done
}

func (c *AdminRuntimeMetricsCollector) refresh(parent context.Context) {
	if c.queries == nil || !c.refreshMu.TryLock() {
		return
	}
	defer c.refreshMu.Unlock()
	ctx, cancel := context.WithTimeout(parent, c.timeout)
	defer cancel()
	var next adminRuntimeSnapshot
	if previous := c.snapshot.Load(); previous != nil {
		next = *previous
	}
	save := func(index int, metrics []prometheus.Metric, err error) {
		if err != nil {
			slog.Warn("refresh runtime inventory", "collector", adminRuntimeCollectorNames[index], "error", err)
			return
		}
		next[index] = adminRuntimeMetricGroup{metrics: metrics, updated: time.Now()}
	}
	active, err := c.queries.GetSandboxActiveVMsByKind(ctx)
	var metrics []prometheus.Metric
	for _, row := range active {
		metrics = append(metrics, prometheus.MustNewConstMetric(c.active, prometheus.GaugeValue, float64(row.Count), row.Kind))
	}
	save(0, metrics, err)
	instances, err := c.queries.GetSandboxInstancesByState(ctx)
	metrics = nil
	for _, row := range instances {
		metrics = append(metrics, prometheus.MustNewConstMetric(c.instances, prometheus.GaugeValue, float64(row.Count), row.ObservedState))
	}
	save(1, metrics, err)
	queues, err := c.queries.GetAdminQueueMetrics(ctx)
	metrics = nil
	for _, row := range queues {
		metrics = append(metrics, prometheus.MustNewConstMetric(c.depth, prometheus.GaugeValue, float64(row.Depth), row.Queue), prometheus.MustNewConstMetric(c.age, prometheus.GaugeValue, row.OldestAgeSeconds, row.Queue))
	}
	save(2, metrics, err)
	c.snapshot.Store(&next)
}

var adminRuntimeCollectorNames = [3]string{"sandbox_reservations", "sandbox_inventory", "queues"}

// Collect only reads an immutable in-memory snapshot. Failed refreshes retain
// the last success until staleAfter; expired or missing groups emit no data.
func (c *AdminRuntimeMetricsCollector) Collect(ch chan<- prometheus.Metric) {
	snapshot := c.snapshot.Load()
	now := time.Now()
	for i, name := range adminRuntimeCollectorNames {
		stale := 1.0
		if snapshot != nil && !snapshot[i].updated.IsZero() && now.Sub(snapshot[i].updated) < c.staleAfter {
			stale = 0
			for _, metric := range snapshot[i].metrics {
				ch <- metric
			}
		}
		ch <- prometheus.MustNewConstMetric(c.stale, prometheus.GaugeValue, stale, name)
	}
}
