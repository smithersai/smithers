// Tests for the ticket-0132 per-user open-rate limiters.
package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// withTestUser stashes a minimal *db.User in the request context so the
// shared rate-limit middleware keys the bucket by user ID rather than IP.
func withTestUser(req *http.Request, userID int64) *http.Request {
	return req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: userID}))
}

func TestWorkspaceTerminalOpenRateLimit_BelowPasses_AtLimitRejects(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := WorkspaceTerminalOpenRateLimit(store, 3)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// 3 below limit pass.
	for i := 0; i < 3; i++ {
		req := withTestUser(httptest.NewRequest(http.MethodGet, "/api/repos/x/y/workspace/sessions/s/terminal", nil), 42)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equalf(t, http.StatusNoContent, rec.Code, "request %d must pass", i)
	}

	// 4th trips the limit.
	req := withTestUser(httptest.NewRequest(http.MethodGet, "/api/repos/x/y/workspace/sessions/s/terminal", nil), 42)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, store.keysSeen, "workspace_terminal_open|user:42")
}

func TestApprovalDecideRateLimit_BelowPasses_AtLimitRejects(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := ApprovalDecideRateLimit(store, 2)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for i := 0; i < 2; i++ {
		req := withTestUser(httptest.NewRequest(http.MethodPost, "/api/repos/x/y/approvals/abc/decide", nil), 11)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	}

	req := withTestUser(httptest.NewRequest(http.MethodPost, "/api/repos/x/y/approvals/abc/decide", nil), 11)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, store.keysSeen, "approval_decide|user:11")
}

func TestTicket0132Scopes_MultiUserIsolation(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := ApprovalDecideRateLimit(store, 1)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// User A saturates.
	reqA := withTestUser(httptest.NewRequest(http.MethodPost, "/decide", nil), 1)
	recA := httptest.NewRecorder()
	handler.ServeHTTP(recA, reqA)
	require.Equal(t, http.StatusNoContent, recA.Code)

	reqAOver := withTestUser(httptest.NewRequest(http.MethodPost, "/decide", nil), 1)
	recAOver := httptest.NewRecorder()
	handler.ServeHTTP(recAOver, reqAOver)
	require.Equal(t, http.StatusTooManyRequests, recAOver.Code)

	// User B must not be affected.
	reqB := withTestUser(httptest.NewRequest(http.MethodPost, "/decide", nil), 2)
	recB := httptest.NewRecorder()
	handler.ServeHTTP(recB, reqB)
	assert.Equal(t, http.StatusNoContent, recB.Code)
}

func TestTicket0132Scopes_ScopeIsolation(t *testing.T) {
	// Each new scope uses its own bucket — a request against terminal_open
	// must not consume a slot for approval_decide.
	t.Parallel()

	store := &mockRateLimitStore{}
	termMW := WorkspaceTerminalOpenRateLimit(store, 1)
	approvalMW := ApprovalDecideRateLimit(store, 1)

	termHandler := termMW(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	approvalHandler := approvalMW(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	// Saturate terminal bucket for user 5.
	req := withTestUser(httptest.NewRequest(http.MethodGet, "/terminal", nil), 5)
	rec := httptest.NewRecorder()
	termHandler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)

	reqOver := withTestUser(httptest.NewRequest(http.MethodGet, "/terminal", nil), 5)
	recOver := httptest.NewRecorder()
	termHandler.ServeHTTP(recOver, reqOver)
	require.Equal(t, http.StatusTooManyRequests, recOver.Code)

	// Approval bucket for the same user is independent and must still allow.
	reqApproval := withTestUser(httptest.NewRequest(http.MethodPost, "/decide", nil), 5)
	recApproval := httptest.NewRecorder()
	approvalHandler.ServeHTTP(recApproval, reqApproval)
	assert.Equal(t, http.StatusNoContent, recApproval.Code)
}

// Smoke test that default limits are positive so we don't ship a
// configuration where the user silently passes a zero and rate limits
// collapse to the fallback defaults without noticing.
func TestTicket0132Scopes_DefaultsAreSane(t *testing.T) {
	t.Parallel()

	// limit<=0 should fall back to the built-in default, not 0.
	store := &mockRateLimitStore{}
	mw := WorkspaceTerminalOpenRateLimit(store, 0)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	// At least one request should pass with the built-in default.
	req := withTestUser(httptest.NewRequest(http.MethodGet, "/x", nil), 1)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNoContent, rec.Code)

	// Guard against drift — the public limit header must match the built-in default (20).
	assert.Equal(t, "20", rec.Header().Get("X-RateLimit-Limit"))
}

// Sanity: at the near-reset-second boundary, the limiter eventually refills.
// We don't want to rely on wall clock in tests, but we can assert that the
// reset header is non-empty when the limit is consumed.
func TestTicket0132Scopes_ResetHeaderOnReject(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := ApprovalDecideRateLimit(store, 1)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	req1 := withTestUser(httptest.NewRequest(http.MethodPost, "/decide", nil), 42)
	handler.ServeHTTP(httptest.NewRecorder(), req1)

	req2 := withTestUser(httptest.NewRequest(http.MethodPost, "/decide", nil), 42)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	require.Equal(t, http.StatusTooManyRequests, rec2.Code)

	resetHeader := rec2.Header().Get("X-RateLimit-Reset")
	require.NotEmpty(t, resetHeader)

	// Parse the header to confirm it's in the future (within a minute).
	nowUnix := time.Now().Unix()
	var reset int64
	_, err := parseUnixHeader(resetHeader, &reset)
	require.NoError(t, err)
	assert.True(t, reset >= nowUnix, "reset header must not be in the past")
	assert.True(t, reset <= nowUnix+61, "reset header must be within refill window")
}

func TestTicket0132Scopes_RejectObserverGetsScope(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	got := make([]string, 0, 1)
	mw := WorkspaceTerminalOpenRateLimitWithObserver(store, 1, func(scope string) {
		got = append(got, scope)
	})
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	req1 := withTestUser(httptest.NewRequest(http.MethodGet, "/api/repos/x/y/workspace/sessions/s/terminal", nil), 55)
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	require.Equal(t, http.StatusNoContent, rec1.Code)
	require.Empty(t, got, "observer must not fire on allowed request")

	req2 := withTestUser(httptest.NewRequest(http.MethodGet, "/api/repos/x/y/workspace/sessions/s/terminal", nil), 55)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	require.Equal(t, http.StatusTooManyRequests, rec2.Code)
	require.Equal(t, []string{WorkspaceTerminalOpenRateLimitScope}, got)
}

// parseUnixHeader parses a decimal Unix timestamp. We roll our own to
// avoid an extra strconv import in the test file.
func parseUnixHeader(s string, out *int64) (int, error) {
	var v int64
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return n, http.ErrNoCookie
		}
		v = v*10 + int64(r-'0')
		n++
	}
	*out = v
	return n, nil
}
