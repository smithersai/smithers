package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockLandingRouteService struct {
	listLandingRequestsFn  func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error)
	createLandingFn        func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLandingRequestInput) (services.LandingRequestResponse, error)
	getLandingFn           func(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingRequestResponse, error)
	updateLandingFn        func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateLandingRequestInput) (services.LandingRequestResponse, error)
	landLandingFn          func(ctx context.Context, actor *db.User, owner, repo string, number int64) (services.LandLandingRequestAccepted, error)
	setAutoLandFn          func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.SetAutoLandInput) (services.LandingRequestResponse, error)
	clearAutoLandFn        func(ctx context.Context, actor *db.User, owner, repo string, number int64) error
	createReviewRequestFn  func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewRequestInput) (services.LandingReviewRequestResponse, error)
	dismissReviewRequestFn func(ctx context.Context, actor *db.User, owner, repo string, number, requestID int64) error
	listReviewsFn          func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestReview, int64, error)
	createReviewFn         func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewInput) (db.LandingRequestReview, error)
	listCommentsFn         func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestComment, int64, error)
	createCommentFn        func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingCommentInput) (db.LandingRequestComment, error)
	markThreadDoneFn       func(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error)
	ackThreadFn            func(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error)
	reopenThreadFn         func(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error)
	listChangesFn          func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestChange, int64, error)
	getConflictsFn         func(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingConflictsResponse, error)
	dismissReviewFn        func(ctx context.Context, actor *db.User, owner, repo string, number int64, reviewID int64, req services.DismissLandingReviewInput) (db.LandingRequestReview, error)
	getLandingDiffFn       func(ctx context.Context, viewer *db.User, owner, repo string, number int64, opts services.LandingDiffOptions) (services.LandingDiffResponse, error)

	lastListOwner       string
	lastListRepo        string
	lastListState       string
	lastListAfterNumber int64
	lastListLimit       int
	lastLandInput       services.LandLandingRequestInput
}

func (m *mockLandingRouteService) ListLandingRequests(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error) {
	m.lastListOwner = owner
	m.lastListRepo = repo
	m.lastListAfterNumber = afterNumber
	m.lastListLimit = limit
	m.lastListState = state
	if m.listLandingRequestsFn != nil {
		return m.listLandingRequestsFn(ctx, viewer, owner, repo, afterNumber, limit, state)
	}
	return nil, "", 0, nil
}

func (m *mockLandingRouteService) CreateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLandingRequestInput) (services.LandingRequestResponse, error) {
	if m.createLandingFn != nil {
		return m.createLandingFn(ctx, actor, owner, repo, req)
	}
	return services.LandingRequestResponse{}, nil
}

func (m *mockLandingRouteService) GetLandingRequest(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingRequestResponse, error) {
	if m.getLandingFn != nil {
		return m.getLandingFn(ctx, viewer, owner, repo, number)
	}
	return services.LandingRequestResponse{}, nil
}

func (m *mockLandingRouteService) UpdateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateLandingRequestInput) (services.LandingRequestResponse, error) {
	if m.updateLandingFn != nil {
		return m.updateLandingFn(ctx, actor, owner, repo, number, req)
	}
	return services.LandingRequestResponse{}, nil
}

func (m *mockLandingRouteService) LandLandingRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.LandLandingRequestInput) (services.LandLandingRequestAccepted, error) {
	m.lastLandInput = req
	if m.landLandingFn != nil {
		return m.landLandingFn(ctx, actor, owner, repo, number)
	}
	return services.LandLandingRequestAccepted{}, nil
}

func (m *mockLandingRouteService) SetLandingRequestAutoLand(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.SetAutoLandInput) (services.LandingRequestResponse, error) {
	if m.setAutoLandFn != nil {
		return m.setAutoLandFn(ctx, actor, owner, repo, number, req)
	}
	return services.LandingRequestResponse{}, nil
}

func (m *mockLandingRouteService) ClearLandingRequestAutoLand(ctx context.Context, actor *db.User, owner, repo string, number int64) error {
	if m.clearAutoLandFn != nil {
		return m.clearAutoLandFn(ctx, actor, owner, repo, number)
	}
	return nil
}

func (m *mockLandingRouteService) CreateLandingReviewRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewRequestInput) (services.LandingReviewRequestResponse, error) {
	if m.createReviewRequestFn != nil {
		return m.createReviewRequestFn(ctx, actor, owner, repo, number, req)
	}
	return services.LandingReviewRequestResponse{}, nil
}

