package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type terminalOpenRateLimitStore struct {
	mu       sync.Mutex
	buckets  map[string]float64
	keysSeen []string
}

func (s *terminalOpenRateLimitStore) ConsumeSearchRateLimitToken(_ context.Context, arg db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.buckets == nil {
		s.buckets = make(map[string]float64)
	}

	key := arg.Scope + "|" + arg.PrincipalKey
	s.keysSeen = append(s.keysSeen, key)

	remaining, ok := s.buckets[key]
	if !ok {
		remaining = arg.Capacity
	}
	allowed := remaining >= 1
	if allowed {
		remaining--
	}
	s.buckets[key] = remaining

	return db.ConsumeSearchRateLimitTokenRow{
		Allowed:         allowed,
		RemainingTokens: remaining,
		NowAt:           arg.NowAt,
	}, nil
}

func (s *terminalOpenRateLimitStore) DeleteExpiredSearchRateLimits(context.Context, time.Time) error {
	return nil
}

func TestTerminalOpenRateLimit_RejectsBeforeTerminalHandlerWork(t *testing.T) {
	t.Parallel()

	var getSessionCalls atomic.Int32
	var getSSHCalls atomic.Int32

	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
			getSessionCalls.Add(1)
			return services.WorkspaceSessionResponse{}, pkgerrors.NotFound("session not found")
		},
		getSSHConnectionFunc: func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error) {
			getSSHCalls.Add(1)
			return services.WorkspaceSSHConnectionInfo{}, pkgerrors.NotFound("vm not found")
		},
	}

	store := &terminalOpenRateLimitStore{}
	handler := &WorkspaceTerminalHandler{
		Service:        svc,
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := &db.User{ID: 1, Username: "alice"}
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "alice",
				Repository: &db.Repository{ID: 42, Name: "demo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.With(middleware.WorkspaceTerminalOpenRateLimit(store, 1)).
		Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	// First request passes the open-rate bucket and reaches handler logic.
	_, firstResp, firstErr := dialWithOrigin(
		context.Background(),
		srv.URL+"/repos/alice/demo/workspace/sessions/s1/terminal",
		"https://smithers.sh",
	)
	require.Error(t, firstErr)
	require.NotNil(t, firstResp)
	assert.Equal(t, http.StatusNotFound, firstResp.StatusCode)

	// Second request must be rejected by the route middleware before the
	// handler (and therefore before any SSH path work).
	_, secondResp, secondErr := dialWithOrigin(
		context.Background(),
		srv.URL+"/repos/alice/demo/workspace/sessions/s1/terminal",
		"https://smithers.sh",
	)
	require.Error(t, secondErr)
	require.NotNil(t, secondResp)
	assert.Equal(t, http.StatusTooManyRequests, secondResp.StatusCode)
	assert.NotEmpty(t, secondResp.Header.Get("Retry-After"))

	assert.Equal(t, int32(1), getSessionCalls.Load(), "rate limiter must block before handler on 2nd request")
	assert.Equal(t, int32(0), getSSHCalls.Load(), "no SSH lookup/dial path work expected")
	assert.Contains(t, store.keysSeen, "workspace_terminal_open|user:1")
	assert.NotContains(t, store.keysSeen, "api|user:1")
}
