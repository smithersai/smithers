package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockStackRouteService struct {
	getActiveStackFn    func(ctx context.Context, viewer *db.User, owner, repo, targetRef string) (services.StackResponse, error)
	upsertActiveStackFn func(ctx context.Context, actor *db.User, owner, repo string, input services.UpsertActiveStackInput) (services.StackResponse, error)
	deleteActiveStackFn func(ctx context.Context, actor *db.User, owner, repo, targetRef string) error
}

func (m *mockStackRouteService) GetActiveStack(ctx context.Context, viewer *db.User, owner, repo, targetRef string) (services.StackResponse, error) {
	if m.getActiveStackFn != nil {
		return m.getActiveStackFn(ctx, viewer, owner, repo, targetRef)
	}
	return services.StackResponse{}, nil
}

func (m *mockStackRouteService) UpsertActiveStack(ctx context.Context, actor *db.User, owner, repo string, input services.UpsertActiveStackInput) (services.StackResponse, error) {
	if m.upsertActiveStackFn != nil {
		return m.upsertActiveStackFn(ctx, actor, owner, repo, input)
	}
	return services.StackResponse{}, nil
}

func (m *mockStackRouteService) DeleteActiveStack(ctx context.Context, actor *db.User, owner, repo, targetRef string) error {
	if m.deleteActiveStackFn != nil {
		return m.deleteActiveStackFn(ctx, actor, owner, repo, targetRef)
	}
	return nil
}

func TestStackHandler_GetActiveStack(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC)
	h := &StackHandler{
		Service: &mockStackRouteService{
			getActiveStackFn: func(ctx context.Context, viewer *db.User, owner, repo, targetRef string) (services.StackResponse, error) {
				assert.Equal(t, int64(42), viewer.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "main", targetRef)
				return services.StackResponse{
					ID:        7,
					TargetRef: "main",
					State:     "active",
					CreatedAt: now,
					UpdatedAt: now,
					Changes: []services.StackChangeResponse{
						{
							ChangeID:   "qabc1234",
							BranchName: "smithers/qabc1234",
							Position:   0,
						},
					},
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/stacks/active?target_ref=main", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()
	h.GetActiveStack(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var response services.StackResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.Equal(t, int64(7), response.ID)
	assert.Equal(t, "main", response.TargetRef)
	require.Len(t, response.Changes, 1)
	assert.Equal(t, "qabc1234", response.Changes[0].ChangeID)
}

func TestStackHandler_UpsertActiveStack(t *testing.T) {
	t.Parallel()

	h := &StackHandler{
		Service: &mockStackRouteService{
			upsertActiveStackFn: func(ctx context.Context, actor *db.User, owner, repo string, input services.UpsertActiveStackInput) (services.StackResponse, error) {
				assert.Equal(t, int64(42), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "main", input.TargetRef)
				require.Len(t, input.Changes, 1)
				assert.Equal(t, "qabc1234", input.Changes[0].ChangeID)
				assert.Equal(t, "smithers/qabc1234", input.Changes[0].BranchName)
				return services.StackResponse{
					ID:        9,
					TargetRef: input.TargetRef,
					State:     "active",
				}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/stacks/active", strings.NewReader(`{
		"target_ref":"main",
		"changes":[{"change_id":"qabc1234","branch_name":"smithers/qabc1234","position":0}]
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()
	h.UpsertActiveStack(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var response services.StackResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.Equal(t, int64(9), response.ID)
	assert.Equal(t, "main", response.TargetRef)
}

func TestStackHandler_GetActiveStack_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &StackHandler{Service: &mockStackRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/stacks/active?target_ref=main", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.GetActiveStack(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestStackHandler_UpsertActiveStack_ServiceError(t *testing.T) {
	t.Parallel()

	h := &StackHandler{
		Service: &mockStackRouteService{
			upsertActiveStackFn: func(ctx context.Context, actor *db.User, owner, repo string, input services.UpsertActiveStackInput) (services.StackResponse, error) {
				return services.StackResponse{}, pkgerrors.Forbidden("permission denied")
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/stacks/active", strings.NewReader(`{"target_ref":"main","changes":[]}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()

	h.UpsertActiveStack(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestStackHandler_DeleteActiveStack(t *testing.T) {
	t.Parallel()

	h := &StackHandler{
		Service: &mockStackRouteService{
			deleteActiveStackFn: func(ctx context.Context, actor *db.User, owner, repo, targetRef string) error {
				assert.Equal(t, int64(42), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "main", targetRef)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/stacks/active?target_ref=main", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()
	h.DeleteActiveStack(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestStackHandler_DeleteActiveStack_ServiceError(t *testing.T) {
	t.Parallel()

	h := &StackHandler{
		Service: &mockStackRouteService{
			deleteActiveStackFn: func(ctx context.Context, actor *db.User, owner, repo, targetRef string) error {
				return pkgerrors.Forbidden("permission denied")
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/stacks/active?target_ref=main", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 42, "alice")
	rec := httptest.NewRecorder()

	h.DeleteActiveStack(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)
}
