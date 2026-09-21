package routes

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	// metricsQueryUpstreamTimeout bounds one Managed Prometheus round trip.
	metricsQueryUpstreamTimeout = 15 * time.Second

	// metricsQueryCacheTTL keeps a successful response reusable for a short
	// window so an admin dashboard polling several panels does not fan out one
	// upstream query per panel per refresh.
	metricsQueryCacheTTL = 10 * time.Second

	// metricsQueryDefaultRange is used when the request omits ?range=.
	metricsQueryDefaultRange = "1h"

	// metricsNamespaceMatcher scopes every query to the API's Kubernetes
	// namespace, matching the alert policies in infra/terraform/modules/monitoring.
	metricsNamespaceMatcher = `namespace="smithers"`
)

// MetricsRangeQuerier runs one PromQL range query against the metrics backend.
// Implemented by *services.GMPClient.
type MetricsRangeQuerier interface {
	QueryRange(ctx context.Context, query string, start, end time.Time, step time.Duration) ([]services.MetricSeries, error)
}

// metricsRangeSpec is the fixed window, step, and rate window for one accepted
// ?range= value. Nothing here is derived from client input beyond selecting a
// row by exact key match.
type metricsRangeSpec struct {
	window     time.Duration
	step       time.Duration
	rateWindow string
}

// metricsRangeSpecs is the accepted ?range= allowlist.
var metricsRangeSpecs = map[string]metricsRangeSpec{
	"1h":  {window: time.Hour, step: 60 * time.Second, rateWindow: "5m"},
	"6h":  {window: 6 * time.Hour, step: 300 * time.Second, rateWindow: "10m"},
	"24h": {window: 24 * time.Hour, step: 900 * time.Second, rateWindow: "30m"},
}

// metricsQueryAllowlist maps an accepted ?name= value to a PromQL builder. The
// only variable a builder ever interpolates is the rate window from
// metricsRangeSpecs, so no client-supplied text can reach PromQL.
var metricsQueryAllowlist = map[string]func(rateWindow string) string{
	"http_request_rate": func(rateWindow string) string {
		return `sum(rate(smithers_http_requests_total{` + metricsNamespaceMatcher + `}[` + rateWindow + `]))`
	},
	// Percentage of 5xx responses, matching the HighErrorRate alert policy. A
	// zero denominator (no traffic at all) yields no samples rather than a
	// rescaled percentage, so the chart honestly shows "no data" instead of
	// understating an outage during a quiet window.
	"http_error_rate": func(rateWindow string) string {
		return `(sum(rate(smithers_http_requests_total{` + metricsNamespaceMatcher + `,status=~"5.."}[` + rateWindow + `]))` +
			` / sum(rate(smithers_http_requests_total{` + metricsNamespaceMatcher + `}[` + rateWindow + `]))) * 100`
	},
	// Seconds, not milliseconds: the histogram records seconds.
	"http_p95_latency": func(rateWindow string) string {
		return `histogram_quantile(0.95, sum(rate(smithers_http_request_duration_seconds_bucket{` +
			metricsNamespaceMatcher + `}[` + rateWindow + `])) by (le))`
	},
	"workflow_queue_depth": func(string) string {
		return `max(smithers_workflow_task_queue_depth{` + metricsNamespaceMatcher + `})`
	},
	"runner_pool_available": func(string) string {
		return `max(smithers_runner_pool_available{` + metricsNamespaceMatcher + `})`
	},
	"sse_connections": func(string) string {
		return `sum(smithers_sse_active_connections{` + metricsNamespaceMatcher + `})`
	},
	"sandbox_active_vms": func(string) string {
		return `sum(max by (kind) (smithers_sandbox_active_vms_db{` + metricsNamespaceMatcher + `}))`
	},
	"queue_depth": func(string) string {
		return `max by (queue) (smithers_queue_depth{` + metricsNamespaceMatcher + `})`
	},
}

// metricsQueryResponse is the GET /api/admin/system/metrics/query body.
type metricsQueryResponse struct {
	Name        string                  `json:"name"`
	Range       string                  `json:"range"`
	StepSeconds int                     `json:"step_seconds"`
	Series      []services.MetricSeries `json:"series"`
}

// metricsQueryError carries the endpoint's error body. "error" is the key the
// admin UI reads; "message" mirrors it so clients that branch on the standard
// pkg/errors shape keep working.
type metricsQueryError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// cachedMetricsQuery is one memoized successful response.
type cachedMetricsQuery struct {
	response  metricsQueryResponse
	expiresAt time.Time
}

// AdminSystemMetricsHandler handles GET /api/admin/system/metrics/query. It
// proxies a fixed set of named queries to Google Managed Prometheus; it never
// accepts PromQL from the client.
type AdminSystemMetricsHandler struct {
	// Querier is the metrics backend. Nil means "not configured": the endpoint
	// answers 501 instead of 404 so the admin UI can tell a disabled backend
	// from a missing route.
	Querier MetricsRangeQuerier
	// Now overrides the clock (tests only). Nil uses time.Now.
	Now func() time.Time

	mu    sync.Mutex
	cache map[string]cachedMetricsQuery
}

