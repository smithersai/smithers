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
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockVariableRouteService struct {
	setVariableFn    func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error)
	getVariableFn    func(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error)
	listVariablesFn  func(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error)
	deleteVariableFn func(ctx context.Context, actor *db.User, owner, repo, name string) error
}

func (m *mockVariableRouteService) SetVariable(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error) {
	if m.setVariableFn != nil {
		return m.setVariableFn(ctx, actor, owner, repo, name, value)
	}
	return services.VariableResponse{}, nil
}

func (m *mockVariableRouteService) GetVariable(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error) {
	if m.getVariableFn != nil {
		return m.getVariableFn(ctx, actor, owner, repo, name)
	}
	return services.VariableResponse{}, nil
}

func (m *mockVariableRouteService) ListVariables(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error) {
	if m.listVariablesFn != nil {
		return m.listVariablesFn(ctx, actor, owner, repo)
	}
	return nil, nil
}

func (m *mockVariableRouteService) DeleteVariable(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if m.deleteVariableFn != nil {
		return m.deleteVariableFn(ctx, actor, owner, repo, name)
	}
	return nil
}

func (m *mockVariableRouteService) SetOrgVariable(ctx context.Context, actor *db.User, orgName, name, value string) (services.VariableResponse, error) {
	return services.VariableResponse{Name: name, Value: value}, nil
}

func (m *mockVariableRouteService) ListOrgVariables(ctx context.Context, actor *db.User, orgName string) ([]services.VariableResponse, error) {
	return nil, nil
}

func (m *mockVariableRouteService) DeleteOrgVariable(ctx context.Context, actor *db.User, orgName, name string) error {
	return nil
}

func TestVariableHandler_ListVariables(t *testing.T) {
	t.Parallel()

	h := &VariableHandler{Service: &mockVariableRouteService{
		listVariablesFn: func(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return []services.VariableResponse{
				{Name: "ENV", Value: "production", CreatedAt: "2025-01-01T00:00:00Z", UpdatedAt: "2025-01-01T00:00:00Z"},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/variables", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.ListVariables(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var variables []services.VariableResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &variables))
	assert.Len(t, variables, 1)
	assert.Equal(t, "ENV", variables[0].Name)
}

func TestVariableHandler_GetVariable(t *testing.T) {
	t.Parallel()

	h := &VariableHandler{Service: &mockVariableRouteService{
		getVariableFn: func(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error) {
			assert.Equal(t, "CI_MODE", name)
			return services.VariableResponse{Name: "CI_MODE", Value: "true", CreatedAt: "2025-01-01T00:00:00Z", UpdatedAt: "2025-01-01T00:00:00Z"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/variables/CI_MODE", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "CI_MODE"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.GetVariable(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var v services.VariableResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &v))
	assert.Equal(t, "CI_MODE", v.Name)
}

func TestVariableHandler_SetVariable_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &VariableHandler{Service: &mockVariableRouteService{}}
	req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/variables", strings.NewReader(`{"name":"K","value":"V"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	h.SetVariable(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestVariableHandler_SetVariable_Success(t *testing.T) {
	t.Parallel()

	h := &VariableHandler{Service: &mockVariableRouteService{
		setVariableFn: func(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error) {
			assert.Equal(t, int64(1), actor.ID)
			assert.Equal(t, "NODE_ENV", name)
			assert.Equal(t, "production", value)
			return services.VariableResponse{Name: "NODE_ENV", Value: "production", CreatedAt: "2025-01-01T00:00:00Z", UpdatedAt: "2025-01-01T00:00:00Z"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/variables", strings.NewReader(`{"name":"NODE_ENV","value":"production"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.SetVariable(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
}

func TestVariableHandler_DeleteVariable_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &VariableHandler{Service: &mockVariableRouteService{}}
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/variables/KEY", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "KEY"})
	rec := httptest.NewRecorder()
	h.DeleteVariable(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestVariableHandler_DeleteVariable_Success(t *testing.T) {
	t.Parallel()

	h := &VariableHandler{Service: &mockVariableRouteService{
		deleteVariableFn: func(ctx context.Context, actor *db.User, owner, repo, name string) error {
			assert.Equal(t, "NODE_ENV", name)
			return nil
		},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/variables/NODE_ENV", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "NODE_ENV"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.DeleteVariable(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestVariableHandler_DeleteVariable_ServiceError(t *testing.T) {
	t.Parallel()

	h := &VariableHandler{Service: &mockVariableRouteService{
		deleteVariableFn: func(ctx context.Context, actor *db.User, owner, repo, name string) error {
			return pkgerrors.Forbidden("permission denied")
		},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/variables/KEY", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "KEY"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.DeleteVariable(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}
