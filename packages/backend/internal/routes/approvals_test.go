package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockApprovalRouteService struct {
	listFn   func(ctx context.Context, repositoryID int64, state string, page, perPage int) ([]services.ApprovalResponse, error)
	getFn    func(ctx context.Context, approvalID string, repoID int64) (services.ApprovalResponse, error)
	decideFn func(ctx context.Context, input services.DecideApprovalInput) (services.ApprovalResponse, error)
}

func (m *mockApprovalRouteService) ListForRepo(ctx context.Context, repositoryID int64, state string, page, perPage int) ([]services.ApprovalResponse, error) {
	if m.listFn != nil {
		return m.listFn(ctx, repositoryID, state, page, perPage)
	}
	return nil, nil
}

func (m *mockApprovalRouteService) GetForRepo(ctx context.Context, approvalID string, repoID int64) (services.ApprovalResponse, error) {
	if m.getFn != nil {
		return m.getFn(ctx, approvalID, repoID)
	}
	return services.ApprovalResponse{}, nil
}

func (m *mockApprovalRouteService) Decide(ctx context.Context, input services.DecideApprovalInput) (services.ApprovalResponse, error) {
	if m.decideFn != nil {
		return m.decideFn(ctx, input)
	}
	return services.ApprovalResponse{}, nil
}

func TestApprovalsHandler_ListApprovals_Success(t *testing.T) {
	t.Parallel()
	var gotRepoID int64
	var gotState string
	var gotPage int
	var gotPerPage int
	svc := &mockApprovalRouteService{
		listFn: func(_ context.Context, repositoryID int64, state string, page, perPage int) ([]services.ApprovalResponse, error) {
			gotRepoID = repositoryID
			gotState = state
			gotPage = page
			gotPerPage = perPage
			return []services.ApprovalResponse{{
				ID:           "approval-1",
				RepositoryID: repositoryID,
				State:        services.ApprovalStatePending,
				Title:        "Approve deploy",
			}}, nil
		},
	}
	h := &ApprovalsHandler{Service: svc, Enabled: true}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/approvals?state=pending&page=2&per_page=5", nil)
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.ListApprovals(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int64(42), gotRepoID)
	assert.Equal(t, "pending", gotState)
	assert.Equal(t, 2, gotPage)
	assert.Equal(t, 5, gotPerPage)

	var body []services.ApprovalResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, "approval-1", body[0].ID)
}

