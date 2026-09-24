package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type variablesCovService struct {
	listVariablesFn     func(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error)
	getVariableFn       func(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error)
	setVariableFn       func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error)
	deleteVariableFn    func(ctx context.Context, actor *db.User, owner, repo, name string) error
	listOrgVariablesFn  func(ctx context.Context, actor *db.User, orgName string) ([]services.VariableResponse, error)
	setOrgVariableFn    func(ctx context.Context, actor *db.User, orgName, name, value string) (services.VariableResponse, error)
	deleteOrgVariableFn func(ctx context.Context, actor *db.User, orgName, name string) error
}

func (m *variablesCovService) ListVariables(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error) {
	if m.listVariablesFn != nil {
		return m.listVariablesFn(ctx, actor, owner, repo)
	}
	return nil, nil
}

func (m *variablesCovService) GetVariable(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error) {
	if m.getVariableFn != nil {
		return m.getVariableFn(ctx, actor, owner, repo, name)
	}
	return services.VariableResponse{}, nil
}

func (m *variablesCovService) SetVariable(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error) {
	if m.setVariableFn != nil {
		return m.setVariableFn(ctx, actor, owner, repo, name, value)
	}
	return services.VariableResponse{}, nil
}

func (m *variablesCovService) DeleteVariable(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if m.deleteVariableFn != nil {
		return m.deleteVariableFn(ctx, actor, owner, repo, name)
	}
	return nil
}

func (m *variablesCovService) ListOrgVariables(ctx context.Context, actor *db.User, orgName string) ([]services.VariableResponse, error) {
	if m.listOrgVariablesFn != nil {
		return m.listOrgVariablesFn(ctx, actor, orgName)
	}
	return nil, nil
}

func (m *variablesCovService) SetOrgVariable(ctx context.Context, actor *db.User, orgName, name, value string) (services.VariableResponse, error) {
	if m.setOrgVariableFn != nil {
		return m.setOrgVariableFn(ctx, actor, orgName, name, value)
	}
	return services.VariableResponse{}, nil
}

func (m *variablesCovService) DeleteOrgVariable(ctx context.Context, actor *db.User, orgName, name string) error {
	if m.deleteOrgVariableFn != nil {
		return m.deleteOrgVariableFn(ctx, actor, orgName, name)
	}
	return nil
}

func TestVariables_Cov_RepoVariableErrors(t *testing.T) {
	t.Parallel()

	t.Run("list propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{
			listVariablesFn: func(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error) {
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				return nil, pkgerrors.Forbidden("permission denied")
			},
		}}

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/variables", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler.ListVariables(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("get requires name param", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/variables/", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler.GetVariable(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "variable name is required")
	})

	t.Run("set rejects invalid json", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/variables", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.SetVariable(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("set rejects invalid variable name", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/variables", strings.NewReader(`{"name":"bad name","value":"ok"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.SetVariable(rec, req)

		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		assert.Contains(t, rec.Body.String(), "name")
	})

	t.Run("delete rejects invalid variable name", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/variables/bad%20name", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "bad name"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.DeleteVariable(rec, req)

		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})
}

func TestVariables_Cov_OrgVariableHandlers(t *testing.T) {
	t.Parallel()

	t.Run("list org variables succeeds", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{
			listOrgVariablesFn: func(ctx context.Context, actor *db.User, orgName string) ([]services.VariableResponse, error) {
				require.NotNil(t, actor)
				assert.Equal(t, int64(4), actor.ID)
				assert.Equal(t, "acme", orgName)
				return []services.VariableResponse{{Name: "REGION", Value: "us-east-1"}}, nil
			},
		}}

		req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/variables", nil)
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 4, "ada")
		rec := httptest.NewRecorder()
		handler.ListOrgVariables(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var got []services.VariableResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		require.Len(t, got, 1)
		assert.Equal(t, "REGION", got[0].Name)
	})

	t.Run("list org variables requires org", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/orgs//variables", nil)
		rec := httptest.NewRecorder()
		handler.ListOrgVariables(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "organization name is required")
	})

	t.Run("set org variable succeeds", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{
			setOrgVariableFn: func(ctx context.Context, actor *db.User, orgName, name, value string) (services.VariableResponse, error) {
				assert.Equal(t, int64(4), actor.ID)
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "REGION", name)
				assert.Equal(t, "us-east-1", value)
				return services.VariableResponse{Name: name, Value: value}, nil
			},
		}, Metrics: NewSmithersMetrics()}

		req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/variables", strings.NewReader(`{"name":"REGION","value":"us-east-1"}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 4, "ada")
		rec := httptest.NewRecorder()
		handler.SetOrgVariable(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		var got services.VariableResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		assert.Equal(t, "us-east-1", got.Value)
	})

	t.Run("set org variable propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{
			setOrgVariableFn: func(context.Context, *db.User, string, string, string) (services.VariableResponse, error) {
				return services.VariableResponse{}, pkgerrors.Forbidden("permission denied")
			},
		}, Metrics: NewSmithersMetrics()}

		req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/variables", strings.NewReader(`{"name":"REGION","value":"us-east-1"}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 4, "ada")
		rec := httptest.NewRecorder()
		handler.SetOrgVariable(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("delete org variable succeeds", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{
			deleteOrgVariableFn: func(ctx context.Context, actor *db.User, orgName, name string) error {
				assert.Equal(t, int64(4), actor.ID)
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "REGION", name)
				return nil
			},
		}, Metrics: NewSmithersMetrics()}

		req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/variables/REGION", nil)
		req = withRouteParams(req, map[string]string{"org": "acme", "name": "REGION"})
		req = withAuth(req, 4, "ada")
		rec := httptest.NewRecorder()
		handler.DeleteOrgVariable(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("delete org variable rejects invalid name", func(t *testing.T) {
		t.Parallel()
		handler := &VariableHandler{Service: &variablesCovService{}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/variables/bad%20name", nil)
		req = withRouteParams(req, map[string]string{"org": "acme", "name": "bad name"})
		req = withAuth(req, 4, "ada")
		rec := httptest.NewRecorder()
		handler.DeleteOrgVariable(rec, req)

		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})
}
