package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type SingleOwnerQuerier interface {
	GetSelfHostOwner(context.Context) (db.User, error)
}

// SingleOwnerBoundary rejects a valid credential for any principal other than
// the persisted installation owner. It is enabled only in self-host mode;
// multitenant deployments retain their existing per-repository/org checks.
func SingleOwnerBoundary(queries SingleOwnerQuerier) func(http.Handler) http.Handler {
	boundary := identity.NewSingleOwnerBoundary(queries)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := UserFromContext(r.Context())
			if user == nil {
				next.ServeHTTP(w, r)
				return
			}
			if err := boundary.AuthorizeOwner(r.Context(), user.ID); err != nil {
				pkgerrors.WriteError(w, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

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