func (m *mockLandingRouteService) DismissLandingReviewRequest(ctx context.Context, actor *db.User, owner, repo string, number, requestID int64) error {
	if m.dismissReviewRequestFn != nil {
		return m.dismissReviewRequestFn(ctx, actor, owner, repo, number, requestID)
	}
	return nil
}

func (m *mockLandingRouteService) ListLandingReviews(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestReview, int64, error) {
	if m.listReviewsFn != nil {
		return m.listReviewsFn(ctx, viewer, owner, repo, number, page, perPage)
	}
	return nil, 0, nil
}

func (m *mockLandingRouteService) CreateLandingReview(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewInput) (db.LandingRequestReview, error) {
	if m.createReviewFn != nil {
		return m.createReviewFn(ctx, actor, owner, repo, number, req)
	}
	return db.LandingRequestReview{}, nil
}

func (m *mockLandingRouteService) DismissLandingReview(ctx context.Context, actor *db.User, owner, repo string, number int64, reviewID int64, req services.DismissLandingReviewInput) (db.LandingRequestReview, error) {
	if m.dismissReviewFn != nil {
		return m.dismissReviewFn(ctx, actor, owner, repo, number, reviewID, req)
	}
	return db.LandingRequestReview{}, nil
}

func (m *mockLandingRouteService) GetLandingDiff(ctx context.Context, viewer *db.User, owner, repo string, number int64, opts services.LandingDiffOptions) (services.LandingDiffResponse, error) {
	if m.getLandingDiffFn != nil {
		return m.getLandingDiffFn(ctx, viewer, owner, repo, number, opts)
	}
	return services.LandingDiffResponse{}, nil
}

func (m *mockLandingRouteService) ListLandingComments(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]services.LandingCommentResponse, int64, error) {
	if m.listCommentsFn != nil {
		rows, total, err := m.listCommentsFn(ctx, viewer, owner, repo, number, page, perPage)
		responses := make([]services.LandingCommentResponse, len(rows))
		for i, row := range rows {
			responses[i] = services.LandingCommentResponse{LandingRequestComment: row, AnchorState: "current", UserLogin: "alice"}
		}
		return responses, total, err
	}
	return nil, 0, nil
}

func (m *mockLandingRouteService) CreateLandingComment(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingCommentInput) (services.LandingCommentResponse, error) {
	if m.createCommentFn != nil {
		row, err := m.createCommentFn(ctx, actor, owner, repo, number, req)
		return services.LandingCommentResponse{LandingRequestComment: row, AnchorState: "current", UserLogin: actor.Username}, err
	}
	return services.LandingCommentResponse{}, nil
}

func (m *mockLandingRouteService) MarkLandingThreadDone(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
	if m.markThreadDoneFn != nil {
		return m.markThreadDoneFn(ctx, actor, owner, repo, number, threadID)
	}
	return db.LandingRequestComment{}, nil
}

func (m *mockLandingRouteService) AckLandingThread(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
	if m.ackThreadFn != nil {
		return m.ackThreadFn(ctx, actor, owner, repo, number, threadID)
	}
	return db.LandingRequestComment{}, nil
}

func (m *mockLandingRouteService) ReopenLandingThread(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
	if m.reopenThreadFn != nil {
		return m.reopenThreadFn(ctx, actor, owner, repo, number, threadID)
	}
	return db.LandingRequestComment{}, nil
}

func (m *mockLandingRouteService) ListLandingChanges(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestChange, int64, error) {
	if m.listChangesFn != nil {
		return m.listChangesFn(ctx, viewer, owner, repo, number, page, perPage)
	}
	return nil, 0, nil
}

func (m *mockLandingRouteService) GetLandingConflicts(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingConflictsResponse, error) {
	if m.getConflictsFn != nil {
		return m.getConflictsFn(ctx, viewer, owner, repo, number)
	}
	return services.LandingConflictsResponse{}, nil
}

