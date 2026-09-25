package smitherscli

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// suspendRecordingService satisfies routes.AdminUserRouteService and records
// SetSuspended calls; every other method is unused by PATCH suspension.
type suspendRecordingService struct {
	routes.AdminUserRouteService
	calls []struct {
		username  string
		suspended bool
	}
}

func (s *suspendRecordingService) SetSuspended(_ context.Context, username string, suspended bool) (services.UserProfile, error) {
	s.calls = append(s.calls, struct {
		username  string
		suspended bool
	}{username, suspended})
	return services.UserProfile{ID: 2, Username: username, Suspended: suspended}, nil
}

// TestAdminUserSuspensionMatchesServerContract drives the CLI against the real
// PATCH /api/admin/users/{username} handler, so a body the server rejects fails.
func TestAdminUserSuspensionMatchesServerContract(t *testing.T) {
	for _, tc := range []struct {
		command   string
		suspended bool
	}{
		{"disable", true},
		{"enable", false},
	} {
		t.Run(tc.command, func(t *testing.T) {
			svc := &suspendRecordingService{}
			handler := &routes.AdminUserHandler{Service: svc}
			router := chi.NewRouter()
			router.Patch("/api/admin/users/{username}", handler.PatchUser)
			server := httptest.NewServer(router)
			defer server.Close()
			authFSetConfig(t, server.URL)
			t.Setenv("SMITHERS_TOKEN", "smithers_contract")

			output := commandsMoreHTTPHServe(t, adminCommand(), "user", tc.command, "bob", "--json")

			require.Len(t, svc.calls, 1)
			require.Equal(t, "bob", svc.calls[0].username)
			require.Equal(t, tc.suspended, svc.calls[0].suspended)
			require.Contains(t, output, `"suspended"`)
		})
	}
}