func TestApprovalsHandler_ListApprovals_FlagOff_Returns404(t *testing.T) {
	t.Parallel()
	h := &ApprovalsHandler{Service: &mockApprovalRouteService{}, Enabled: false}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/approvals", nil)
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.ListApprovals(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestApprovalsHandler_GetApproval_Success(t *testing.T) {
	t.Parallel()
	var gotID string
	var gotRepoID int64
	svc := &mockApprovalRouteService{
		getFn: func(_ context.Context, approvalID string, repoID int64) (services.ApprovalResponse, error) {
			gotID = approvalID
			gotRepoID = repoID
			return services.ApprovalResponse{
				ID:           approvalID,
				RepositoryID: repoID,
				State:        services.ApprovalStatePending,
				Title:        "Approve deploy",
			}, nil
		},
	}
	h := &ApprovalsHandler{Service: svc, Enabled: true}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/approvals/approval-1", nil)
	req = withRouteParams(req, map[string]string{"id": "approval-1"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.GetApproval(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "approval-1", gotID)
	assert.Equal(t, int64(42), gotRepoID)

	var body services.ApprovalResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "approval-1", body.ID)
}

func TestApprovalsHandler_Decide_FlagOff_Returns404(t *testing.T) {
	t.Parallel()
	h := &ApprovalsHandler{Service: &mockApprovalRouteService{}, Enabled: false}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"approved"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestApprovalsHandler_Decide_FlagOn_Approved_Success(t *testing.T) {
	t.Parallel()
	var got services.DecideApprovalInput
	svc := &mockApprovalRouteService{
		decideFn: func(_ context.Context, input services.DecideApprovalInput) (services.ApprovalResponse, error) {
			got = input
			return services.ApprovalResponse{
				ID:           input.ApprovalID,
				RepositoryID: input.RepositoryID,
				State:        services.ApprovalStateApproved,
			}, nil
		},
	}
	h := &ApprovalsHandler{Service: svc, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"approved"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "abc", got.ApprovalID)
	assert.Equal(t, int64(42), got.RepositoryID)
	assert.Equal(t, int64(7), got.UserID)
	assert.Equal(t, "approved", got.Decision)
}

func TestApprovalsHandler_Decide_IdempotentSameDecision_200(t *testing.T) {
	t.Parallel()
	svc := &mockApprovalRouteService{
		decideFn: func(_ context.Context, input services.DecideApprovalInput) (services.ApprovalResponse, error) {
			// idempotent: return existing approved row, no error.
			return services.ApprovalResponse{ID: input.ApprovalID, State: services.ApprovalStateApproved}, nil
		},
	}
	h := &ApprovalsHandler{Service: svc, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"approved"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestApprovalsHandler_Decide_ConflictingDecision_409(t *testing.T) {
	t.Parallel()
	svc := &mockApprovalRouteService{
		decideFn: func(_ context.Context, _ services.DecideApprovalInput) (services.ApprovalResponse, error) {
			return services.ApprovalResponse{}, pkgerrors.Conflict("approval already decided")
		},
	}
	h := &ApprovalsHandler{Service: svc, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"rejected"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusConflict, rec.Code)
}

func TestApprovalsHandler_Decide_Expired_400(t *testing.T) {
	t.Parallel()
	svc := &mockApprovalRouteService{
		decideFn: func(_ context.Context, _ services.DecideApprovalInput) (services.ApprovalResponse, error) {
			return services.ApprovalResponse{}, pkgerrors.BadRequest("approval has expired")
		},
	}
	h := &ApprovalsHandler{Service: svc, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"approved"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestApprovalsHandler_Decide_WrongRepo_404(t *testing.T) {
	t.Parallel()
	svc := &mockApprovalRouteService{
		decideFn: func(_ context.Context, _ services.DecideApprovalInput) (services.ApprovalResponse, error) {
			return services.ApprovalResponse{}, pkgerrors.NotFound("approval not found")
		},
	}
	h := &ApprovalsHandler{Service: svc, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"approved"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 999, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestApprovalsHandler_Decide_NonExistent_404(t *testing.T) {
	t.Parallel()
	svc := &mockApprovalRouteService{
		decideFn: func(_ context.Context, _ services.DecideApprovalInput) (services.ApprovalResponse, error) {
			return services.ApprovalResponse{}, pkgerrors.NotFound("approval not found")
		},
	}
	h := &ApprovalsHandler{Service: svc, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/ghost/decide", strings.NewReader(`{"decision":"approved"}`))
	req = withRouteParams(req, map[string]string{"id": "ghost"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestApprovalsHandler_Decide_BadBody_400(t *testing.T) {
	t.Parallel()
	h := &ApprovalsHandler{Service: &mockApprovalRouteService{}, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestApprovalsHandler_Decide_BadDecision_400(t *testing.T) {
	t.Parallel()
	h := &ApprovalsHandler{Service: &mockApprovalRouteService{}, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"maybe"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestApprovalsHandler_Decide_NoAuth_401(t *testing.T) {
	t.Parallel()
	h := &ApprovalsHandler{Service: &mockApprovalRouteService{}, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"approved"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withRepoCtx(req, 42, "alice", "demo")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestApprovalsHandler_Decide_NoRepoContext_400(t *testing.T) {
	t.Parallel()
	h := &ApprovalsHandler{Service: &mockApprovalRouteService{}, Enabled: true}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"approved"}`))
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.Decide(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestApprovalsHandler_Decide_RateLimited429(t *testing.T) {
	t.Parallel()

	h := &ApprovalsHandler{
		Enabled: true,
		Service: &mockApprovalRouteService{
			decideFn: func(_ context.Context, input services.DecideApprovalInput) (services.ApprovalResponse, error) {
				return services.ApprovalResponse{
					ID:           input.ApprovalID,
					RepositoryID: input.RepositoryID,
					State:        services.ApprovalStateApproved,
				}, nil
			},
		},
	}
	store := &routeRateLimitStore{}
	limited := middleware.ApprovalDecideRateLimit(store, 1)(http.HandlerFunc(h.Decide))

	makeReq := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/abc/decide", strings.NewReader(`{"decision":"approved"}`))
		req = withRouteParams(req, map[string]string{"id": "abc"})
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 42, "alice", "demo")
		return req
	}

	first := httptest.NewRecorder()
	limited.ServeHTTP(first, makeReq())
	require.Equal(t, http.StatusOK, first.Code)

	second := httptest.NewRecorder()
	limited.ServeHTTP(second, makeReq())
	require.Equal(t, http.StatusTooManyRequests, second.Code)
	assert.NotEmpty(t, second.Header().Get("Retry-After"))
	assert.NotEmpty(t, second.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, second.Header().Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, second.Header().Get("X-RateLimit-Reset"))
	assert.Contains(t, store.keysSeen, "approval_decide|user:7")
	assert.NotContains(t, store.keysSeen, "api|user:7")
}

type routeRateLimitStore struct {
	mu       sync.Mutex
	buckets  map[string]float64
	keysSeen []string
}

func (s *routeRateLimitStore) ConsumeSearchRateLimitToken(_ context.Context, arg db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.buckets == nil {
		s.buckets = make(map[string]float64)
	}

	key := arg.Scope + "|" + arg.PrincipalKey
	s.keysSeen = append(s.keysSeen, key)
	remaining, ok := s.buckets[key]
	if !ok {
		remaining = arg.Capacity
	}
	allowed := remaining >= 1
	if allowed {
		remaining--
	}
	s.buckets[key] = remaining

	return db.ConsumeSearchRateLimitTokenRow{
		Allowed:         allowed,
		RemainingTokens: remaining,
		NowAt:           arg.NowAt,
	}, nil
}

func (s *routeRateLimitStore) DeleteExpiredSearchRateLimits(context.Context, time.Time) error {
	return nil
}
