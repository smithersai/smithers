package compose

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// protectedMetricsHandler serves the product registry behind the shared
// SMITHERS_METRICS_TOKEN bearer token. It fails closed (401) when the token is
// unset. The router and the worker metrics listener use the same guard.
func protectedMetricsHandler(metrics *routes.SmithersMetrics) http.Handler {
	token := strings.TrimSpace(os.Getenv("SMITHERS_METRICS_TOKEN"))
	return middleware.RequireSharedBearerToken(token)(metrics.Handler())
}

// workerMetricsServer exports the product registry from a workers-only
// process. Such a process mounts no product router, so without it every
// worker-emitted series (landing, webhook delivery, cleanup sweeps, and
// deployment collectors) would be invisible to the scraper.
type workerMetricsServer struct {
	server *http.Server
	failed chan error
}

// startWorkerMetricsServer binds addr before workers start, so an unusable
// address fails startup instead of silently dropping worker metrics.
func startWorkerMetricsServer(addr string, metrics *routes.SmithersMetrics) (*workerMetricsServer, error) {
	listener, err := netListen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen for worker metrics on %s: %w", addr, err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", protectedMetricsHandler(metrics))
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	served := &workerMetricsServer{server: server, failed: make(chan error, 1)}
	slog.Info("worker metrics listening", "addr", listener.Addr().String())
	go func() {
		if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
			served.failed <- fmt.Errorf("worker metrics listener failed: %w", err)
		}
	}()
	return served, nil
}

// Failed reports a listener failure after startup. A nil server never fails.
func (s *workerMetricsServer) Failed() <-chan error {
	if s == nil {
		return nil
	}
	return s.failed
}

// Close stops the listener immediately; it is a no-op after Shutdown.
func (s *workerMetricsServer) Close() {
	if s != nil {
		_ = s.server.Close()
	}
}

func (s *workerMetricsServer) Shutdown(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if err := s.server.Shutdown(ctx); err != nil {
		return errors.Join(fmt.Errorf("worker metrics listener did not drain: %w", err), s.server.Close())
	}
	return nil
}
