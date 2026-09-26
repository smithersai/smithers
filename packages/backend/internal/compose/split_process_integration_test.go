package compose

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/testutil/postgresfixture"
)

// splitProcessEnvironment configures a single-owner product whose repository
// engine runs in a separate repo-host service, as in Plue's compose stack.
func splitProcessEnvironment(t *testing.T) (repositoryURL string, repositoryHealthChecks *atomic.Int32) {
	t.Helper()
	raw := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_PRODUCT_TEST_DATABASE_URL is required")
		}
		t.Skip("set SMITHERS_PRODUCT_TEST_DATABASE_URL for PostgreSQL integration test")
	}
	_, databaseURL := postgresfixture.NewProductDatabase(t, raw)
	var checks atomic.Int32
	repoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			checks.Add(1)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(repoHost.Close)
	for name, value := range map[string]string{
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_AUTH_BOOTSTRAP_TOKEN":          "split-process-bootstrap",
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_PUBLIC_URL":                    "http://127.0.0.1:4000",
		"SMITHERS_SERVER_ADDR":                   "127.0.0.1:0",
		"SMITHERS_SERVER_SHUTDOWN_TIMEOUT":       "10s",
		"SMITHERS_REPO_HOST_URL":                 repoHost.URL,
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "split-process-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "split-process-callback",
		"SMITHERS_AUTH_SESSION_SECRET":           "split-process-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "split-process-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "split-process-webhook-key",
		"SMITHERS_BLOB_DATA_DIR":                 t.TempDir(),
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
		"SMITHERS_FEATURE_FLAGS_WORKSPACES":      "false",
		"SMITHERS_OTEL_EXPORTER":                 "none",
		"SMITHERS_METRICS_TOKEN":                 "split-process-metrics",
		"SMITHERS_METRICS_ADDR":                  "",
	} {
		t.Setenv(name, value)
	}
	return repoHost.URL, &checks
}

// startSplitProcess starts one composition and stops it at test cleanup.
func startSplitProcess(t *testing.T, options Options) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan http.Handler, 1)
	finished := make(chan struct{})
	var runErr error
	go func() {
		runErr = StartWithOptions(ctx, nil, io.Discard, io.Discard, options, func(handler http.Handler) { ready <- handler })
		close(finished)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
			require.NoError(t, runErr)
		case <-time.After(30 * time.Second):
			t.Error("composition did not stop")
		}
	})
	select {
	case handler := <-ready:
		return handler
	case <-finished:
		t.Fatalf("composition stopped before ready: %v", runErr)
	case <-time.After(60 * time.Second):
		t.Fatal("composition did not become ready")
	}
	return nil
}

// A remote repository client is probed at repo_host.url whatever the identity
// mode; only an in-process engine uses the embedded health route.
func TestSingleOwnerReadinessProbesRemoteRepositoryHost(t *testing.T) {
	repositoryURL, checks := splitProcessEnvironment(t)
	remote := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryURL}, "split-process-repo")
	handler := startSplitProcess(t, Options{Repository: remote})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, "ready", body.Status)
	require.Equal(t, "ok", body.Checks["repo_host"])
	require.Positive(t, checks.Load(), "readiness must reach the configured repo-host")
}

// A workers-only process mounts no product router, so it exports the product
// registry, including deployment collectors, on its own guarded listener.
func TestWorkersOnlyProcessExportsProductAndDeploymentMetrics(t *testing.T) {
	repositoryURL, _ := splitProcessEnvironment(t)
	t.Setenv("SMITHERS_METRICS_ADDR", "127.0.0.1:0")
	listeners := make(chan net.Listener, 1)
	original := netListen
	netListen = func(network, address string) (net.Listener, error) {
		listener, err := original(network, address)
		if err == nil {
			listeners <- listener
		}
		return listener, err
	}
	t.Cleanup(func() { netListen = original })

	private := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "deployment_private_sweeps_total", Help: "Deployment-owned test collector.",
	})
	private.Inc()
	remote := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryURL}, "split-process-repo")
	handler := startSplitProcess(t, Options{Duties: DutiesWorkers, Repository: remote, MetricsCollectors: []prometheus.Collector{private}})
	require.Nil(t, handler, "a workers-only process has no product handler")

	var address string
	select {
	case listener := <-listeners:
		address = listener.Addr().String()
	default:
		t.Fatal("workers-only process did not open its metrics listener")
	}
	scrape := func(token string) (int, string) {
		request, err := http.NewRequest(http.MethodGet, "http://"+address+"/metrics", nil)
		require.NoError(t, err)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, string(body)
	}
	status, _ := scrape("")
	require.Equal(t, http.StatusUnauthorized, status)
	status, _ = scrape("wrong")
	require.Equal(t, http.StatusUnauthorized, status)
	status, body := scrape("split-process-metrics")
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, body, "deployment_private_sweeps_total 1")
	require.True(t, strings.Contains(body, "smithers_db_connections_max"), "product metrics missing:\n%s", body)
}

func TestMetricsListenerRequiresWorkersOnlyDuties(t *testing.T) {
	for _, duties := range []Duties{DutiesAll, DutiesHTTP} {
		t.Run(string(duties), func(t *testing.T) {
			t.Setenv("SMITHERS_AUTH_MODE", "selfhost")
			t.Setenv("SMITHERS_METRICS_ADDR", "127.0.0.1:0")
			err := RunWithOptions(context.Background(), nil, io.Discard, io.Discard, Options{Duties: duties})
			require.ErrorContains(t, err, "observability.metrics_addr applies only to worker duties")
		})
	}
}

func TestDeploymentCollectorConflictFailsStartup(t *testing.T) {
	splitProcessEnvironment(t)
	duplicate := prometheus.NewGauge(prometheus.GaugeOpts{Name: "smithers_db_connections_max", Help: "conflict"})
	err := RunWithOptions(context.Background(), nil, io.Discard, io.Discard, Options{MetricsCollectors: []prometheus.Collector{duplicate}})
	require.ErrorContains(t, err, "register deployment metrics")
}
