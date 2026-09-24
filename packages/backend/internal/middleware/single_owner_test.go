package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRejectTenantProvisioningCoversOrganizationsAndTeams(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	for _, path := range []string{"/api/orgs", "/api/orgs/acme/teams", "/api/admin/orgs", "/api/admin/users", "/api/user/orgs"} {
		rec := httptest.NewRecorder()
		RejectTenantProvisioning(next).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		assert.Equal(t, http.StatusNotFound, rec.Code, path)
	}
}
