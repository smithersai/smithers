package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type fakeAnalyticsRouteService struct {
	fn func(context.Context, string, bool) (services.AnalyticsSummary, error)
}

func (f fakeAnalyticsRouteService) Summary(ctx context.Context, r string, b bool) (services.AnalyticsSummary, error) {
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
			h := AdminAnalyticsHandler{Service: fakeAnalyticsRouteService{fn: func(ctx context.Context, r string, b bool) (services.AnalyticsSummary, error) {
				calls++
				require.Equal(t, tc.rangeName, r)
				require.Equal(t, tc.synthetic, b)
				return services.AnalyticsSummary{Range: r, SyntheticExcluded: !b}, nil
			}}}
			rec := httptest.NewRecorder()
			h.Summary(rec, httptest.NewRequest(http.MethodGet, "/api/admin/analytics/summary"+tc.query, nil))
			require.Equal(t, tc.status, rec.Code)
			if tc.status == 200 {
				require.Equal(t, 1, calls)
				var body services.AnalyticsSummary
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
				require.Equal(t, tc.rangeName, body.Range)
			} else {
				require.Zero(t, calls)
			}
		})
	}
	h := AdminAnalyticsHandler{Service: fakeAnalyticsRouteService{fn: func(context.Context, string, bool) (services.AnalyticsSummary, error) {
		return services.AnalyticsSummary{}, pkgerrors.Internal("query failed")
	}}}
	rec := httptest.NewRecorder()
	h.Summary(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	require.Equal(t, 500, rec.Code)
}
