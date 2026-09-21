package routes

import (
	"context"
	stderrors "errors"
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

func TestLandings_Cov_ListAndContextFailures(t *testing.T) {
	t.Run("missing route owner returns bad request", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings", nil)
		rec := httptest.NewRecorder()

		h.ListLandingRequests(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("pagination validation stops before service call", func(t *testing.T) {
		called := false
		h := LandingHandler{Service: &mockLandingRouteService{
			listLandingRequestsFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error) {
				called = true
				return nil, "", 0, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings?page=abc", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListLandingRequests(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)
	})

	t.Run("plain service errors become internal server errors", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{
			listLandingRequestsFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error) {
				return nil, "", 0, stderrors.New("database offline")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListLandingRequests(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("landing route context rejects missing and nonpositive numbers", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		_, _, _, err := landingRouteContext(req)
		require.Error(t, err)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/0", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "0"})
		_, _, _, err = landingRouteContext(req)
		require.Error(t, err)
	})
}

func TestLandings_Cov_MutatingHandlersValidationAndServiceErrors(t *testing.T) {
	t.Run("create rejects missing route params after auth", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings", strings.NewReader(`{"title":"x"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateLandingRequest(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch propagates service conflict and no-op pointer fields", func(t *testing.T) {
		called := false
		h := LandingHandler{Service: &mockLandingRouteService{
			updateLandingFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateLandingRequestInput) (services.LandingRequestResponse, error) {
				called = true
				assert.Nil(t, req.Title)
				assert.Nil(t, req.Body)
				assert.Nil(t, req.State)
				return services.LandingRequestResponse{}, pkgerrors.Conflict("landing already queued")
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PatchLandingRequest(rec, req)

		require.Equal(t, http.StatusConflict, rec.Code)
		assert.True(t, called)
	})

	t.Run("land requires auth before service call", func(t *testing.T) {
		called := false
		h := LandingHandler{Service: &mockLandingRouteService{
			landLandingFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64) (services.LandLandingRequestAccepted, error) {
				called = true
				return services.LandLandingRequestAccepted{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/landings/7/land", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		rec := httptest.NewRecorder()

		h.LandLandingRequest(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.False(t, called)
	})
}

func TestLandings_Cov_ReviewCommentChangeAndConflictErrorBranches(t *testing.T) {
	t.Run("review listing handles pagination errors and service errors", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/reviews?per_page=nope", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		rec := httptest.NewRecorder()

		h.ListLandingReviews(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)

		h = LandingHandler{Service: &mockLandingRouteService{
			listReviewsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestReview, int64, error) {
				return nil, 0, pkgerrors.Forbidden("no review access")
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/reviews", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		rec = httptest.NewRecorder()

		h.ListLandingReviews(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("create review rejects invalid json and propagates validation errors", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/reviews", strings.NewReader(`{bad`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PostLandingReview(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)

		h = LandingHandler{Service: &mockLandingRouteService{
			createReviewFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewInput) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{}, pkgerrors.BadRequest("invalid review type")
			},
		}}
		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/reviews", strings.NewReader(`{"type":"approve","body":"ok"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()

		h.PostLandingReview(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("dismiss review rejects invalid optional json", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7/reviews/1", strings.NewReader(`{bad`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "review_id": "1"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.DismissLandingReview(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("comments changes and conflicts propagate service errors", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{
			listCommentsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestComment, int64, error) {
				return nil, 0, pkgerrors.NotFound("landing request not found")
			},
			createCommentFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingCommentInput) (db.LandingRequestComment, error) {
				return db.LandingRequestComment{}, pkgerrors.BadRequest("body is required")
			},
			listChangesFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]services.LandingChangeResponse, int64, error) {
				return nil, 0, pkgerrors.Forbidden("no access")
			},
			getConflictsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingConflictsResponse, error) {
				return services.LandingConflictsResponse{}, stderrors.New("conflict worker offline")
			},
		}}

		listCommentsReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/comments", nil)
		listCommentsReq = withRouteParams(listCommentsReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		listCommentsRec := httptest.NewRecorder()
		h.ListLandingComments(listCommentsRec, listCommentsReq)
		require.Equal(t, http.StatusNotFound, listCommentsRec.Code)

		createCommentReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/comments", strings.NewReader(`{"body":""}`))
		createCommentReq = withRouteParams(createCommentReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		createCommentReq = withAuth(createCommentReq, 7, "alice")
		createCommentRec := httptest.NewRecorder()
		h.PostLandingComment(createCommentRec, createCommentReq)
		require.Equal(t, http.StatusBadRequest, createCommentRec.Code)

		listChangesReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/changes", nil)
		listChangesReq = withRouteParams(listChangesReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		listChangesRec := httptest.NewRecorder()
		h.ListLandingChanges(listChangesRec, listChangesReq)
		require.Equal(t, http.StatusForbidden, listChangesRec.Code)

		conflictsReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/conflicts", nil)
		conflictsReq = withRouteParams(conflictsReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		conflictsRec := httptest.NewRecorder()
		h.GetLandingConflicts(conflictsRec, conflictsReq)
		require.Equal(t, http.StatusInternalServerError, conflictsRec.Code)
	})
}
