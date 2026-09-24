package routes

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func (m *mockAdminUserService) SetSynthetic(ctx context.Context, name string, value bool) (services.AdminSyntheticUserProfile, error) {
	if m.setSyntheticFn != nil {
		return m.setSyntheticFn(ctx, name, value)
	}
	return services.AdminSyntheticUserProfile{}, nil
}
func TestAdminUserHandlerPatchSynthetic(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status int
		value  bool
	}{
		{`{"synthetic":true}`, 200, true}, {`{"synthetic":false}`, 200, false},
		{`{"synthetic":null}`, 400, false}, {`{"synthetic":"true"}`, 400, false}, {`{`, 400, false},
		{`{"synthetic":true,"suspended":true}`, 400, false},
	} {
		t.Run(tc.body, func(t *testing.T) {
			calls := 0
			h := AdminUserHandler{Service: &mockAdminUserService{setSyntheticFn: func(ctx context.Context, name string, value bool) (services.AdminSyntheticUserProfile, error) {
				calls++
				require.Equal(t, "alice", name)
				require.Equal(t, tc.value, value)
				actor, ok := services.AdminAuditActorFromContext(ctx)
				require.True(t, ok)
				require.NotZero(t, actor.UserID)
				return services.AdminSyntheticUserProfile{Synthetic: value}, nil
			}}}
			router := chi.NewRouter()
			router.Patch("/users/{username}", h.PatchUser)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, withAdminContext(httptest.NewRequest(http.MethodPatch, "/users/alice", strings.NewReader(tc.body))))
			require.Equal(t, tc.status, rec.Code)
			if tc.status == 200 {
				require.Equal(t, 1, calls)
				var body map[string]any
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
				require.Equal(t, tc.value, body["synthetic"])
			} else {
				require.Zero(t, calls)
			}
		})
	}
	for _, status := range []int{404, 500} {
		h := AdminUserHandler{Service: &mockAdminUserService{setSyntheticFn: func(context.Context, string, bool) (services.AdminSyntheticUserProfile, error) {
			if status == 404 {
				return services.AdminSyntheticUserProfile{}, pkgerrors.NotFound("user not found")
			}
			return services.AdminSyntheticUserProfile{}, pkgerrors.Internal("failed")
		}}}
		router := chi.NewRouter()
		router.Patch("/users/{username}", h.PatchUser)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/users/alice", strings.NewReader(`{"synthetic":true}`)))
		require.Equal(t, status, rec.Code)
	}
}
