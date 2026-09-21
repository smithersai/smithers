package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type workflowRunCountStub struct {
	countFn func(context.Context, int64) (int, error)
}

func (s workflowRunCountStub) CountActiveWorkflowRunsForUser(ctx context.Context, userID int64) (int, error) {
	return s.countFn(ctx, userID)
}

func TestWorkflowRunCountHandler(t *testing.T) {
	t.Run("returns the authenticated user's authoritative active count", func(t *testing.T) {
		handler := &WorkflowRunCountHandler{Counter: workflowRunCountStub{
			countFn: func(_ context.Context, userID int64) (int, error) {
				require.Equal(t, int64(7), userID)
				return 4, nil
			},
		}}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/workflow-runs/active-count", nil), 7, "alice")
		rec := httptest.NewRecorder()

		handler.GetActiveWorkflowRunCount(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		assert.JSONEq(t, `{"active_count":4}`, rec.Body.String())
	})

	t.Run("requires authentication", func(t *testing.T) {
		handler := &WorkflowRunCountHandler{Counter: workflowRunCountStub{
			countFn: func(context.Context, int64) (int, error) {
				t.Fatal("counter must not run without an authenticated user")
				return 0, nil
			},
		}}
		rec := httptest.NewRecorder()

		handler.GetActiveWorkflowRunCount(
			rec,
			httptest.NewRequest(http.MethodGet, "/api/user/workflow-runs/active-count", nil),
		)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("fails honestly when the counter is unavailable", func(t *testing.T) {
		handler := &WorkflowRunCountHandler{}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/workflow-runs/active-count", nil), 7, "alice")
		rec := httptest.NewRecorder()

		handler.GetActiveWorkflowRunCount(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "workflow run counter unavailable")
	})

	t.Run("does not turn a database error into a zero count", func(t *testing.T) {
		handler := &WorkflowRunCountHandler{Counter: workflowRunCountStub{
			countFn: func(context.Context, int64) (int, error) {
				return 0, errors.New("database unavailable")
			},
		}}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/workflow-runs/active-count", nil), 7, "alice")
		rec := httptest.NewRecorder()

		handler.GetActiveWorkflowRunCount(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "failed to count active workflow runs")
	})
}