func sampleLandingResponse() services.LandingRequestResponse {
	now := time.Now().UTC().Truncate(time.Second)
	return services.LandingRequestResponse{
		Number:         7,
		Title:          "Add auth",
		Body:           "seed",
		State:          "open",
		Author:         services.LandingRequestAuthor{ID: 1, Login: "alice"},
		ChangeIDs:      []string{"k1", "k2"},
		TargetBookmark: "main",
		ConflictStatus: "clean",
		StackSize:      2,
		AgentAuthored:  true,
		Turn: services.LandingRequestTurn{
			Party: "reviewer", ActorID: "agent-session-1", ActorLogin: "Implement auth", Since: now, Reason: "revision",
		},
		LandablePrefix: 1,
		BlockedBy: map[string][]services.LandingBlock{
			"k1": {},
			"k2": {
				{Kind: "check", Name: "ci/typecheck", Repo: "demo"},
				{Kind: "review", Missing: "agent_lgtm"},
			},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func TestLandingHandler_ReviewThreadActions(t *testing.T) {
	now := time.Now().UTC()
	actionCalls := make([]string, 0, 3)
	response := func(action string, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
		actionCalls = append(actionCalls, action)
		assert.Equal(t, int64(1), actor.ID)
		assert.Equal(t, "alice", owner)
		assert.Equal(t, "demo", repo)
		assert.Equal(t, int64(7), number)
		assert.Equal(t, int64(42), threadID)
		return db.LandingRequestComment{ID: threadID, LandingRequestID: 11, State: action, ResolvedInRevision: json.RawMessage(`null`), CreatedAt: now, UpdatedAt: now}, nil
	}
	h := LandingHandler{Service: &mockLandingRouteService{
		markThreadDoneFn: func(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
			return response("done", actor, owner, repo, number, threadID)
		},
		ackThreadFn: func(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
			return response("resolved", actor, owner, repo, number, threadID)
		},
		reopenThreadFn: func(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
			return response("open", actor, owner, repo, number, threadID)
		},
	}}

	tests := []struct {
		name    string
		path    string
		handler http.HandlerFunc
		state   string
	}{
		{name: "done", path: "/api/repos/alice/demo/landings/7/threads/42/done", handler: h.MarkLandingThreadDone, state: "done"},
		{name: "ack", path: "/api/repos/alice/demo/landings/7/threads/42/ack", handler: h.AckLandingThread, state: "resolved"},
		{name: "reopen", path: "/api/repos/alice/demo/landings/7/threads/42/reopen", handler: h.ReopenLandingThread, state: "open"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tc.path, nil)
			req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "id": "42"})
			req = withAuth(req, 1, "alice")
			rec := httptest.NewRecorder()
			tc.handler(rec, req)
			require.Equal(t, http.StatusOK, rec.Code)
			var body db.LandingRequestComment
			require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
			assert.Equal(t, tc.state, body.State)
		})
	}
	assert.Equal(t, []string{"done", "resolved", "open"}, actionCalls)
}

func TestLandingHandler_ListLandingRequests(t *testing.T) {
	t.Parallel()

	h := LandingHandler{
		Service: &mockLandingRouteService{
			listLandingRequestsFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error) {
				assert.Nil(t, viewer)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, int64(10), afterNumber)
				assert.Equal(t, 10, limit)
				assert.Equal(t, "open", state)
				return []services.LandingRequestResponse{sampleLandingResponse()}, "", 31, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings?cursor="+encodeIDCursor(10)+"&limit=10&state=open", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListLandingRequests(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "31", rec.Header().Get("X-Total-Count"))
	assert.Contains(t, rec.Body.String(), `"landable_prefix":1`)
	assert.Contains(t, rec.Body.String(), `"blocked_by":{"k1":[],"k2":[{"kind":"check","name":"ci/typecheck","repo":"demo"},{"kind":"review","missing":"agent_lgtm"}]}`)

	var body []services.LandingRequestResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, int64(7), body[0].Number)
	assert.Equal(t, "main", body[0].TargetBookmark)
	assert.Equal(t, "reviewer", body[0].Turn.Party)
	assert.Equal(t, "Implement auth", body[0].Turn.ActorLogin)
	assert.Equal(t, "revision", body[0].Turn.Reason)
	assert.Equal(t, int64(1), body[0].LandablePrefix)
	require.Len(t, body[0].BlockedBy, 2)
	require.Len(t, body[0].BlockedBy["k2"], 2)
	assert.Equal(t, "ci/typecheck", body[0].BlockedBy["k2"][0].Name)
	assert.Equal(t, "agent_lgtm", body[0].BlockedBy["k2"][1].Missing)
}

