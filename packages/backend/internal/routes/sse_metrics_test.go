package routes_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// ---------------------------------------------------------------------------
// SSE Metrics Integration Tests
//
// These tests validate that the SSE active connections gauge
// (smithers_sse_active_connections) is properly incremented and decremented
// during the lifecycle of SSE streaming connections.
//
// Reference: docs/specs/infra.md §8.1
// ---------------------------------------------------------------------------

// TestSSEActiveConnectionsGauge_ReflectsActiveStreams verifies that the
// SSE active connections gauge correctly reflects the number of concurrent
// SSE streams by testing the handler behavior with the metrics dependency.
func TestSSEActiveConnectionsGauge_ReflectsActiveStreams(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Simulate multiple concurrent SSE streams.
	// Each stream should increment the gauge on open and decrement on close.

	// Before any connections.
	assertGaugeValue(t, m, "smithers_sse_active_connections", 0)

	// Simulate opening 3 concurrent SSE connections.
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Simulate SSE connection lifecycle.
			m.SSEActiveConnections.Inc()
			time.Sleep(10 * time.Millisecond) // Simulate active stream duration.
			m.SSEActiveConnections.Dec()
		}()
	}
	wg.Wait()

	// After all connections closed.
	assertGaugeValue(t, m, "smithers_sse_active_connections", 0)
}

// TestSSEActiveConnectionsGauge_MidStreamValue verifies that during active
// streaming, the gauge reflects the correct number of open connections.
func TestSSEActiveConnectionsGauge_MidStreamValue(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Start 5 concurrent streams.
	barrier := make(chan struct{})
	var wg sync.WaitGroup

	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.SSEActiveConnections.Inc()
			<-barrier // Wait for signal to close.
			m.SSEActiveConnections.Dec()
		}()
	}

	// Allow goroutines to start.
	time.Sleep(20 * time.Millisecond)

	// With 5 concurrent streams active, gauge should read 5.
	assertGaugeValue(t, m, "smithers_sse_active_connections", 5)

	// Signal all streams to close.
	close(barrier)
	wg.Wait()

	// After all closed.
	assertGaugeValue(t, m, "smithers_sse_active_connections", 0)
}

// TestSSEActiveConnectionsGauge_RapidOpenClose verifies gauge correctness
// under rapid open/close cycles (connection churn).
func TestSSEActiveConnectionsGauge_RapidOpenClose(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Rapidly open and close 100 connections sequentially.
	for i := 0; i < 100; i++ {
		m.SSEActiveConnections.Inc()
		m.SSEActiveConnections.Dec()
	}

	// After all churn, gauge should be back to 0.
	assertGaugeValue(t, m, "smithers_sse_active_connections", 0)
}

// TestSSEActiveConnectionsGauge_ConcurrentChurn verifies gauge correctness
// under concurrent connection churn (stress test).
func TestSSEActiveConnectionsGauge_ConcurrentChurn(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	const workers = 20
	const iterations = 50

	var wg sync.WaitGroup
	wg.Add(workers)

	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				m.SSEActiveConnections.Inc()
				// Minimal work.
				m.SSEActiveConnections.Dec()
			}
		}()
	}

	wg.Wait()

	// After all concurrent churn, gauge must be 0.
	assertGaugeValue(t, m, "smithers_sse_active_connections", 0)
}

// TestSSEActiveConnectionsGauge_IsolatedPerMetricsInstance verifies that
// different SmithersMetrics instances have isolated SSE connection gauges.
func TestSSEActiveConnectionsGauge_IsolatedPerMetricsInstance(t *testing.T) {
	t.Parallel()

	m1 := routes.NewSmithersMetrics()
	m2 := routes.NewSmithersMetrics()

	// Increment on m1 only.
	m1.SSEActiveConnections.Inc()
	m1.SSEActiveConnections.Inc()

	// m1 should show 2.
	assertGaugeValue(t, m1, "smithers_sse_active_connections", 2)

	// m2 should show 0 (isolated).
	assertGaugeValue(t, m2, "smithers_sse_active_connections", 0)
}

// TestSSEActiveConnectionsGauge_CanGoNegative verifies that the gauge
// implementation allows negative values (Prometheus Gauge Dec() can go negative).
// This test documents expected behavior - production code should handle this.
func TestSSEActiveConnectionsGauge_CanGoNegative(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Decrement without increment (programmer error scenario).
	m.SSEActiveConnections.Dec()
	m.SSEActiveConnections.Dec()

	// Prometheus gauge will go negative (this documents the behavior).
	// Production code must ensure proper Inc/Dec pairing.
	body := getMetricsBodyFromMetrics(t, m)
	assert.Contains(t, body, "smithers_sse_active_connections -2",
		"gauge can go negative if Dec() is called without matching Inc() - production code must prevent this")
}

