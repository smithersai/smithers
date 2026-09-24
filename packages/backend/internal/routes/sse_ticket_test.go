package routes_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockSSETicketService struct {
	createTicketFn func(ctx context.Context, userID int64, tokenAuth bool, rawScopes, tokenHash string) (services.SSETicketResult, error)
}

func (m *mockSSETicketService) CreateTicket(ctx context.Context, userID int64, tokenAuth bool, rawScopes, tokenHash string) (services.SSETicketResult, error) {
	if m.createTicketFn != nil {
		return m.createTicketFn(ctx, userID, tokenAuth, rawScopes, tokenHash)
	}
	return services.SSETicketResult{}, errors.Internal("not implemented")
}

func setupSSETicketRouter(handler *routes.SSETicketHandler) *chi.Mux {
	r := chi.NewRouter()
	r.Post("/api/sse/ticket", handler.PostSSETicket)
	return r
}

func TestPostSSETicket_Success(t *testing.T) {
	t.Parallel()

	svc := &mockSSETicketService{
		createTicketFn: func(_ context.Context, userID int64, _ bool, _ string, _ string) (services.SSETicketResult, error) {
			assert.Equal(t, int64(42), userID)
			return services.SSETicketResult{Ticket: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"}, nil
		},
	}
	handler := &routes.SSETicketHandler{
		Service: svc,
	}

	r := setupSSETicketRouter(handler)

	req := httptest.NewRequest("POST", "/api/sse/ticket", nil)
	// Inject authenticated user context.
	user := &db.User{ID: 42, Username: "alice"}
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        user,
		IsTokenAuth: false,
	})
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)

	var resp map[string]string
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&resp))
	assert.Equal(t, "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890", resp["ticket"])
}

func TestPostSSETicket_Unauthenticated(t *testing.T) {
	t.Parallel()

	svc := &mockSSETicketService{}
	handler := &routes.SSETicketHandler{
		Service: svc,
	}

	r := setupSSETicketRouter(handler)

	req := httptest.NewRequest("POST", "/api/sse/ticket", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	var resp errors.APIError
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&resp))
	assert.Contains(t, resp.Message, "authentication required")
}

func TestPostSSETicket_ServiceError(t *testing.T) {
	t.Parallel()

	svc := &mockSSETicketService{
		createTicketFn: func(context.Context, int64, bool, string, string) (services.SSETicketResult, error) {
			return services.SSETicketResult{}, errors.Internal("database unavailable")
		},
	}
	handler := &routes.SSETicketHandler{
		Service: svc,
	}

	r := setupSSETicketRouter(handler)

	req := httptest.NewRequest("POST", "/api/sse/ticket", nil)
	user := &db.User{ID: 42, Username: "alice"}
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        user,
		IsTokenAuth: false,
	})
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestPostSSETicket_MetricsRecorded(t *testing.T) {
	t.Parallel()

	svc := &mockSSETicketService{
		createTicketFn: func(context.Context, int64, bool, string, string) (services.SSETicketResult, error) {
			return services.SSETicketResult{Ticket: "ticket_value"}, nil
		},
	}

	counter := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "test_sse_tickets_issued_total",
	})

	handler := &routes.SSETicketHandler{
		Service: svc,
		Metrics: &routes.SSETicketRouteMetrics{
			TicketsIssued: counter,
		},
	}

	r := setupSSETicketRouter(handler)

	req := httptest.NewRequest("POST", "/api/sse/ticket", nil)
	user := &db.User{ID: 1, Username: "test"}
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        user,
		IsTokenAuth: false,
	})
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)

	var m dto.Metric
	require.NoError(t, counter.(prometheus.Metric).Write(&m))
	assert.Equal(t, float64(1), m.GetCounter().GetValue())
}

func TestPostSSETicket_ForwardsTokenScopes(t *testing.T) {
	t.Parallel()

	var gotTokenAuth bool
	var gotScopes string
	var gotTokenHash string
	svc := &mockSSETicketService{
		createTicketFn: func(_ context.Context, userID int64, tokenAuth bool, rawScopes, tokenHash string) (services.SSETicketResult, error) {
			assert.Equal(t, int64(42), userID)
			gotTokenAuth = tokenAuth
			gotScopes = rawScopes
			gotTokenHash = tokenHash
			return services.SSETicketResult{Ticket: "ticket_value"}, nil
		},
	}
	handler := &routes.SSETicketHandler{Service: svc}

	r := setupSSETicketRouter(handler)

	req := httptest.NewRequest("POST", "/api/sse/ticket", nil)
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 42, Username: "alice"},
		IsTokenAuth: true,
		RawScopes:   "read:user",
		TokenHash:   " source-token-hash ",
		Scopes:      middleware.ParseTokenScopes("read:user"),
	})
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "source-token-hash", gotTokenHash)
	assert.True(t, gotTokenAuth, "token-minted tickets must record token auth")
	assert.Equal(t, "read:user", gotScopes, "token-minted tickets must carry the token's scopes")
}
