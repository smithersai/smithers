package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type singleOwnerTestQueries struct{ owner db.User }

func (q singleOwnerTestQueries) GetSelfHostOwner(context.Context) (db.User, error) {
	return q.owner, nil
}

func TestSingleOwnerBoundaryRejectsOtherwiseValidForeignPrincipal(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := SingleOwnerBoundary(singleOwnerTestQueries{owner: db.User{ID: 1}})(next)
	req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 2}}))
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code)
}

func TestSingleOwnerBoundaryAllowsPersistedOwner(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := SingleOwnerBoundary(singleOwnerTestQueries{owner: db.User{ID: 1}})(next)
	req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 1}}))
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestRejectTenantProvisioningCoversOrganizationsAndTeams(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	for _, path := range []string{"/api/orgs", "/api/orgs/acme/teams", "/api/admin/orgs", "/api/admin/users", "/api/user/orgs"} {
		rec := httptest.NewRecorder()
		RejectTenantProvisioning(next).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		assert.Equal(t, http.StatusNotFound, rec.Code, path)
	}
}
