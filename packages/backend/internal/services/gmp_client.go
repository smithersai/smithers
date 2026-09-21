package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
)

const (
	// MonitoringReadScope is the OAuth scope required to read time series
	// through the Cloud Monitoring Prometheus-compatible API. The workload
	// service account also needs roles/monitoring.viewer.
	MonitoringReadScope = "https://www.googleapis.com/auth/monitoring.read"

	// gmpDefaultEndpoint is the Cloud Monitoring API host. The Prometheus read
	// API is global, so the path segment below is always location/global even
	// though the scraped cluster lives in a region.
	gmpDefaultEndpoint = "https://monitoring.googleapis.com"

	// maxGMPResponseBytes caps how much of an upstream response is read, so a
	// runaway query cannot exhaust API pod memory.
	maxGMPResponseBytes = 8 << 20

	// gmpErrorSnippetBytes caps how much upstream error text is echoed back.
	gmpErrorSnippetBytes = 256
)

// GMPDoer executes an outbound HTTP request. *http.Client satisfies it; tests
// inject a fake so no network call is made.
type GMPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// MetricPoint is a single sample, serialized as the two-element array
// [unix_seconds, value] required by the admin metrics API contract.
type MetricPoint struct {
	TimestampSeconds int64
	Value            float64
}

// MarshalJSON renders the point as [unix_seconds, value].
func (p MetricPoint) MarshalJSON() ([]byte, error) {
	value, err := json.Marshal(p.Value)
	if err != nil {
		return nil, err
	}
	return []byte("[" + strconv.FormatInt(p.TimestampSeconds, 10) + "," + string(value) + "]"), nil
}

// UnmarshalJSON accepts the Prometheus sample encoding [<ts>, "<value>"] as
// well as the [<ts>, <value>] form this type emits.
func (p *MetricPoint) UnmarshalJSON(data []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if len(raw) != 2 {
		return fmt.Errorf("metric point must have 2 elements, got %d", len(raw))
	}

	var timestamp float64
	if err := json.Unmarshal(raw[0], &timestamp); err != nil {
		return fmt.Errorf("metric point timestamp: %w", err)
	}
	p.TimestampSeconds = int64(timestamp)

	value, err := parseMetricSampleValue(raw[1])
	if err != nil {
		return err
	}
	p.Value = value
	return nil
}

// parseMetricSampleValue reads a sample value encoded either as a JSON string
// (the Prometheus wire format) or as a JSON number.
func parseMetricSampleValue(raw json.RawMessage) (float64, error) {
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		value, err := strconv.ParseFloat(asString, 64)
		if err != nil {
			return 0, fmt.Errorf("metric point value %q: %w", asString, err)
		}
		return value, nil
	}
	var asNumber float64
	if err := json.Unmarshal(raw, &asNumber); err != nil {
		return 0, fmt.Errorf("metric point value: %w", err)
	}
	return asNumber, nil
}

// MetricSeries is one labeled time series returned by a range query.
type MetricSeries struct {
	Labels map[string]string `json:"labels"`
	Points []MetricPoint     `json:"points"`
}

// GMPClient reads range queries from Google Managed Prometheus through the
// Cloud Monitoring Prometheus-compatible API. It never builds PromQL: callers
// pass a fully formed query that must originate from a server-side allowlist.
type GMPClient struct {
	projectID string
	doer      GMPDoer
	endpoint  string
}

// GMPClientOption customizes a GMPClient.
type GMPClientOption func(*GMPClient)

// WithGMPEndpoint overrides the Cloud Monitoring host (tests only).
func WithGMPEndpoint(endpoint string) GMPClientOption {
	return func(c *GMPClient) {
		endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
		if endpoint != "" {
			c.endpoint = endpoint
		}
	}
}

