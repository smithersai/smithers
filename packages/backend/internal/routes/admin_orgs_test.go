package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockAdminOrgService struct {
	listAllOrgsFn func(ctx context.Context, input services.AdminOrgListInput) ([]services.OrgResponse, int64, error)
}

func (m *mockAdminOrgService) ListAllOrgs(ctx context.Context, input services.AdminOrgListInput) ([]services.OrgResponse, int64, error) {
	if m.listAllOrgsFn != nil {
		return m.listAllOrgsFn(ctx, input)
	}
	return []services.OrgResponse{}, 0, nil
}

func makeTestOrg(id int64, name string) services.OrgResponse {
	return services.OrgResponse{
		ID:          id,
		Name:        name,
		Description: "Test org " + name,
		Visibility:  "public",
	}
}

func TestAdminOrgHandler_ListOrgs(t *testing.T) {
	t.Parallel()

	t.Run("returns 200 with orgs list", func(t *testing.T) {
		t.Parallel()

		h := &AdminOrgHandler{
			Service: &mockAdminOrgService{
				listAllOrgsFn: func(ctx context.Context, input services.AdminOrgListInput) ([]services.OrgResponse, int64, error) {
					assert.Equal(t, 1, input.Page)
					assert.Equal(t, 30, input.PerPage)
					return []services.OrgResponse{
						makeTestOrg(1, "alpha"),
						makeTestOrg(2, "beta"),
					}, 2, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/orgs", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListOrgs(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "2", rec.Header().Get("X-Total-Count"))

		var payload []services.OrgResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 2)
		assert.Equal(t, int64(1), payload[0].ID)
		assert.Equal(t, "alpha", payload[0].Name)
	})

	t.Run("returns empty array when no orgs", func(t *testing.T) {
		t.Parallel()

		h := &AdminOrgHandler{
			Service: &mockAdminOrgService{
				listAllOrgsFn: func(ctx context.Context, input services.AdminOrgListInput) ([]services.OrgResponse, int64, error) {
					return []services.OrgResponse{}, 0, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/orgs", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListOrgs(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "0", rec.Header().Get("X-Total-Count"))

		var payload []services.OrgResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Empty(t, payload)
	})

	t.Run("returns 400 for invalid pagination", func(t *testing.T) {
		t.Parallel()

		h := &AdminOrgHandler{Service: &mockAdminOrgService{}}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/orgs?page=abc", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListOrgs(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("paginates with page and per_page", func(t *testing.T) {
		t.Parallel()

		h := &AdminOrgHandler{
			Service: &mockAdminOrgService{
				listAllOrgsFn: func(ctx context.Context, input services.AdminOrgListInput) ([]services.OrgResponse, int64, error) {
					assert.Equal(t, 2, input.Page)
					assert.Equal(t, 10, input.PerPage)
					return []services.OrgResponse{}, 25, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/orgs?page=2&per_page=10", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListOrgs(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "25", rec.Header().Get("X-Total-Count"))
		assert.NotEmpty(t, rec.Header().Get("Link"))
	})

	t.Run("propagates service errors as 500", func(t *testing.T) {
		t.Parallel()

		h := &AdminOrgHandler{
			Service: &mockAdminOrgService{
				listAllOrgsFn: func(ctx context.Context, input services.AdminOrgListInput) ([]services.OrgResponse, int64, error) {
					return nil, 0, pkgerrors.Internal("db failure")
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/orgs", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListOrgs(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("response items have expected fields", func(t *testing.T) {
		t.Parallel()

		h := &AdminOrgHandler{
			Service: &mockAdminOrgService{
				listAllOrgsFn: func(ctx context.Context, input services.AdminOrgListInput) ([]services.OrgResponse, int64, error) {
					return []services.OrgResponse{makeTestOrg(42, "gamma")}, 1, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/orgs", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.ListOrgs(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)

		var payload []map[string]interface{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload, 1)
		org := payload[0]
		assert.Contains(t, org, "id")
		assert.Contains(t, org, "name")
		assert.Contains(t, org, "description")
		assert.Contains(t, org, "visibility")
	})
}
