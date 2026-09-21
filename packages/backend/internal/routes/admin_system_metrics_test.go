package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockMetricsRangeQuerier struct {
	mu      sync.Mutex
	calls   int
	queries []string
	starts  []time.Time
	ends    []time.Time
	steps   []time.Duration

	series []services.MetricSeries
	err    error
}

func (m *mockMetricsRangeQuerier) QueryRange(_ context.Context, query string, start, end time.Time, step time.Duration) ([]services.MetricSeries, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	m.queries = append(m.queries, query)
	m.starts = append(m.starts, start)
	m.ends = append(m.ends, end)
	m.steps = append(m.steps, step)
	if m.err != nil {
		return nil, m.err
	}
	return m.series, nil
}

func (m *mockMetricsRangeQuerier) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func (m *mockMetricsRangeQuerier) lastQuery() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.queries) == 0 {
		return ""
	}
	return m.queries[len(m.queries)-1]
}

func metricsQueryRequest(target string) *http.Request {
	return withAdminContext(httptest.NewRequest(http.MethodGet, target, nil))
}

func fixedClock(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

func TestAdminSystemMetricsHandler_Query_Allowlist(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		target     string
		wantStatus int
		wantQuery  string
		wantStep   int
		wantRange  string
	}{
		{name: "queue_depth retains queue labels", target: "/api/admin/system/metrics/query?name=queue_depth", wantStatus: http.StatusOK, wantQuery: `max by (queue) (smithers_queue_depth{namespace="smithers"})`, wantStep: 60, wantRange: "1h"},
		{
			name:       "http_request_rate at the default range",
			target:     "/api/admin/system/metrics/query?name=http_request_rate",
			wantStatus: http.StatusOK,
			wantQuery:  `sum(rate(smithers_http_requests_total{namespace="smithers"}[5m]))`,
			wantStep:   60,
			wantRange:  "1h",
		},
		{
			name:       "http_error_rate at 6h",
			target:     "/api/admin/system/metrics/query?name=http_error_rate&range=6h",
			wantStatus: http.StatusOK,
			wantQuery: `(sum(rate(smithers_http_requests_total{namespace="smithers",status=~"5.."}[10m]))` +
				` / sum(rate(smithers_http_requests_total{namespace="smithers"}[10m]))) * 100`,
			wantStep:  300,
			wantRange: "6h",
		},
		{
			name:       "http_p95_latency at 24h",
			target:     "/api/admin/system/metrics/query?name=http_p95_latency&range=24h",
			wantStatus: http.StatusOK,
			wantQuery: `histogram_quantile(0.95, sum(rate(smithers_http_request_duration_seconds_bucket` +
				`{namespace="smithers"}[30m])) by (le))`,
			wantStep:  900,
			wantRange: "24h",
		},
		{
			name:       "workflow_queue_depth",
			target:     "/api/admin/system/metrics/query?name=workflow_queue_depth",
			wantStatus: http.StatusOK,
			wantQuery:  `max(smithers_workflow_task_queue_depth{namespace="smithers"})`,
			wantStep:   60,
			wantRange:  "1h",
		},
		{
			name:       "runner_pool_available",
			target:     "/api/admin/system/metrics/query?name=runner_pool_available",
			wantStatus: http.StatusOK,
			wantQuery:  `max(smithers_runner_pool_available{namespace="smithers"})`,
			wantStep:   60,
			wantRange:  "1h",
		},
		{
			name:       "sse_connections",
			target:     "/api/admin/system/metrics/query?name=sse_connections",
			wantStatus: http.StatusOK,
			wantQuery:  `sum(smithers_sse_active_connections{namespace="smithers"})`,
			wantStep:   60,
			wantRange:  "1h",
		},
		{
			name:       "sandbox_active_vms",
			target:     "/api/admin/system/metrics/query?name=sandbox_active_vms",
			wantStatus: http.StatusOK,
			wantQuery:  `sum(max by (kind) (smithers_sandbox_active_vms_db{namespace="smithers"}))`,
			wantStep:   60,
			wantRange:  "1h",
		},
		{
			name:       "unknown name is rejected",
			target:     "/api/admin/system/metrics/query?name=cpu_usage",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing name is rejected",
			target:     "/api/admin/system/metrics/query",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "raw promql is rejected",
			target:     "/api/admin/system/metrics/query?name=" + `sum(rate(smithers_http_requests_total%5B5m%5D))`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unsupported range is rejected",
			target:     "/api/admin/system/metrics/query?name=sse_connections&range=7d",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			querier := &mockMetricsRangeQuerier{}
			h := &AdminSystemMetricsHandler{Querier: querier, Now: fixedClock(time.Unix(1770000000, 0).UTC())}

			rec := httptest.NewRecorder()
			h.Query(rec, metricsQueryRequest(tt.target))

			require.Equal(t, tt.wantStatus, rec.Code)

			if tt.wantStatus != http.StatusOK {
				assert.Zero(t, querier.callCount(), "a rejected request never reaches the backend")
				var body metricsQueryError
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
				assert.NotEmpty(t, body.Error)
				return
			}

			require.Equal(t, 1, querier.callCount())
			assert.Equal(t, tt.wantQuery, querier.lastQuery())

			var body metricsQueryResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, tt.wantRange, body.Range)
			assert.Equal(t, tt.wantStep, body.StepSeconds)
			assert.NotNil(t, body.Series)
		})
	}
}