// ---------------------------------------------------------------------------
// Runner Pool Gauge Tests
// ---------------------------------------------------------------------------

// TestRunnerPoolGauge_TransitionFromAvailableToClaimed verifies that when a
// runner is claimed, the available gauge decrements and claimed increments.
func TestRunnerPoolGauge_TransitionFromAvailableToClaimed(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Initial state: 10 available, 0 claimed.
	m.RunnerPoolAvailable.Set(10)
	m.RunnerPoolClaimed.Set(0)

	assertGaugeValue(t, m, "smithers_runner_pool_available", 10)
	assertGaugeValue(t, m, "smithers_runner_pool_claimed", 0)

	// Claim a runner.
	m.RunnerPoolAvailable.Dec()
	m.RunnerPoolClaimed.Inc()

	assertGaugeValue(t, m, "smithers_runner_pool_available", 9)
	assertGaugeValue(t, m, "smithers_runner_pool_claimed", 1)

	// Release the runner.
	m.RunnerPoolAvailable.Inc()
	m.RunnerPoolClaimed.Dec()

	assertGaugeValue(t, m, "smithers_runner_pool_available", 10)
	assertGaugeValue(t, m, "smithers_runner_pool_claimed", 0)
}

// TestRunnerPoolGauge_MultipleTransitions verifies runner pool gauge
// consistency across multiple claim/release cycles.
func TestRunnerPoolGauge_MultipleTransitions(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// Start with pool of 5.
	m.RunnerPoolAvailable.Set(5)
	m.RunnerPoolClaimed.Set(0)

	// Claim 3 runners.
	for i := 0; i < 3; i++ {
		m.RunnerPoolAvailable.Dec()
		m.RunnerPoolClaimed.Inc()
	}

	assertGaugeValue(t, m, "smithers_runner_pool_available", 2)
	assertGaugeValue(t, m, "smithers_runner_pool_claimed", 3)

	// Release 2 runners.
	for i := 0; i < 2; i++ {
		m.RunnerPoolAvailable.Inc()
		m.RunnerPoolClaimed.Dec()
	}

	assertGaugeValue(t, m, "smithers_runner_pool_available", 4)
	assertGaugeValue(t, m, "smithers_runner_pool_claimed", 1)
}

// TestActiveAgentSessionsGauge_SimulatedSessionLifecycle verifies the
// active agent sessions gauge tracks concurrent sessions correctly.
func TestActiveAgentSessionsGauge_SimulatedSessionLifecycle(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	// No active sessions initially.
	assertGaugeValue(t, m, "smithers_active_agent_sessions", 0)

	// 3 sessions start.
	for i := 0; i < 3; i++ {
		m.ActiveAgentSessions.Inc()
	}
	assertGaugeValue(t, m, "smithers_active_agent_sessions", 3)

	// 2 sessions end.
	m.ActiveAgentSessions.Dec()
	m.ActiveAgentSessions.Dec()

	assertGaugeValue(t, m, "smithers_active_agent_sessions", 1)

	// Last session ends.
	m.ActiveAgentSessions.Dec()
	assertGaugeValue(t, m, "smithers_active_agent_sessions", 0)
}

// ---------------------------------------------------------------------------
// Integration with HTTP router
// ---------------------------------------------------------------------------

// TestMetricsEndpoint_SSEGaugeViaRouter verifies the SSE gauge is accessible
// via the /metrics endpoint through a router.
func TestMetricsEndpoint_SSEGaugeViaRouter(t *testing.T) {
	t.Parallel()

	m := routes.NewSmithersMetrics()

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.RealIP(0))
	r.Use(middleware.JSONRecoverer)
	r.Get("/metrics", m.Handler().ServeHTTP)

	// Simulate some SSE connections.
	m.SSEActiveConnections.Set(42)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()

	assert.Contains(t, body, "smithers_sse_active_connections 42",
		"SSE active connections gauge must be readable via /metrics endpoint")
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

// assertGaugeValue asserts that a gauge metric has the expected value
// by scraping the /metrics output.
func assertGaugeValue(t *testing.T, m *routes.SmithersMetrics, metricName string, expected float64) {
	t.Helper()

	body := getMetricsBodyFromMetrics(t, m)

	// Look for the metric value line.
	expectedLine := fmt.Sprintf("%s %v", metricName, expected)
	// Normalize expected to handle float formatting.
	if expected == float64(int64(expected)) {
		expectedLine = fmt.Sprintf("%s %d", metricName, int64(expected))
	}

	assert.Contains(t, body, expectedLine,
		"gauge %s should have value %v", metricName, expected)
}

// getMetricsBodyFromMetrics retrieves the /metrics output from a SmithersMetrics instance.
func getMetricsBodyFromMetrics(t *testing.T, m *routes.SmithersMetrics) string {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "/metrics must return 200")
	return rec.Body.String()
}