// NewAdminSystemMetricsHandler returns nil when no GCP project is configured,
// mirroring NewAlertWebhookHandler. A nil handler still serves the route: its
// Query method answers 501, so callers should register the route
// unconditionally rather than skipping it on nil.
//
// Pass a nil doer to authenticate with Application Default Credentials
// (Workload Identity on GKE); the workload service account needs
// roles/monitoring.viewer.
func NewAdminSystemMetricsHandler(projectID string, doer services.GMPDoer) *AdminSystemMetricsHandler {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return nil
	}
	if doer == nil {
		built, err := services.NewGoogleMonitoringDoer(context.Background(), metricsQueryUpstreamTimeout)
		if err != nil {
			slog.Warn("admin metrics query endpoint disabled: no google credentials", "error", err)
			return nil
		}
		doer = built
	}
	client := services.NewGMPClient(projectID, doer)
	if client == nil {
		return nil
	}
	return &AdminSystemMetricsHandler{Querier: client}
}

// Query handles GET /api/admin/system/metrics/query.
func (h *AdminSystemMetricsHandler) Query(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Querier == nil {
		writeMetricsQueryError(w, http.StatusNotImplemented, "metrics backend not configured")
		return
	}

	name := strings.TrimSpace(r.URL.Query().Get("name"))
	build, ok := metricsQueryAllowlist[name]
	if !ok {
		writeMetricsQueryError(w, http.StatusBadRequest,
			"unknown metric name (allowed: "+strings.Join(allowedMetricNames(), ", ")+")")
		return
	}

	rangeKey := strings.TrimSpace(r.URL.Query().Get("range"))
	if rangeKey == "" {
		rangeKey = metricsQueryDefaultRange
	}
	spec, ok := metricsRangeSpecs[rangeKey]
	if !ok {
		writeMetricsQueryError(w, http.StatusBadRequest,
			"unsupported range (allowed: "+strings.Join(allowedMetricRanges(), ", ")+")")
		return
	}

	now := h.now()
	cacheKey := name + "|" + rangeKey
	if cached, hit := h.cached(cacheKey, now); hit {
		pkgerrors.WriteJSON(w, http.StatusOK, cached)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), metricsQueryUpstreamTimeout)
	defer cancel()

	end := now.UTC()
	series, err := h.Querier.QueryRange(ctx, build(spec.rateWindow), end.Add(-spec.window), end, spec.step)
	if err != nil {
		// The upstream error can carry the GCP project id, IAM detail, or the
		// monitoring API URL; log it and keep the response generic like every
		// other 5xx this API returns.
		slog.Warn("admin metrics query failed", "name", name, "range", rangeKey, "error", err)
		writeMetricsQueryError(w, http.StatusBadGateway, "metrics backend query failed")
		return
	}
	if series == nil {
		series = []services.MetricSeries{}
	}

	resp := metricsQueryResponse{
		Name:        name,
		Range:       rangeKey,
		StepSeconds: int(spec.step / time.Second),
		Series:      series,
	}
	h.store(cacheKey, resp, now.Add(metricsQueryCacheTTL))
	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// now reads the injected clock, defaulting to time.Now.
func (h *AdminSystemMetricsHandler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

// cached returns a memoized response that has not yet expired.
func (h *AdminSystemMetricsHandler) cached(key string, now time.Time) (metricsQueryResponse, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry, ok := h.cache[key]
	if !ok {
		return metricsQueryResponse{}, false
	}
	if !now.Before(entry.expiresAt) {
		delete(h.cache, key)
		return metricsQueryResponse{}, false
	}
	return entry.response, true
}

// store memoizes a successful response until expiresAt.
func (h *AdminSystemMetricsHandler) store(key string, resp metricsQueryResponse, expiresAt time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cache == nil {
		h.cache = make(map[string]cachedMetricsQuery, len(metricsQueryAllowlist))
	}
	h.cache[key] = cachedMetricsQuery{response: resp, expiresAt: expiresAt}
}

// allowedMetricNames lists the accepted ?name= values in stable order.
func allowedMetricNames() []string {
	names := make([]string, 0, len(metricsQueryAllowlist))
	for name := range metricsQueryAllowlist {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// allowedMetricRanges lists the accepted ?range= values in stable order.
func allowedMetricRanges() []string {
	ranges := make([]string, 0, len(metricsRangeSpecs))
	for key := range metricsRangeSpecs {
		ranges = append(ranges, key)
	}
	sort.Strings(ranges)
	return ranges
}

// writeMetricsQueryError writes the endpoint's error body.
func writeMetricsQueryError(w http.ResponseWriter, status int, message string) {
	pkgerrors.WriteJSON(w, status, metricsQueryError{Error: message, Message: message})
}