// NewGMPClient returns nil when the GCP project id is empty or no doer is
// wired, which callers surface as "metrics backend not configured".
func NewGMPClient(projectID string, doer GMPDoer, opts ...GMPClientOption) *GMPClient {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" || doer == nil {
		return nil
	}
	c := &GMPClient{
		projectID: projectID,
		doer:      doer,
		endpoint:  gmpDefaultEndpoint,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// NewGoogleMonitoringDoer builds an HTTP client authenticated with Application
// Default Credentials (Workload Identity on GKE). It returns an error when no
// credentials are discoverable, which callers treat as "backend unconfigured"
// rather than a fatal startup failure.
func NewGoogleMonitoringDoer(ctx context.Context, timeout time.Duration) (GMPDoer, error) {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	source, err := google.DefaultTokenSource(ctx, MonitoringReadScope)
	if err != nil {
		return nil, fmt.Errorf("google application default credentials: %w", err)
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &oauth2.Transport{
			Source: source,
			Base:   observability.NewHTTPTransport(http.DefaultTransport),
		},
	}, nil
}

// promQueryRangeResponse is the Prometheus HTTP API query_range envelope.
type promQueryRangeResponse struct {
	Status    string `json:"status"`
	ErrorType string `json:"errorType"`
	Error     string `json:"error"`
	Data      struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
			Values []MetricPoint     `json:"values"`
		} `json:"result"`
	} `json:"data"`
}

// QueryRange runs a PromQL range query and returns its matrix result. The
// query string must come from a fixed server-side template; this client does
// not validate it.
func (c *GMPClient) QueryRange(ctx context.Context, query string, start, end time.Time, step time.Duration) ([]MetricSeries, error) {
	if c == nil {
		return nil, errors.New("metrics backend not configured")
	}
	if strings.TrimSpace(query) == "" {
		return nil, errors.New("metrics query is empty")
	}
	if step <= 0 {
		return nil, errors.New("metrics query step must be positive")
	}

	endpoint := fmt.Sprintf(
		"%s/v1/projects/%s/location/global/prometheus/api/v1/query_range",
		c.endpoint,
		url.PathEscape(c.projectID),
	)
	form := url.Values{}
	form.Set("query", query)
	form.Set("start", strconv.FormatInt(start.UTC().Unix(), 10))
	form.Set("end", strconv.FormatInt(end.UTC().Unix(), 10))
	form.Set("step", strconv.FormatInt(int64(step/time.Second), 10)+"s")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build metrics query request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := c.doer.Do(req)
	if err != nil {
		return nil, fmt.Errorf("metrics backend request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGMPResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("read metrics backend response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("metrics backend returned %d: %s", resp.StatusCode, gmpErrorSnippet(body))
	}

	var parsed promQueryRangeResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode metrics backend response: %w", err)
	}
	if parsed.Status != "" && parsed.Status != "success" {
		detail := strings.TrimSpace(parsed.Error)
		if detail == "" {
			detail = parsed.ErrorType
		}
		return nil, fmt.Errorf("metrics backend query failed: %s", gmpErrorSnippet([]byte(detail)))
	}

	series := make([]MetricSeries, 0, len(parsed.Data.Result))
	for _, result := range parsed.Data.Result {
		labels := result.Metric
		if labels == nil {
			labels = map[string]string{}
		}
		points := make([]MetricPoint, 0, len(result.Values))
		for _, point := range result.Values {
			// histogram_quantile over an empty bucket set yields NaN, which is
			// not representable in JSON. Drop those samples instead of failing
			// the whole response.
			if math.IsNaN(point.Value) || math.IsInf(point.Value, 0) {
				continue
			}
			points = append(points, point)
		}
		series = append(series, MetricSeries{Labels: labels, Points: points})
	}
	return series, nil
}

// gmpErrorSnippet trims upstream error text to a single short line.
func gmpErrorSnippet(body []byte) string {
	snippet := strings.TrimSpace(string(body))
	snippet = strings.ReplaceAll(snippet, "\n", " ")
	snippet = strings.ReplaceAll(snippet, "\r", " ")
	if len(snippet) > gmpErrorSnippetBytes {
		snippet = snippet[:gmpErrorSnippetBytes] + "..."
	}
	if snippet == "" {
		return "no response body"
	}
	return snippet
}
