package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type fakeAnalyticsRouteService struct {
	fn func(context.Context, string, bool) (clusterservices.AnalyticsSummary, error)
}

func (f fakeAnalyticsRouteService) Summary(ctx context.Context, r string, b bool) (clusterservices.AnalyticsSummary, error) {
	return f.fn(ctx, r, b)
}
func TestAdminAnalyticsHandlerSummary(t *testing.T) {
	for _, tc := range []struct {
		query, rangeName string
		synthetic        bool
		status           int
	}{
		{"", "30d", false, 200}, {"?range=7d", "7d", false, 200}, {"?range=90d&include_synthetic=true", "90d", true, 200},
		{"?range=30d&include_synthetic=false", "30d", false, 200}, {"?range=1d", "", false, 400}, {"?range=", "", false, 400},
		{"?range=7d&range=30d", "", false, 400}, {"?include_synthetic=1", "", false, 400}, {"?include_synthetic=", "", false, 400},
		{"?include_synthetic=false&include_synthetic=true", "", false, 400},
	} {
		t.Run(tc.query, func(t *testing.T) {
			calls := 0
			h := AdminAnalyticsHandler{Service: fakeAnalyticsRouteService{fn: func(ctx context.Context, r string, b bool) (clusterservices.AnalyticsSummary, error) {
				calls++
				require.Equal(t, tc.rangeName, r)
				require.Equal(t, tc.synthetic, b)
				return clusterservices.AnalyticsSummary{Range: r, SyntheticExcluded: !b}, nil
			}}}
			rec := httptest.NewRecorder()
			h.Summary(rec, httptest.NewRequest(http.MethodGet, "/api/admin/analytics/summary"+tc.query, nil))
			require.Equal(t, tc.status, rec.Code)
			if tc.status == 200 {
				require.Equal(t, 1, calls)
				var body clusterservices.AnalyticsSummary
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
				require.Equal(t, tc.rangeName, body.Range)
			} else {
				require.Zero(t, calls)
			}
		})
	}
	h := AdminAnalyticsHandler{Service: fakeAnalyticsRouteService{fn: func(context.Context, string, bool) (clusterservices.AnalyticsSummary, error) {
		return clusterservices.AnalyticsSummary{}, pkgerrors.Internal("query failed")
	}}}
	rec := httptest.NewRecorder()
	h.Summary(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	require.Equal(t, 500, rec.Code)
}
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