func TestAdminSystemMetricsHandler_Query(t *testing.T) {
	t.Parallel()

	t.Run("returns 501 when the backend is not configured", func(t *testing.T) {
		t.Parallel()

		var h *AdminSystemMetricsHandler
		rec := httptest.NewRecorder()
		h.Query(rec, metricsQueryRequest("/api/admin/system/metrics/query?name=sse_connections"))

		require.Equal(t, http.StatusNotImplemented, rec.Code)
		var body metricsQueryError
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "metrics backend not configured", body.Error)
		assert.Equal(t, "metrics backend not configured", body.Message)
	})

	t.Run("returns 501 when the handler has no querier", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemMetricsHandler{}
		rec := httptest.NewRecorder()
		h.Query(rec, metricsQueryRequest("/api/admin/system/metrics/query?name=sse_connections"))

		require.Equal(t, http.StatusNotImplemented, rec.Code)
	})

	t.Run("maps an upstream failure to 502", func(t *testing.T) {
		t.Parallel()

		querier := &mockMetricsRangeQuerier{err: errors.New("metrics backend returned 403: permission denied")}
		h := &AdminSystemMetricsHandler{Querier: querier, Now: fixedClock(time.Unix(1770000000, 0).UTC())}

		rec := httptest.NewRecorder()
		h.Query(rec, metricsQueryRequest("/api/admin/system/metrics/query?name=sse_connections"))

		require.Equal(t, http.StatusBadGateway, rec.Code)
		var body metricsQueryError
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		// The response stays generic: upstream detail (project id, IAM gaps,
		// monitoring URLs) goes to the log, never to the client.
		assert.Equal(t, "metrics backend query failed", body.Error)
		assert.NotContains(t, body.Error, "permission denied")
	})

	t.Run("does not cache a failed query", func(t *testing.T) {
		t.Parallel()

		querier := &mockMetricsRangeQuerier{err: errors.New("boom")}
		h := &AdminSystemMetricsHandler{Querier: querier, Now: fixedClock(time.Unix(1770000000, 0).UTC())}

		for i := 0; i < 2; i++ {
			rec := httptest.NewRecorder()
			h.Query(rec, metricsQueryRequest("/api/admin/system/metrics/query?name=sse_connections"))
			require.Equal(t, http.StatusBadGateway, rec.Code)
		}
		assert.Equal(t, 2, querier.callCount())
	})

	t.Run("shapes the response to the contract", func(t *testing.T) {
		t.Parallel()

		querier := &mockMetricsRangeQuerier{series: []services.MetricSeries{{
			Labels: map[string]string{"pod": "api-1"},
			Points: []services.MetricPoint{
				{TimestampSeconds: 1770000000, Value: 3},
				{TimestampSeconds: 1770000060, Value: 4.5},
			},
		}}}
		h := &AdminSystemMetricsHandler{Querier: querier, Now: fixedClock(time.Unix(1770003600, 0).UTC())}

		rec := httptest.NewRecorder()
		h.Query(rec, metricsQueryRequest("/api/admin/system/metrics/query?name=sse_connections&range=1h"))

		require.Equal(t, http.StatusOK, rec.Code)

		var payload map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Equal(t, "sse_connections", payload["name"])
		assert.Equal(t, "1h", payload["range"])
		assert.InDelta(t, 60.0, payload["step_seconds"], 0)

		series, ok := payload["series"].([]any)
		require.True(t, ok)
		require.Len(t, series, 1)
		first, ok := series[0].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, map[string]any{"pod": "api-1"}, first["labels"])

		points, ok := first["points"].([]any)
		require.True(t, ok)
		require.Len(t, points, 2)
		assert.Equal(t, []any{1.77e9, 3.0}, points[0])
		assert.Equal(t, []any{1.77000006e9, 4.5}, points[1])

		// The requested window ends at the injected clock and spans the range.
		require.Len(t, querier.ends, 1)
		assert.Equal(t, time.Unix(1770003600, 0).UTC(), querier.ends[0])
		assert.Equal(t, time.Unix(1770000000, 0).UTC(), querier.starts[0])
		assert.Equal(t, 60*time.Second, querier.steps[0])
	})

	t.Run("serves a cache hit without a second upstream call", func(t *testing.T) {
		t.Parallel()

		now := time.Unix(1770003600, 0).UTC()
		querier := &mockMetricsRangeQuerier{series: []services.MetricSeries{{
			Labels: map[string]string{},
			Points: []services.MetricPoint{{TimestampSeconds: 1770000000, Value: 1}},
		}}}
		h := &AdminSystemMetricsHandler{Querier: querier, Now: func() time.Time { return now }}

		first := httptest.NewRecorder()
		h.Query(first, metricsQueryRequest("/api/admin/system/metrics/query?name=sse_connections"))
		require.Equal(t, http.StatusOK, first.Code)

		now = now.Add(9 * time.Second)
		second := httptest.NewRecorder()
		h.Query(second, metricsQueryRequest("/api/admin/system/metrics/query?name=sse_connections"))
		require.Equal(t, http.StatusOK, second.Code)

		assert.Equal(t, 1, querier.callCount(), "the second read is served from cache")
		assert.JSONEq(t, first.Body.String(), second.Body.String())

		// The cache expires after 10 seconds.
		now = now.Add(2 * time.Second)
		third := httptest.NewRecorder()
		h.Query(third, metricsQueryRequest("/api/admin/system/metrics/query?name=sse_connections"))
		require.Equal(t, http.StatusOK, third.Code)
		assert.Equal(t, 2, querier.callCount())
	})

	t.Run("caches per name and range", func(t *testing.T) {
		t.Parallel()

		querier := &mockMetricsRangeQuerier{}
		h := &AdminSystemMetricsHandler{Querier: querier, Now: fixedClock(time.Unix(1770003600, 0).UTC())}

		targets := []string{
			"/api/admin/system/metrics/query?name=sse_connections&range=1h",
			"/api/admin/system/metrics/query?name=sse_connections&range=6h",
			"/api/admin/system/metrics/query?name=runner_pool_available&range=1h",
			"/api/admin/system/metrics/query?name=sse_connections&range=1h",
		}
		for _, target := range targets {
			rec := httptest.NewRecorder()
			h.Query(rec, metricsQueryRequest(target))
			require.Equal(t, http.StatusOK, rec.Code)
		}

		assert.Equal(t, 3, querier.callCount(), "only the repeated (name, range) pair is cached")
	})
}

func TestNewAdminSystemMetricsHandler(t *testing.T) {
	t.Parallel()

	t.Run("returns nil without a project id", func(t *testing.T) {
		t.Parallel()

		assert.Nil(t, NewAdminSystemMetricsHandler("   ", &fakeMetricsDoer{}))
	})

	t.Run("wires a querier when a project id and doer are supplied", func(t *testing.T) {
		t.Parallel()

		h := NewAdminSystemMetricsHandler("plue-prod-1771780303", &fakeMetricsDoer{})
		require.NotNil(t, h)
		assert.NotNil(t, h.Querier)
	})
}

type fakeMetricsDoer struct{}

func (f *fakeMetricsDoer) Do(*http.Request) (*http.Response, error) {
	return nil, errors.New("not used")
}
