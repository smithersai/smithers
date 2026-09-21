package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockAdminRepoService struct {
	listAllReposFn func(ctx context.Context, input services.AdminRepoListInput) ([]services.AdminRepoResponse, int64, error)
}

func (m *mockAdminRepoService) ListAllRepos(ctx context.Context, input services.AdminRepoListInput) ([]services.AdminRepoResponse, int64, error) {
	if m.listAllReposFn != nil {
		return m.listAllReposFn(ctx, input)
	}
	return []services.AdminRepoResponse{}, 0, nil
}

func makeTestAdminRepo(id int64, name string, isPublic bool) services.AdminRepoResponse {
	now := time.Now().UTC()
	return services.AdminRepoResponse{
		ID:          id,
		Name:        name,
		Description: "Test repo " + name,
		IsPublic:    isPublic,
		IsArchived:  false,
		NumStars:    0,
		NumIssues:   0,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func TestAdminRepoHandler_ListRepos(t *testing.T) {
	t.Parallel()

	t.Run("returns 200 with repos list", func(t *testing.T) {
		t.Parallel()

		h := &AdminRepoHandler{
			Service: &mockAdminRepoService{
				listAllReposFn: func(ctx context.Context, input services.AdminRepoListInput) ([]services.AdminRepoResponse, int64, error) {
					assert.Equal(t, 1, input.Page)
					assert.Equal(t, 30, input.PerPage)
					return []services.AdminRepoResponse{
						makeTestAdminRepo(1, "repo-a", true),
						makeTestAdminRepo(2, "repo-b", false),
					}, 2, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/repos", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "2", rec.Header().Get("X-Total-Count"))

		var payload []services.AdminRepoResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 2)
		assert.Equal(t, int64(1), payload[0].ID)
		assert.Equal(t, "repo-a", payload[0].Name)
		assert.True(t, payload[0].IsPublic)
		assert.False(t, payload[1].IsPublic)
	})

	t.Run("returns empty array when no repos", func(t *testing.T) {
		t.Parallel()

		h := &AdminRepoHandler{
			Service: &mockAdminRepoService{
				listAllReposFn: func(ctx context.Context, input services.AdminRepoListInput) ([]services.AdminRepoResponse, int64, error) {
					return []services.AdminRepoResponse{}, 0, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/repos", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "0", rec.Header().Get("X-Total-Count"))

		var payload []services.AdminRepoResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Empty(t, payload)
	})

	t.Run("returns 400 for invalid pagination", func(t *testing.T) {
		t.Parallel()

		h := &AdminRepoHandler{Service: &mockAdminRepoService{}}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/repos?per_page=-5", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRepos(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("paginates with page and per_page", func(t *testing.T) {
		t.Parallel()

		h := &AdminRepoHandler{
			Service: &mockAdminRepoService{
				listAllReposFn: func(ctx context.Context, input services.AdminRepoListInput) ([]services.AdminRepoResponse, int64, error) {
					assert.Equal(t, 3, input.Page)
					assert.Equal(t, 5, input.PerPage)
					return []services.AdminRepoResponse{}, 50, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/repos?page=3&per_page=5", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "50", rec.Header().Get("X-Total-Count"))
		assert.NotEmpty(t, rec.Header().Get("Link"))
	})

	t.Run("propagates service errors as 500", func(t *testing.T) {
		t.Parallel()

		h := &AdminRepoHandler{
			Service: &mockAdminRepoService{
				listAllReposFn: func(ctx context.Context, input services.AdminRepoListInput) ([]services.AdminRepoResponse, int64, error) {
					return nil, 0, pkgerrors.Internal("db failure")
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/repos", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRepos(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("response items have expected fields", func(t *testing.T) {
		t.Parallel()

		h := &AdminRepoHandler{
			Service: &mockAdminRepoService{
				listAllReposFn: func(ctx context.Context, input services.AdminRepoListInput) ([]services.AdminRepoResponse, int64, error) {
					return []services.AdminRepoResponse{makeTestAdminRepo(7, "my-repo", true)}, 1, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/repos", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)

		var payload []map[string]interface{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 1)
		repo := payload[0]
		assert.Contains(t, repo, "id")
		assert.Contains(t, repo, "name")
		assert.Contains(t, repo, "is_public")
		assert.Contains(t, repo, "is_archived")
		assert.Contains(t, repo, "created_at")
		assert.Contains(t, repo, "updated_at")
	})
}
