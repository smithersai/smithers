package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockLinearIssueLinkRouteService struct {
	linkFn   func(context.Context, *db.User, string, string, int64, services.LinearIssueLinkInput) (services.LinearIssueReference, error)
	unlinkFn func(context.Context, *db.User, string, string, int64) error
}

func (m *mockLinearIssueLinkRouteService) LinkIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, input services.LinearIssueLinkInput) (services.LinearIssueReference, error) {
	return m.linkFn(ctx, actor, owner, repo, number, input)
}

func (m *mockLinearIssueLinkRouteService) UnlinkIssue(ctx context.Context, actor *db.User, owner, repo string, number int64) error {
	return m.unlinkFn(ctx, actor, owner, repo, number)
}

func TestIssueHandler_PostLinearIssueLink(t *testing.T) {
	t.Parallel()

	h := IssueHandler{LinearLink: &mockLinearIssueLinkRouteService{
		linkFn: func(_ context.Context, actor *db.User, owner, repo string, number int64, input services.LinearIssueLinkInput) (services.LinearIssueReference, error) {
			assert.Equal(t, int64(7), actor.ID)
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, int64(4), number)
			assert.Equal(t, "ENG-482", input.Identifier)
			return services.LinearIssueReference{Identifier: "ENG-482", URL: "https://linear.app/issue/ENG-482"}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/4/linear-link", strings.NewReader(`{"identifier":"ENG-482"}`))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "4"})
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()
	h.PostLinearIssueLink(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var payload services.LinearIssueReference
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "ENG-482", payload.Identifier)
	assert.Equal(t, "https://linear.app/issue/ENG-482", payload.URL)
}

func TestIssueHandler_PostLinearIssueLinkErrors(t *testing.T) {
	t.Parallel()

	t.Run("requires authentication", func(t *testing.T) {
		h := IssueHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/4/linear-link", strings.NewReader(`{"identifier":"ENG-482"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "4"})
		rec := httptest.NewRecorder()
		h.PostLinearIssueLink(rec, req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("rejects malformed JSON", func(t *testing.T) {
		h := IssueHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/4/linear-link", strings.NewReader("{"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "4"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostLinearIssueLink(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("writes service error", func(t *testing.T) {
		h := IssueHandler{LinearLink: &mockLinearIssueLinkRouteService{
			linkFn: func(context.Context, *db.User, string, string, int64, services.LinearIssueLinkInput) (services.LinearIssueReference, error) {
				return services.LinearIssueReference{}, pkgerrors.UnprocessableEntity("unknown Linear issue")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/4/linear-link", strings.NewReader(`{"identifier":"ENG-999"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "4"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostLinearIssueLink(rec, req)
		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})
}

func TestIssueHandler_DeleteLinearIssueLink(t *testing.T) {
	t.Parallel()

	called := false
	h := IssueHandler{LinearLink: &mockLinearIssueLinkRouteService{
		unlinkFn: func(_ context.Context, actor *db.User, owner, repo string, number int64) error {
			called = true
			assert.Equal(t, int64(7), actor.ID)
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, int64(4), number)
			return nil
		},
	}}
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/issues/4/linear-link", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "4"})
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()
	h.DeleteLinearIssueLink(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, called)
}