func TestLandingHandler_ListLandingRequests_LegacyPagination(t *testing.T) {
	t.Parallel()

	t.Run("page=1 with per_page is honored as the first page", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				listLandingRequestsFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error) {
					assert.Zero(t, afterNumber)
					assert.Equal(t, 10, limit)
					return []services.LandingRequestResponse{sampleLandingResponse()}, "", 1, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings?page=1&per_page=10", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListLandingRequests(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("page>1 is rejected instead of being misread as a landing number", func(t *testing.T) {
		called := false
		h := LandingHandler{
			Service: &mockLandingRouteService{
				listLandingRequestsFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error) {
					called = true
					return nil, "", 0, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings?page=2&per_page=10", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListLandingRequests(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)
	})
}

func TestLandingHandler_ListLandingRequests_WrappedAPIError(t *testing.T) {
	t.Parallel()

	h := LandingHandler{
		Service: &mockLandingRouteService{
			listLandingRequestsFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error) {
				return nil, "", 0, fmt.Errorf("wrapped: %w", pkgerrors.ValidationFailed(pkgerrors.FieldError{
					Resource: "LandingRequest",
					Field:    "state",
					Code:     "invalid",
				}))
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings?page=1&per_page=10&state=open", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListLandingRequests(rec, req)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestLandingHandler_CreateLandingRequest(t *testing.T) {
	t.Parallel()

	t.Run("requires auth", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings", strings.NewReader(`{"title":"x"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.CreateLandingRequest(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("invalid json", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateLandingRequest(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("created response", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				createLandingFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLandingRequestInput) (services.LandingRequestResponse, error) {
					assert.Equal(t, int64(1), actor.ID)
					assert.Equal(t, "alice", owner)
					assert.Equal(t, "demo", repo)
					assert.Equal(t, "new", req.Title)
					assert.Equal(t, "main", req.TargetBookmark)
					assert.Equal(t, "feature/new", req.SourceBookmark)
					assert.Equal(t, []string{"k1", "k2"}, req.ChangeIDs)
					resp := sampleLandingResponse()
					resp.Number = 42
					return resp, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings", strings.NewReader(`{"title":"new","body":"seed","target_bookmark":"main","source_bookmark":"feature/new","change_ids":["k1","k2"]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateLandingRequest(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		var payload services.LandingRequestResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Equal(t, int64(42), payload.Number)
	})

	t.Run("wrapped api errors keep status code", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				createLandingFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLandingRequestInput) (services.LandingRequestResponse, error) {
					return services.LandingRequestResponse{}, fmt.Errorf("wrapped: %w", pkgerrors.Conflict("duplicate landing request"))
				},
			},
		}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings", strings.NewReader(`{"title":"new","target_bookmark":"main","change_ids":["k1"]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateLandingRequest(rec, req)

		require.Equal(t, http.StatusConflict, rec.Code)
	})
}

