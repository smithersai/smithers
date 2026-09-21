// Ticket 0132: active-connection cap enforced BEFORE dialSSH /
// GetSSHConnectionInfo. This test confirms that rejected clients do
// not consume sandbox SSH capacity.
package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func newTerminalTestMetrics() (*prometheus.CounterVec, *prometheus.GaugeVec) {
	reg := prometheus.NewRegistry()
	rej := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "rej", Help: "h"}, []string{"scope"})
	g := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "g", Help: "h"}, []string{"user_id"})
	reg.MustRegister(rej, g)
	return rej, g
}

func TestTerminalActiveCap_RejectsOverMaxBeforeSSH(t *testing.T) {
	// Verifies active-cap check fires BEFORE GetSSHConnectionInfo. If the
	// check fired after, the spy below would be invoked and the test
	// would fail. Protects the SSH-dial path from abusive clients.
	var sshDialAttempts atomic.Int32
	svc := &mockWorkspaceTerminalService{
		// GetSession must succeed so execution reaches the active-cap
		// check immediately after it. The cap is the gate that
		// protects the SUBSEQUENT GetSSHConnectionInfo call, which
		// performs the actual sandbox-expensive work.
		getSessionFunc: func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{Status: "running", Cols: 80, Rows: 24}, nil
		},
		getSSHConnectionFunc: func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error) {
			sshDialAttempts.Add(1)
			return services.WorkspaceSSHConnectionInfo{}, pkgerrors.NotFound("vm down")
		},
	}

	rej, gauge := newTerminalTestMetrics()
	ac := middleware.NewActiveCounter("workspace_terminal_active", 2, &middleware.ActiveCounterMetrics{
		Rejections: rej,
		Gauge:      gauge,
	})
	// Pre-saturate the counter for the test user.
	require.True(t, ac.Acquire(1))
	require.True(t, ac.Acquire(1))

	handler := &WorkspaceTerminalHandler{
		Service:           svc,
		AllowedOrigins:    []string{"https://smithers.sh"},
		ActiveConnections: ac,
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	_, resp, err := dialWithOrigin(context.Background(),
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err) // 429 is not a valid WebSocket upgrade response.
	require.NotNil(t, resp)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.Equal(t, "1", resp.Header.Get("Retry-After"))
	assert.Equal(t, "2", resp.Header.Get("X-RateLimit-Limit"))
	assert.Equal(t, "0", resp.Header.Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, resp.Header.Get("X-RateLimit-Reset"))
	var payload map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&payload))
	assert.Equal(t, "rate_limit_exceeded", payload["code"])
	assert.Equal(t, float64(2), payload["limit"])
	assert.Equal(t, float64(0), payload["remaining"])
	assert.Equal(t, int32(0), sshDialAttempts.Load(), "GetSSHConnectionInfo must NOT be called when cap is exceeded")

	// Rejection metric recorded.
	assert.Equal(t, float64(1), testutil.ToFloat64(rej.WithLabelValues("workspace_terminal_active")))
}

func TestTerminalActiveCap_ReleasesSlotOnFailure(t *testing.T) {
	// Verifies the defer-release path: when GetSSHConnectionInfo fails,
	// the active slot is released so a retry can succeed.
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{Status: "running", Cols: 80, Rows: 24}, nil
		},
		getSSHConnectionFunc: func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{}, pkgerrors.NotFound("vm missing")
		},
	}

	rej, gauge := newTerminalTestMetrics()
	ac := middleware.NewActiveCounter("workspace_terminal_active", 1, &middleware.ActiveCounterMetrics{
		Rejections: rej, Gauge: gauge,
	})

	handler := &WorkspaceTerminalHandler{
		Service:           svc,
		AllowedOrigins:    []string{"https://smithers.sh"},
		ActiveConnections: ac,
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 9}})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "o",
				Repository: &db.Repository{ID: 1, Name: "r"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	// Two sequential dials on cap=1. Both must fail inside GetSSHConnectionInfo
	// with 404 (not 429), proving the slot was released between attempts.
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, resp, err := dialWithOrigin(context.Background(),
				srv.URL+"/repos/o/r/workspace/sessions/s/terminal",
				"https://smithers.sh",
			)
			require.Error(t, err)
			require.NotNil(t, resp)
			// NotFound bubbled up from the service, not a 429.
			assert.Equal(t, http.StatusNotFound, resp.StatusCode)
		}()
		wg.Wait() // sequential: wait for the first before dialing the second.
	}
	// After both attempts, counter must be back at zero.
	assert.Equal(t, 0, ac.Count(9))
}

func TestTerminalActiveCap_NilCounterIsPermissive(t *testing.T) {
	// A handler with no ActiveConnections counter must behave as before.
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{}, pkgerrors.NotFound("x")
		},
	}
	handler := &WorkspaceTerminalHandler{
		Service:           svc,
		AllowedOrigins:    []string{"https://smithers.sh"},
		ActiveConnections: nil,
	}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 1}})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner: "o", Repository: &db.Repository{ID: 1, Name: "r"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)
	srv := httptest.NewServer(r)
	defer srv.Close()

	_, resp, err := dialWithOrigin(context.Background(),
		srv.URL+"/repos/o/r/workspace/sessions/s/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	// Without a cap, the service NotFound propagates as 404.
	assert.NotEqual(t, http.StatusTooManyRequests, resp.StatusCode)
	// Reference the websocket package so the linter doesn't complain if we
	// simplify imports later.
	_ = websocket.StatusNormalClosure
}
