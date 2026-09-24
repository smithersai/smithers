package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockBranchLockRouteService struct {
	acquireFn   func(ctx context.Context, input services.AcquireBranchLockInput) (services.BranchLockResponse, error)
	heartbeatFn func(ctx context.Context, input services.AcquireBranchLockInput) error
	releaseFn   func(ctx context.Context, input services.AcquireBranchLockInput) error
	requestFn   func(ctx context.Context, input services.RequestBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error)
	listFn      func(ctx context.Context, input services.AcquireBranchLockInput) ([]services.BranchLockJoinRequestResponse, error)
	decideFn    func(ctx context.Context, input services.DecideBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error)
}

func (m mockBranchLockRouteService) AcquireBranchLock(ctx context.Context, input services.AcquireBranchLockInput) (services.BranchLockResponse, error) {
	return m.acquireFn(ctx, input)
}
func (m mockBranchLockRouteService) HeartbeatBranchLock(ctx context.Context, input services.AcquireBranchLockInput) error {
	if m.heartbeatFn != nil {
		return m.heartbeatFn(ctx, input)
	}
	return nil
}
func (m mockBranchLockRouteService) ReleaseBranchLock(ctx context.Context, input services.AcquireBranchLockInput) error {
	if m.releaseFn != nil {
		return m.releaseFn(ctx, input)
	}
	return nil
}
func (m mockBranchLockRouteService) RequestBranchLockJoin(ctx context.Context, input services.RequestBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error) {
	return m.requestFn(ctx, input)
}
func (m mockBranchLockRouteService) ListPendingBranchLockJoinRequests(ctx context.Context, input services.AcquireBranchLockInput) ([]services.BranchLockJoinRequestResponse, error) {
	if m.listFn != nil {
		return m.listFn(ctx, input)
	}
	return []services.BranchLockJoinRequestResponse{}, nil
}
func (m mockBranchLockRouteService) DecideBranchLockJoin(ctx context.Context, input services.DecideBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error) {
	return m.decideFn(ctx, input)
}

func branchLockAuthedRequest(method, target, body string) *http.Request {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 7, Username: "dave"},
	})
	ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
		Owner:      "alice",
		Repository: &db.Repository{ID: 1, Name: "app"},
	}, middleware.PermissionWrite)
	return req.WithContext(ctx)
}

func TestBranchLockAcquire_Unauthorized(t *testing.T) {
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/acquire", strings.NewReader(`{"branch":"b"}`))
	rec := httptest.NewRecorder()
	handler.AcquireBranchLock(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestBranchLockAcquire_OK(t *testing.T) {
	var gotInput services.AcquireBranchLockInput
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{
		acquireFn: func(ctx context.Context, input services.AcquireBranchLockInput) (services.BranchLockResponse, error) {
			gotInput = input
			return services.BranchLockResponse{RepositoryID: 1, Branch: input.Branch, Status: "acquired", HolderUsername: "dave"}, nil
		},
	}}
	req := branchLockAuthedRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/acquire", `{"branch":"landing/app/main"}`)
	rec := httptest.NewRecorder()
	handler.AcquireBranchLock(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int64(1), gotInput.RepositoryID)
	assert.Equal(t, int64(7), gotInput.UserID)
	assert.Equal(t, "landing/app/main", gotInput.Branch)
}

func TestBranchLockAcquire_ConflictCarriesDetails(t *testing.T) {
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{
		acquireFn: func(ctx context.Context, input services.AcquireBranchLockInput) (services.BranchLockResponse, error) {
			return services.BranchLockResponse{}, &pkgerrors.APIError{
				Status:  http.StatusConflict,
				Code:    "branch_lock_held",
				Message: "branch landing/app/main is checked out by carol",
				Details: services.BranchLockHeldDetails{
					HolderUsername: "carol",
					Branch:         "landing/app/main",
					CanRequestJoin: true,
				},
			}
		},
	}}
	req := branchLockAuthedRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/acquire", `{"branch":"landing/app/main"}`)
	rec := httptest.NewRecorder()
	handler.AcquireBranchLock(rec, req)
	assert.Equal(t, http.StatusConflict, rec.Code)
	var body struct {
		Code    string `json:"code"`
		Details struct {
			HolderUsername string `json:"holder_username"`
			CanRequestJoin bool   `json:"can_request_join"`
		} `json:"details"`
	}
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "branch_lock_held", body.Code)
	assert.Equal(t, "carol", body.Details.HolderUsername)
	assert.True(t, body.Details.CanRequestJoin)
}

func TestBranchLockAcquire_MissingBranch(t *testing.T) {
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{}}
	req := branchLockAuthedRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/acquire", `{}`)
	rec := httptest.NewRecorder()
	handler.AcquireBranchLock(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestBranchLockHeartbeat_NoContent(t *testing.T) {
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{}}
	req := branchLockAuthedRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/heartbeat", `{"branch":"b"}`)
	rec := httptest.NewRecorder()
	handler.HeartbeatBranchLock(rec, req)
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestBranchLockJoinRequest_Created(t *testing.T) {
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{
		requestFn: func(ctx context.Context, input services.RequestBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error) {
			assert.Equal(t, "dave", input.Username)
			return services.BranchLockJoinRequestResponse{ID: 42, Branch: input.Branch, RequesterUsername: "dave", Status: "pending"}, nil
		},
	}}
	req := branchLockAuthedRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/join-requests", `{"branch":"landing/app/main"}`)
	rec := httptest.NewRecorder()
	handler.RequestBranchLockJoin(rec, req)
	assert.Equal(t, http.StatusCreated, rec.Code)
}

func TestBranchLockDecide_ValidatesDecision(t *testing.T) {
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{}}
	req := branchLockAuthedRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/join-requests/42/decide", `{"decision":"maybe"}`)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "42")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	handler.DecideBranchLockJoin(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestBranchLockDecide_Approve(t *testing.T) {
	var gotInput services.DecideBranchLockJoinInput
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{
		decideFn: func(ctx context.Context, input services.DecideBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error) {
			gotInput = input
			return services.BranchLockJoinRequestResponse{ID: input.JoinRequestID, Status: "approved"}, nil
		},
	}}
	req := branchLockAuthedRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/join-requests/42/decide", `{"decision":"approve"}`)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "42")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	handler.DecideBranchLockJoin(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int64(42), gotInput.JoinRequestID)
	assert.Equal(t, int64(7), gotInput.ResolverID)
	assert.True(t, gotInput.Approve)
}

func TestBranchLockListJoinRequests_RequiresBranchParam(t *testing.T) {
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{}}
	req := branchLockAuthedRequest(http.MethodGet, "/api/repos/alice/app/branch-locks/join-requests", "")
	rec := httptest.NewRecorder()
	handler.ListBranchLockJoinRequests(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}
