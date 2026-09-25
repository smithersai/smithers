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
)

type landingGitHubPullRoute struct {
	input   services.LandingGitHubPullInput
	created bool
}

func (m *landingGitHubPullRoute) OpenLandingGitHubPull(_ context.Context, _ *db.User, owner, repo string, number int64, input services.LandingGitHubPullInput) (services.LandingGitHubPull, error) {
	m.input = input
	return services.LandingGitHubPull{LandingNumber: number, Number: 41, Created: m.created}, nil
}

func TestLandingGitHubPullRoute(t *testing.T) {
	t.Parallel()
	body := `{"commit_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","run_id":"run-7"}`
	request := func() *http.Request {
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/landings/7/github/pull", strings.NewReader(body))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		return withAuth(req, 1, "alice")
	}
	for _, created := range []bool{true, false} {
		svc := &landingGitHubPullRoute{created: created}
		rec := httptest.NewRecorder()
		(&LandingHandler{GitHubPull: svc}).OpenLandingGitHubPull(rec, request())
		want := http.StatusOK
		if created {
			want = http.StatusCreated
		}
		require.Equal(t, want, rec.Code)
		require.Equal(t, services.LandingGitHubPullInput{CommitID: strings.Repeat("b", 40), RunID: "run-7"}, svc.input)
	}
	rec := httptest.NewRecorder()
	(&LandingHandler{}).OpenLandingGitHubPull(rec, request())
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}
