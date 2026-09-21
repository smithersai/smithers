package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestVariables_Z_RepoEarlyReturnsAndServiceErrors(t *testing.T) {
	handler := VariableHandler{Service: &variablesCovService{}, Metrics: NewSmithersMetrics()}

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		body   string
		auth   bool
		params map[string]string
		want   int
	}{
		{"list missing owner", handler.ListVariables, "", false, nil, http.StatusBadRequest},
		{"get missing owner", handler.GetVariable, "", false, nil, http.StatusBadRequest},
		{"set missing owner", handler.SetVariable, `{"name":"REGION","value":"us"}`, true, nil, http.StatusBadRequest},
		{"delete requires auth", handler.DeleteVariable, "", false, map[string]string{"owner": "alice", "repo": "demo", "name": "REGION"}, http.StatusUnauthorized},
		{"delete missing owner", handler.DeleteVariable, "", true, nil, http.StatusBadRequest},
		{"delete missing name", handler.DeleteVariable, "", true, map[string]string{"owner": "alice", "repo": "demo"}, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/variables", strings.NewReader(tc.body))
			if tc.params != nil {
				req = withRouteParams(req, tc.params)
			}
			if tc.auth {
				req = withAuth(req, 1, "alice")
			}
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, tc.want, rec.Code)
		})
	}

	serviceErrHandler := VariableHandler{Service: &variablesCovService{
		getVariableFn: func(context.Context, *db.User, string, string, string) (services.VariableResponse, error) {
			return services.VariableResponse{}, pkgerrors.NotFound("variable not found")
		},
		setVariableFn: func(context.Context, *db.User, string, string, string, string) (services.VariableResponse, error) {
			return services.VariableResponse{}, pkgerrors.Forbidden("blocked")
		},
	}, Metrics: NewSmithersMetrics()}

	req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/variables/REGION", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "REGION"})
	rec := httptest.NewRecorder()
	serviceErrHandler.GetVariable(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)

	req = httptest.NewRequest(http.MethodPut, "/repos/alice/demo/variables", strings.NewReader(`{"name":"REGION","value":"us"}`))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec = httptest.NewRecorder()
	serviceErrHandler.SetVariable(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestVariables_Z_OrgEarlyReturnsAndServiceErrors(t *testing.T) {
	handler := VariableHandler{Service: &variablesCovService{}, Metrics: NewSmithersMetrics()}

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		body   string
		auth   bool
		params map[string]string
		want   int
	}{
		{"set requires auth", handler.SetOrgVariable, `{"name":"REGION","value":"us"}`, false, map[string]string{"org": "acme"}, http.StatusUnauthorized},
		{"set missing org", handler.SetOrgVariable, `{"name":"REGION","value":"us"}`, true, nil, http.StatusBadRequest},
		{"set invalid json", handler.SetOrgVariable, `{`, true, map[string]string{"org": "acme"}, http.StatusBadRequest},
		{"set invalid name", handler.SetOrgVariable, `{"name":"bad name","value":"us"}`, true, map[string]string{"org": "acme"}, http.StatusUnprocessableEntity},
		{"set invalid value", handler.SetOrgVariable, `{"name":"REGION","value":""}`, true, map[string]string{"org": "acme"}, http.StatusUnprocessableEntity},
		{"delete requires auth", handler.DeleteOrgVariable, "", false, map[string]string{"org": "acme", "name": "REGION"}, http.StatusUnauthorized},
		{"delete missing org", handler.DeleteOrgVariable, "", true, nil, http.StatusBadRequest},
		{"delete missing name", handler.DeleteOrgVariable, "", true, map[string]string{"org": "acme"}, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/orgs/acme/variables", strings.NewReader(tc.body))
			if tc.params != nil {
				req = withRouteParams(req, tc.params)
			}
			if tc.auth {
				req = withAuth(req, 1, "alice")
			}
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, tc.want, rec.Code)
		})
	}

	serviceErrHandler := VariableHandler{Service: &variablesCovService{
		listOrgVariablesFn: func(context.Context, *db.User, string) ([]services.VariableResponse, error) {
			return nil, pkgerrors.Forbidden("blocked")
		},
		deleteOrgVariableFn: func(context.Context, *db.User, string, string) error {
			return pkgerrors.NotFound("variable not found")
		},
	}, Metrics: NewSmithersMetrics()}

	req := httptest.NewRequest(http.MethodGet, "/orgs/acme/variables", nil)
	req = withRouteParams(req, map[string]string{"org": "acme"})
	rec := httptest.NewRecorder()
	serviceErrHandler.ListOrgVariables(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)

	req = httptest.NewRequest(http.MethodDelete, "/orgs/acme/variables/REGION", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "name": "REGION"})
	req = withAuth(req, 1, "alice")
	rec = httptest.NewRecorder()
	serviceErrHandler.DeleteOrgVariable(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
