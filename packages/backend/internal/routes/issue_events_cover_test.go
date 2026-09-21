package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type issueEventsCovService struct {
	err     error
	called  bool
	viewer  *db.User
	owner   string
	repo    string
	number  int64
	page    int
	perPage int
}

func (s *issueEventsCovService) ListIssueEvents(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]services.IssueEventResponse, error) {
	s.called = true
	s.viewer = viewer
	s.owner = owner
	s.repo = repo
	s.number = number
	s.page = page
	s.perPage = perPage
	if s.err != nil {
		return nil, s.err
	}
	return []services.IssueEventResponse{{
		ID:        1,
		IssueID:   2,
		EventType: "closed",
		Payload:   json.RawMessage(`{"state":"closed"}`),
		CreatedAt: time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC),
	}}, nil
}

func TestIssueEvents_Cov_ListIssueEventsBranches(t *testing.T) {
	t.Parallel()

	t.Run("invalid number returns bad request", func(t *testing.T) {
		svc := &issueEventsCovService{}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/nope/events", nil), map[string]string{"owner": "alice", "repo": "demo", "number": "nope"})
		rec := httptest.NewRecorder()

		(&IssueEventHandler{Service: svc}).ListIssueEvents(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, svc.called)
	})

	t.Run("success passes viewer and pagination", func(t *testing.T) {
		svc := &issueEventsCovService{}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/9/events?page=2&per_page=10", nil), map[string]string{"owner": "alice", "repo": "demo", "number": "9"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		(&IssueEventHandler{Service: svc}).ListIssueEvents(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, svc.called)
		require.NotNil(t, svc.viewer)
		assert.Equal(t, int64(7), svc.viewer.ID)
		assert.Equal(t, "alice", svc.owner)
		assert.Equal(t, "demo", svc.repo)
		assert.Equal(t, int64(9), svc.number)
		assert.Equal(t, 2, svc.page)
		assert.Equal(t, 10, svc.perPage)
		assert.Contains(t, rec.Body.String(), `"event_type":"closed"`)
	})

	t.Run("service api error propagates", func(t *testing.T) {
		svc := &issueEventsCovService{err: pkgerrors.NotFound("issue not found")}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/9/events", nil), map[string]string{"owner": "alice", "repo": "demo", "number": "9"})
		rec := httptest.NewRecorder()

		(&IssueEventHandler{Service: svc}).ListIssueEvents(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), "issue not found")
	})
}
