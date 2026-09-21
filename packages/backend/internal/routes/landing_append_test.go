package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLandingAppendRouteForwardsToExistingServiceAndRejectsLegacyRoute(t *testing.T) {
	t.Parallel()
	body := `{"commit_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","expected_commit_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source_base_commit_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","description":"delivery"}`
	for _, appendOnly := range []bool{true, false} {
		svc := &mockLandingRouteService{}
		h := LandingHandler{Service: svc}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/landings/7/land/append", strings.NewReader(body))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		if appendOnly {
			h.AppendLandingRequest(rec, req)
			require.Equal(t, 202, rec.Code)
			require.NotNil(t, svc.lastLandInput.Append)
			require.Equal(t, "delivery", svc.lastLandInput.Append.Description)
			require.Equal(t, svc.lastLandInput.CommitID, svc.lastLandInput.Append.SourceCommitID)
		} else {
			h.LandLandingRequest(rec, req)
			require.Equal(t, 400, rec.Code)
			require.Nil(t, svc.lastLandInput.Append)
		}
	}
}
