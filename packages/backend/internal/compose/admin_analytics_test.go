package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Keep the router's existing admin fake aligned with the extended PATCH contract.
func (m *mockAdminUserRouteService) SetSynthetic(ctx context.Context, username string, synthetic bool) (services.AdminSyntheticUserProfile, error) {
	return services.AdminSyntheticUserProfile{UserProfile: services.UserProfile{Username: username}, Synthetic: synthetic}, nil
}

func TestAdminSyntheticPatchScope(t *testing.T) {
	router := routerWithAdminUserHandler(&routes.AdminUserHandler{Service: &mockAdminUserRouteService{}})
	for _, tc := range []struct {
		scope  middleware.TokenScope
		admin  bool
		status int
	}{
		{middleware.ScopeReadAdmin, true, 403}, {middleware.ScopeWriteAdmin, true, 200}, {middleware.ScopeWriteAdmin, false, 403},
	} {
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/users/alice", strings.NewReader(`{"synthetic":true}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterAdminTokenAuth(req, tc.admin, middleware.TokenSourcePersonalAccessToken, tc.scope)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, tc.status, rec.Code)
	}
}
