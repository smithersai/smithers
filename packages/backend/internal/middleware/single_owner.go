package middleware

import (
	"net/http"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// RejectTenantProvisioning removes organization/team and hosted tenant-admin
// surfaces from a single-owner installation. This guard is intentionally at
// the shared HTTP boundary so adding a new handler cannot accidentally expose
// tenant provisioning in self-host mode.
func RejectTenantProvisioning(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimSuffix(r.URL.Path, "/")
		if path == "/api/orgs" || strings.HasPrefix(path, "/api/orgs/") ||
			path == "/api/user/orgs" || path == "/api/admin/orgs" || strings.HasPrefix(path, "/api/admin/orgs/") ||
			path == "/api/admin/users" || strings.HasPrefix(path, "/api/admin/users/") {
			pkgerrors.WriteError(w, pkgerrors.NotFound("tenant routes are not available in single-owner mode"))
			return
		}
		next.ServeHTTP(w, r)
	})
}
