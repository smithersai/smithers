package routes

import (
	"context"
	stderrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TestLandings_F_GuardBranches drives the remaining auth, route-context,
// pagination, body-decode and service-error guards across the landing handlers.
func TestLandings_F_GuardBranches(t *testing.T) {
	ownerRepo := map[string]string{"owner": "alice", "repo": "demo"}
	fullCtx := map[string]string{"owner": "alice", "repo": "demo", "number": "3"}

	t.Run("GetLandingRequest service error", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{
			getLandingFn: func(_ context.Context, _ *db.User, _, _ string, _ int64) (services.LandingRequestResponse, error) {
				return services.LandingRequestResponse{}, stderrors.New("db down")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/3", nil)
		req = withRouteParams(req, fullCtx)
		rec := httptest.NewRecorder()
		h.GetLandingRequest(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("PatchLandingRequest requires auth", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/3", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		h.PatchLandingRequest(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("PatchLandingRequest bad route context", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/", strings.NewReader(`{}`))
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PatchLandingRequest(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("LandLandingRequest bad route context", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings//land", nil)
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.LandLandingRequest(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	// No route params at all -> repoOwnerAndName fails inside landingRouteContext,
	// covering both the handler guard and landingRouteContext's owner branch.
	t.Run("ListLandingReviews missing owner", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos//landings/3/reviews", nil)
		rec := httptest.NewRecorder()
		h.ListLandingReviews(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PostLandingReview requires auth", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/3/reviews", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		h.PostLandingReview(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("PostLandingReview bad route context", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings//reviews", strings.NewReader(`{}`))
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostLandingReview(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("DismissLandingReview bad route context", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/landings//reviews/5", strings.NewReader(`{}`))
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DismissLandingReview(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("DismissLandingReview missing review_id", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/landings/3/reviews/", strings.NewReader(`{}`))
		req = withRouteParams(req, fullCtx)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DismissLandingReview(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListLandingComments bad route context", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings//comments", nil)
		req = withRouteParams(req, ownerRepo)
		rec := httptest.NewRecorder()
		h.ListLandingComments(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListLandingComments bad pagination", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/3/comments?page=abc", nil)
		req = withRouteParams(req, fullCtx)
		rec := httptest.NewRecorder()
		h.ListLandingComments(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PostLandingComment requires auth", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/3/comments", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		h.PostLandingComment(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("PostLandingComment bad route context", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings//comments", strings.NewReader(`{}`))
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostLandingComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PostLandingComment invalid body", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/3/comments", strings.NewReader(`not-json`))
		req = withRouteParams(req, fullCtx)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostLandingComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListLandingChanges bad route context", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings//changes", nil)
		req = withRouteParams(req, ownerRepo)
		rec := httptest.NewRecorder()
		h.ListLandingChanges(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListLandingChanges bad pagination", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/3/changes?page=abc", nil)
		req = withRouteParams(req, fullCtx)
		rec := httptest.NewRecorder()
		h.ListLandingChanges(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("GetLandingConflicts bad route context", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings//conflicts", nil)
		req = withRouteParams(req, ownerRepo)
		rec := httptest.NewRecorder()
		h.GetLandingConflicts(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
