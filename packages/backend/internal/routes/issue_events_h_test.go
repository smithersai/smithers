package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIssueEvents_H_RouteAndPaginationBranches(t *testing.T) {
	t.Run("missing owner", func(t *testing.T) {
		svc := &issueEventsCovService{}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos//demo/issues/9/events", nil), map[string]string{"repo": "demo", "number": "9"})
		rec := httptest.NewRecorder()

		(&IssueEventHandler{Service: svc}).ListIssueEvents(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, svc.called)
	})

	t.Run("invalid pagination", func(t *testing.T) {
		svc := &issueEventsCovService{}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/9/events?page=0", nil), map[string]string{"owner": "alice", "repo": "demo", "number": "9"})
		rec := httptest.NewRecorder()

		(&IssueEventHandler{Service: svc}).ListIssueEvents(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, svc.called)
	})
}