func TestLandingHandler_GetAndPatchLandingRequest(t *testing.T) {
	t.Parallel()

	t.Run("invalid number", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/not-a-number", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "not-a-number"})
		rec := httptest.NewRecorder()
		h.GetLandingRequest(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get success", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				getLandingFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingRequestResponse, error) {
					assert.Equal(t, int64(7), number)
					return sampleLandingResponse(), nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		rec := httptest.NewRecorder()
		h.GetLandingRequest(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var payload services.LandingRequestResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Equal(t, int64(7), payload.Number)
		assert.Equal(t, "agent-session-1", payload.Turn.ActorID)
	})

	t.Run("patch invalid json", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchLandingRequest(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch success and api error propagation", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				updateLandingFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateLandingRequestInput) (services.LandingRequestResponse, error) {
					assert.Equal(t, int64(1), actor.ID)
					assert.Equal(t, int64(7), number)
					require.NotNil(t, req.Title)
					assert.Equal(t, "updated", *req.Title)
					require.NotNil(t, req.TargetBookmark)
					assert.Equal(t, "release", *req.TargetBookmark)
					require.NotNil(t, req.SourceBookmark)
					assert.Equal(t, "feature-v2", *req.SourceBookmark)
					require.NotNil(t, req.ConflictStatus)
					assert.Equal(t, "conflicted", *req.ConflictStatus)
					resp := sampleLandingResponse()
					resp.Title = "updated"
					return resp, nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7", strings.NewReader(`{"title":"updated","target_bookmark":"release","source_bookmark":"feature-v2","conflict_status":"conflicted"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchLandingRequest(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
}

func TestLandingHandler_LandEndpoint(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		resp := sampleLandingResponse()
		resp.State = "queued"
		h := LandingHandler{
			Service: &mockLandingRouteService{
				landLandingFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64) (services.LandLandingRequestAccepted, error) {
					assert.Equal(t, int64(1), actor.ID)
					assert.Equal(t, int64(7), number)
					return services.LandLandingRequestAccepted{LandingRequestResponse: resp, QueuePosition: 1, TaskID: 42}, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/landings/7/land", strings.NewReader(`{"commit_id":"commit-1"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.LandLandingRequest(rec, req)
		require.Equal(t, http.StatusAccepted, rec.Code)
		assert.Equal(t, "commit-1", h.Service.(*mockLandingRouteService).lastLandInput.CommitID)
	})

	t.Run("error normalization", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				landLandingFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64) (services.LandLandingRequestAccepted, error) {
					return services.LandLandingRequestAccepted{}, pkgerrors.Forbidden("permission denied")
				},
			},
		}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/landings/7/land", strings.NewReader(`{"commit_id":"commit-1"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.LandLandingRequest(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestLandingHandler_AutoLandEndpoints(t *testing.T) {
	t.Parallel()
	actor := &db.User{ID: 9, Username: "owner"}

	t.Run("enables auto-land", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{
			setAutoLandFn: func(_ context.Context, gotActor *db.User, owner, repo string, number int64, req services.SetAutoLandInput) (services.LandingRequestResponse, error) {
				assert.Equal(t, actor.ID, gotActor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, int64(7), number)
				assert.True(t, req.Enabled)
				response := sampleLandingResponse()
				response.AutoLand = services.LandingAutoLand{Enabled: true, SetBy: &services.LandingRequestAuthor{ID: actor.ID, Login: actor.Username}, WaitingOn: []services.LandingBlock{{Kind: "check", Name: "ci/test"}}}
				return response, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/auto-land", strings.NewReader(`{"enabled":true}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, actor.ID, actor.Username)
		rec := httptest.NewRecorder()

		h.SetLandingRequestAutoLand(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var response services.LandingRequestResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
		assert.True(t, response.AutoLand.Enabled)
		assert.Equal(t, "ci/test", response.AutoLand.WaitingOn[0].Name)
	})

	t.Run("requires enabled", func(t *testing.T) {
		called := false
		h := LandingHandler{Service: &mockLandingRouteService{setAutoLandFn: func(context.Context, *db.User, string, string, int64, services.SetAutoLandInput) (services.LandingRequestResponse, error) {
			called = true
			return services.LandingRequestResponse{}, nil
		}}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/auto-land", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, actor.ID, actor.Username)
		rec := httptest.NewRecorder()

		h.SetLandingRequestAutoLand(rec, req)

		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		assert.False(t, called)
	})

	t.Run("clears auto-land", func(t *testing.T) {
		called := false
		h := LandingHandler{Service: &mockLandingRouteService{
			clearAutoLandFn: func(_ context.Context, gotActor *db.User, owner, repo string, number int64) error {
				called = true
				assert.Equal(t, actor.ID, gotActor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, int64(7), number)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/landings/7/auto-land", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, actor.ID, actor.Username)
		rec := httptest.NewRecorder()

		h.ClearLandingRequestAutoLand(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, called)
	})
}

func TestLandingHandler_ReviewRequestEndpoints(t *testing.T) {
	t.Parallel()

	t.Run("requests a human reviewer", func(t *testing.T) {
		now := time.Now().UTC().Truncate(time.Second)
		h := LandingHandler{Service: &mockLandingRouteService{
			createReviewRequestFn: func(_ context.Context, actor *db.User, owner, repo string, number int64, input services.CreateLandingReviewRequestInput) (services.LandingReviewRequestResponse, error) {
				assert.Equal(t, int64(9), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, int64(7), number)
				assert.Equal(t, "bob", input.Reviewer)
				assert.Empty(t, input.Agent)
				return services.LandingReviewRequestResponse{
					ID:          41,
					RequestedBy: services.LandingRequestAuthor{ID: 9, Login: "alice"},
					Reviewer:    &services.LandingRequestAuthor{ID: 10, Login: "bob"},
					State:       "requested",
					CreatedAt:   now,
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/review-requests", strings.NewReader(`{"reviewer":"bob"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 9, "alice")
		rec := httptest.NewRecorder()

		h.RequestLandingReview(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		var response services.LandingReviewRequestResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
		assert.Equal(t, int64(41), response.ID)
		require.NotNil(t, response.Reviewer)
		assert.Equal(t, "bob", response.Reviewer.Login)
	})

	t.Run("rejects invalid json", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/review-requests", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 9, "alice")
		rec := httptest.NewRecorder()

		h.RequestLandingReview(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("dismisses a request", func(t *testing.T) {
		called := false
		h := LandingHandler{Service: &mockLandingRouteService{
			dismissReviewRequestFn: func(_ context.Context, actor *db.User, owner, repo string, number, requestID int64) error {
				called = true
				assert.Equal(t, int64(9), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, int64(7), number)
				assert.Equal(t, int64(41), requestID)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/landings/7/review-requests/41", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "id": "41"})
		req = withAuth(req, 9, "alice")
		rec := httptest.NewRecorder()

		h.DeleteLandingReviewRequest(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, called)
	})

	t.Run("rejects an invalid request id", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/landings/7/review-requests/nope", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "id": "nope"})
		req = withAuth(req, 9, "alice")
		rec := httptest.NewRecorder()

		h.DeleteLandingReviewRequest(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestLandingHandler_ReviewsCommentsChangesAndConflicts(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	h := LandingHandler{
		Service: &mockLandingRouteService{
			listReviewsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestReview, int64, error) {
				assert.Equal(t, int64(7), number)
				return []db.LandingRequestReview{{
					ID:               1,
					LandingRequestID: 11,
					ReviewerID:       pgtype.Int8{Int64: 1, Valid: true},
					Type:             "approve",
					Body:             "lgtm",
					State:            "submitted",
					CreatedAt:        now,
					UpdatedAt:        now,
				}}, 4, nil
			},
			createReviewFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewInput) (db.LandingRequestReview, error) {
				assert.Equal(t, "comment", req.Type)
				assert.Equal(t, "commit-1", req.CommitID)
				return db.LandingRequestReview{
					ID:               2,
					LandingRequestID: 11,
					ReviewerID:       pgtype.Int8{Int64: actor.ID, Valid: true},
					Type:             req.Type,
					Body:             req.Body,
					State:            "submitted",
					CreatedAt:        now,
					UpdatedAt:        now,
				}, nil
			},
			listCommentsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestComment, int64, error) {
				return []db.LandingRequestComment{{
					ID:               1,
					LandingRequestID: 11,
					UserID:           pgtype.Int8{Int64: 1, Valid: true},
					Path:             "README.md",
					Line:             5,
					Side:             "right",
					Body:             "nit",
					State:            "done",
					CreatedAt:        now,
					UpdatedAt:        now,
				}}, 3, nil
			},
			createCommentFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingCommentInput) (db.LandingRequestComment, error) {
				assert.Equal(t, "commit-1", req.CommitID)
				return db.LandingRequestComment{
					ID:               2,
					LandingRequestID: 11,
					UserID:           pgtype.Int8{Int64: actor.ID, Valid: true},
					Path:             req.Path,
					Line:             req.Line,
					Side:             req.Side,
					Body:             req.Body,
					State:            "open",
					CreatedAt:        now,
					UpdatedAt:        now,
				}, nil
			},
			listChangesFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestChange, int64, error) {
				return []db.LandingRequestChange{{ID: 1, LandingRequestID: 11, ChangeID: "k1", PositionInStack: 1, CreatedAt: now}}, 2, nil
			},
			getConflictsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingConflictsResponse, error) {
				return services.LandingConflictsResponse{
					ConflictStatus: "conflicted",
					HasConflicts:   true,
					ConflictsByChange: map[string][]services.LandingConflict{
						"k1": {{FilePath: "README.md", ConflictType: "both_modified"}},
					},
				}, nil
			},
		},
	}

	listReviewsReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/reviews?page=1&per_page=10", nil)
	listReviewsReq = withRouteParams(listReviewsReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
	listReviewsRec := httptest.NewRecorder()
	h.ListLandingReviews(listReviewsRec, listReviewsReq)
	require.Equal(t, http.StatusOK, listReviewsRec.Code)
	assert.Equal(t, "4", listReviewsRec.Header().Get("X-Total-Count"))

	createReviewReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/reviews", strings.NewReader(`{"type":"comment","body":"nit","commit_id":"commit-1"}`))
	createReviewReq = withRouteParams(createReviewReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
	createReviewReq = withAuth(createReviewReq, 1, "alice")
	createReviewRec := httptest.NewRecorder()
	h.PostLandingReview(createReviewRec, createReviewReq)
	require.Equal(t, http.StatusCreated, createReviewRec.Code)

	listCommentsReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/comments", nil)
	listCommentsReq = withRouteParams(listCommentsReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
	listCommentsRec := httptest.NewRecorder()
	h.ListLandingComments(listCommentsRec, listCommentsReq)
	require.Equal(t, http.StatusOK, listCommentsRec.Code)
	assert.Contains(t, listCommentsRec.Body.String(), `"user_login":"alice"`)
	var commentsBody []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(listCommentsRec.Body.Bytes(), &commentsBody))
	require.Len(t, commentsBody, 1)
	assert.JSONEq(t, `"done"`, string(commentsBody[0]["state"]))
	assert.JSONEq(t, `"current"`, string(commentsBody[0]["anchor_state"]))

	createCommentReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/comments", strings.NewReader(`{"path":"README.md","line":8,"side":"left","body":"nit","commit_id":"commit-1"}`))
	createCommentReq = withRouteParams(createCommentReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
	createCommentReq = withAuth(createCommentReq, 1, "alice")
	createCommentRec := httptest.NewRecorder()
	h.PostLandingComment(createCommentRec, createCommentReq)
	require.Equal(t, http.StatusCreated, createCommentRec.Code)
	assert.Contains(t, createCommentRec.Body.String(), `"user_login":"alice"`)
	var createdCommentBody map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(createCommentRec.Body.Bytes(), &createdCommentBody))
	assert.JSONEq(t, `"open"`, string(createdCommentBody["state"]))
	assert.JSONEq(t, `"current"`, string(createdCommentBody["anchor_state"]))

	listChangesReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/changes", nil)
	listChangesReq = withRouteParams(listChangesReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
	listChangesRec := httptest.NewRecorder()
	h.ListLandingChanges(listChangesRec, listChangesReq)
	require.Equal(t, http.StatusOK, listChangesRec.Code)

	conflictsReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/conflicts", nil)
	conflictsReq = withRouteParams(conflictsReq, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
	conflictsRec := httptest.NewRecorder()
	h.GetLandingConflicts(conflictsRec, conflictsReq)
	require.Equal(t, http.StatusOK, conflictsRec.Code)
	var conflictsBody services.LandingConflictsResponse
	require.NoError(t, json.Unmarshal(conflictsRec.Body.Bytes(), &conflictsBody))
	assert.True(t, conflictsBody.HasConflicts)
}

func TestLandingHandler_PostLandingReviewPassesAgentFields(t *testing.T) {
	t.Parallel()

	h := LandingHandler{Service: &mockLandingRouteService{createReviewFn: func(_ context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewInput) (db.LandingRequestReview, error) {
		assert.Equal(t, int64(1), actor.ID)
		assert.Equal(t, "alice", owner)
		assert.Equal(t, "demo", repo)
		assert.Equal(t, int64(7), number)
		assert.Equal(t, "lgtm", req.Verdict)
		assert.Equal(t, "high", req.ConfidenceBucket)
		assert.Equal(t, "Safe to land.", req.Summary)
		assert.Equal(t, "commit-1", req.CommitID)
		return db.LandingRequestReview{
			ID:               2,
			LandingRequestID: 11,
			ReviewerKind:     "agent",
			Type:             "approve",
			Verdict:          pgtype.Text{String: req.Verdict, Valid: true},
			ConfidenceBucket: pgtype.Text{String: req.ConfidenceBucket, Valid: true},
			Summary:          req.Summary,
			CommitID:         req.CommitID,
			Body:             req.Summary,
			State:            "submitted",
		}, nil
	}}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/reviews", strings.NewReader(`{"verdict":"lgtm","confidence_bucket":"high","summary":"Safe to land.","commit_id":"commit-1"}`))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PostLandingReview(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Contains(t, rec.Body.String(), `"reviewer_kind":"agent"`)
	assert.Contains(t, rec.Body.String(), `"commit_id":"commit-1"`)
}

func TestLandingHandler_DismissLandingReview(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)

	t.Run("requires auth", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7/reviews/1", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "review_id": "1"})
		rec := httptest.NewRecorder()
		h.DismissLandingReview(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("invalid review_id", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7/reviews/not-a-number", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "review_id": "not-a-number"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DismissLandingReview(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success returns dismissed review", func(t *testing.T) {
		dismissed := db.LandingRequestReview{
			ID: 5, LandingRequestID: 11, ReviewerID: pgtype.Int8{Int64: 1, Valid: true},
			Type: "approve", Body: "lgtm", State: "dismissed",
			CreatedAt: now, UpdatedAt: now,
		}
		h := LandingHandler{
			Service: &mockLandingRouteService{
				dismissReviewFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, reviewID int64, req services.DismissLandingReviewInput) (db.LandingRequestReview, error) {
					assert.Equal(t, int64(1), actor.ID)
					assert.Equal(t, int64(7), number)
					assert.Equal(t, int64(5), reviewID)
					assert.Equal(t, "policy violation", req.Message)
					return dismissed, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7/reviews/5", strings.NewReader(`{"message":"policy violation"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "review_id": "5"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DismissLandingReview(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var body db.LandingRequestReview
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "dismissed", body.State)
		assert.Equal(t, int64(5), body.ID)
	})

	t.Run("service error propagated", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				dismissReviewFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, reviewID int64, req services.DismissLandingReviewInput) (db.LandingRequestReview, error) {
					return db.LandingRequestReview{}, fmt.Errorf("wrapped: %w", pkgerrors.NotFound("review not found"))
				},
			},
		}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7/reviews/99", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "review_id": "99"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DismissLandingReview(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("empty body accepted — message is optional", func(t *testing.T) {
		dismissed := db.LandingRequestReview{
			ID: 3, LandingRequestID: 11, ReviewerID: pgtype.Int8{Int64: 1, Valid: true},
			Type: "approve", State: "dismissed",
			CreatedAt: now, UpdatedAt: now,
		}
		h := LandingHandler{
			Service: &mockLandingRouteService{
				dismissReviewFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, reviewID int64, req services.DismissLandingReviewInput) (db.LandingRequestReview, error) {
					assert.Equal(t, "", req.Message)
					return dismissed, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/landings/7/reviews/3", http.NoBody)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7", "review_id": "3"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DismissLandingReview(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
}

func TestLandingHandler_GetLandingDiff(t *testing.T) {
	t.Parallel()

	t.Run("invalid number", func(t *testing.T) {
		h := LandingHandler{Service: &mockLandingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/not-a-number/diff", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "not-a-number"})
		rec := httptest.NewRecorder()
		h.GetLandingDiff(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success returns aggregated diff with two changes", func(t *testing.T) {
		diffResp := services.LandingDiffResponse{
			LandingNumber: 7,
			Changes: []services.LandingDiffEntry{
				{
					ChangeID:  "abc123",
					FileDiffs: []repohost.FileDiff{{Path: "README.md", ChangeType: "modified", Patch: "@@ -1 +1 @@\n-old\n+new\n", Additions: 1, Deletions: 1, Language: "markdown"}},
				},
				{
					ChangeID:  "def456",
					FileDiffs: []repohost.FileDiff{{Path: "go.mod", ChangeType: "added", Patch: "@@ -0,0 +1 @@\n+module demo\n", Additions: 1, Language: "go"}},
				},
			},
		}
		h := LandingHandler{
			Service: &mockLandingRouteService{
				getLandingDiffFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, opts services.LandingDiffOptions) (services.LandingDiffResponse, error) {
					assert.Equal(t, "alice", owner)
					assert.Equal(t, "demo", repo)
					assert.Equal(t, int64(7), number)
					assert.False(t, opts.IgnoreWhitespace)
					return diffResp, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/diff", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		rec := httptest.NewRecorder()
		h.GetLandingDiff(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var body services.LandingDiffResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body.Changes, 2)
		assert.Equal(t, "abc123", body.Changes[0].ChangeID)
		assert.Len(t, body.Changes[0].FileDiffs, 1)
		assert.Equal(t, "README.md", body.Changes[0].FileDiffs[0].Path)
		assert.Equal(t, "modified", body.Changes[0].FileDiffs[0].ChangeType)
		assert.Equal(t, 1, body.Changes[0].FileDiffs[0].Additions)
		assert.Equal(t, "markdown", body.Changes[0].FileDiffs[0].Language)
	})

	t.Run("service error propagated", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				getLandingDiffFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, opts services.LandingDiffOptions) (services.LandingDiffResponse, error) {
					return services.LandingDiffResponse{}, fmt.Errorf("wrapped: %w", pkgerrors.NotFound("landing request not found"))
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/999/diff", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "999"})
		rec := httptest.NewRecorder()
		h.GetLandingDiff(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("anonymous access allowed — no auth required", func(t *testing.T) {
		// GetLandingDiff does not require auth — uses middleware.UserFromContext (may be nil)
		diffResp := services.LandingDiffResponse{Changes: []services.LandingDiffEntry{}}
		h := LandingHandler{
			Service: &mockLandingRouteService{
				getLandingDiffFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, opts services.LandingDiffOptions) (services.LandingDiffResponse, error) {
					assert.Nil(t, viewer) // no auth context injected
					return diffResp, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/diff", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		// No withAuth — anonymous request
		rec := httptest.NewRecorder()
		h.GetLandingDiff(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("whitespace query is forwarded", func(t *testing.T) {
		h := LandingHandler{
			Service: &mockLandingRouteService{
				getLandingDiffFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, opts services.LandingDiffOptions) (services.LandingDiffResponse, error) {
					assert.True(t, opts.IgnoreWhitespace)
					return services.LandingDiffResponse{}, nil
				},
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/landings/7/diff?whitespace=ignore", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		rec := httptest.NewRecorder()
		h.GetLandingDiff(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
}
