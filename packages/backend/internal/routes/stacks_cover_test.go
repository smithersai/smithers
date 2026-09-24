package routes

import (
	"context"
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

func TestStacks_Cov_GetAndDecodeErrors(t *testing.T) {
	t.Parallel()

	t.Run("get propagates service error", func(t *testing.T) {
		h := &StackHandler{Service: &mockStackRouteService{
			getActiveStackFn: func(ctx context.Context, viewer *db.User, owner, repo, targetRef string) (services.StackResponse, error) {
				assert.Equal(t, int64(42), viewer.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "feature", targetRef)
				return services.StackResponse{}, pkgerrors.NotFound("active stack not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/stacks/active?target_ref=%20feature%20", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		h.GetActiveStack(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), "active stack not found")
	})

	t.Run("upsert rejects invalid json before service call", func(t *testing.T) {
		called := false
		h := &StackHandler{Service: &mockStackRouteService{
			upsertActiveStackFn: func(context.Context, *db.User, string, string, services.UpsertActiveStackInput) (services.StackResponse, error) {
				called = true
				return services.StackResponse{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/stacks/active", strings.NewReader(`{bad`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		h.UpsertActiveStack(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)
	})

	t.Run("delete fails when repo route param is missing", func(t *testing.T) {
		h := &StackHandler{Service: &mockStackRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice//stacks/active", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": ""})
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		h.DeleteActiveStack(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "repository name is required")
	})
}
