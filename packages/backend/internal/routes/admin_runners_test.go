package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockAdminRunnerService struct {
	listRunnersFn func(ctx context.Context, input services.RunnerAdminListInput) ([]db.RunnerPool, int64, error)
}

func (m *mockAdminRunnerService) ListRunners(ctx context.Context, input services.RunnerAdminListInput) ([]db.RunnerPool, int64, error) {
	if m.listRunnersFn != nil {
		return m.listRunnersFn(ctx, input)
	}
	return []db.RunnerPool{}, 0, nil
}

func makeAdminUser() *db.User {
	return &db.User{ID: 99, Username: "admin-user", IsAdmin: true}
}

func makeTestRunner(id int64, name, status string) db.RunnerPool {
	now := time.Now().UTC()
	return db.RunnerPool{
		ID:              id,
		Name:            name,
		Status:          status,
		LastHeartbeatAt: pgtype.Timestamptz{Time: now, Valid: true},
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}

func withAdminContext(req *http.Request) *http.Request {
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        makeAdminUser(),
		IsTokenAuth: true,
		Scopes:      middleware.ParseTokenScopes("admin"),
	}))
}

func TestAdminRunnerHandler_ListRunners(t *testing.T) {
	t.Parallel()

	t.Run("returns 200 with runners list", func(t *testing.T) {
		t.Parallel()

		h := &AdminRunnerHandler{
			Service: &mockAdminRunnerService{
				listRunnersFn: func(ctx context.Context, input services.RunnerAdminListInput) ([]db.RunnerPool, int64, error) {
					assert.Equal(t, 1, input.Page)
					assert.Equal(t, 30, input.PerPage)
					assert.Equal(t, "", input.StatusFilter)
					return []db.RunnerPool{
						makeTestRunner(1, "runner-a", "idle"),
						makeTestRunner(2, "runner-b", "busy"),
					}, 2, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRunners(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "2", rec.Header().Get("X-Total-Count"))

		var payload []runnerResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 2)
		assert.Equal(t, int64(1), payload[0].ID)
		assert.Equal(t, "runner-a", payload[0].Name)
		assert.Equal(t, "idle", payload[0].Status)
	})

	t.Run("filters by status query param", func(t *testing.T) {
		t.Parallel()

		h := &AdminRunnerHandler{
			Service: &mockAdminRunnerService{
				listRunnersFn: func(ctx context.Context, input services.RunnerAdminListInput) ([]db.RunnerPool, int64, error) {
					assert.Equal(t, "idle", input.StatusFilter)
					return []db.RunnerPool{makeTestRunner(1, "r1", "idle")}, 1, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners?status=idle", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRunners(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "1", rec.Header().Get("X-Total-Count"))
	})

	t.Run("returns 400 for invalid status filter", func(t *testing.T) {
		t.Parallel()

		h := &AdminRunnerHandler{
			Service: &mockAdminRunnerService{
				listRunnersFn: func(ctx context.Context, input services.RunnerAdminListInput) ([]db.RunnerPool, int64, error) {
					return nil, 0, pkgerrors.BadRequest("invalid status filter: must be one of idle, busy, offline, draining, or empty for all")
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners?status=bogus", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRunners(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("returns 400 for invalid pagination", func(t *testing.T) {
		t.Parallel()

		h := &AdminRunnerHandler{Service: &mockAdminRunnerService{}}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners?page=abc", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRunners(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("returns empty array when no runners", func(t *testing.T) {
		t.Parallel()

		h := &AdminRunnerHandler{
			Service: &mockAdminRunnerService{
				listRunnersFn: func(ctx context.Context, input services.RunnerAdminListInput) ([]db.RunnerPool, int64, error) {
					return []db.RunnerPool{}, 0, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRunners(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "0", rec.Header().Get("X-Total-Count"))

		var payload []runnerResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Empty(t, payload)
	})

	t.Run("paginates with page and per_page", func(t *testing.T) {
		t.Parallel()

		h := &AdminRunnerHandler{
			Service: &mockAdminRunnerService{
				listRunnersFn: func(ctx context.Context, input services.RunnerAdminListInput) ([]db.RunnerPool, int64, error) {
					assert.Equal(t, 2, input.Page)
					assert.Equal(t, 5, input.PerPage)
					return []db.RunnerPool{}, 12, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners?page=2&per_page=5", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRunners(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "12", rec.Header().Get("X-Total-Count"))
		assert.NotEmpty(t, rec.Header().Get("Link"))
	})

	t.Run("response shape has expected fields", func(t *testing.T) {
		t.Parallel()

		h := &AdminRunnerHandler{
			Service: &mockAdminRunnerService{
				listRunnersFn: func(ctx context.Context, input services.RunnerAdminListInput) ([]db.RunnerPool, int64, error) {
					return []db.RunnerPool{makeTestRunner(7, "runner-x", "draining")}, 1, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRunners(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)

		var payload []map[string]interface{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 1)
		r := payload[0]
		assert.Contains(t, r, "id")
		assert.Contains(t, r, "name")
		assert.Contains(t, r, "status")
		assert.Contains(t, r, "last_heartbeat_at")
		assert.Contains(t, r, "created_at")
		assert.Contains(t, r, "updated_at")
	})
}
