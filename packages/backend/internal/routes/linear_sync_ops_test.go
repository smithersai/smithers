package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type fakeLinearSyncOperationsRouteService struct {
	listFn  func(context.Context, int64, int64, services.LinearSyncOpsFilter) (services.LinearSyncOpsPage, error)
	retryFn func(context.Context, int64, int64, int64) (services.LinearSyncOp, error)
	startFn func(context.Context, int64, int64) (int64, error)
	getFn   func(context.Context, int64, int64, int64) (services.LinearSyncRunStatus, error)
}

func (f *fakeLinearSyncOperationsRouteService) ListSyncOps(ctx context.Context, userID, integrationID int64, filter services.LinearSyncOpsFilter) (services.LinearSyncOpsPage, error) {
	return f.listFn(ctx, userID, integrationID, filter)
}

func (f *fakeLinearSyncOperationsRouteService) RetrySyncOp(ctx context.Context, userID, integrationID, opID int64) (services.LinearSyncOp, error) {
	return f.retryFn(ctx, userID, integrationID, opID)
}

func (f *fakeLinearSyncOperationsRouteService) StartInitialSyncRun(ctx context.Context, userID, integrationID int64) (int64, error) {
	return f.startFn(ctx, userID, integrationID)
}

func (f *fakeLinearSyncOperationsRouteService) GetInitialSyncRun(ctx context.Context, userID, integrationID, runID int64) (services.LinearSyncRunStatus, error) {
	return f.getFn(ctx, userID, integrationID, runID)
}

func linearSyncOpsRequest(method, target string, params map[string]string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	req = withRouteParams(req, params)
	return withUser(req, &db.User{ID: 7, Username: "alice"})
}

func TestLinearIntegrationHandler_ListLinearSyncOps(t *testing.T) {
	since := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	createdAt := since.Add(time.Hour)
	service := &fakeLinearSyncOperationsRouteService{
		listFn: func(_ context.Context, userID, integrationID int64, filter services.LinearSyncOpsFilter) (services.LinearSyncOpsPage, error) {
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, int64(12), integrationID)
			assert.Equal(t, "failed", filter.Status)
			require.NotNil(t, filter.Since)
			assert.True(t, since.Equal(*filter.Since))
			assert.Equal(t, int32(25), filter.Limit)
			assert.Equal(t, "current-token", filter.Cursor)
			return services.LinearSyncOpsPage{Ops: []services.LinearSyncOp{{
				ID: 91, Source: "jjhub", Target: "linear", Entity: "issue", EntityID: "44",
				Action: "update", Status: "failed", ErrorMessage: "Linear API: 422 label 'infra' does not exist", CreatedAt: createdAt,
			}}, NextCursor: "older-token"}, nil
		},
	}
	handler := &LinearIntegrationHandler{SyncOperations: service}
	req := linearSyncOpsRequest(http.MethodGet, "/api/linear/12/ops?status=failed&since=2026-09-01T12:00:00Z&cursor=current-token&limit=25", map[string]string{"id": "12"})
	rec := httptest.NewRecorder()
	handler.ListLinearSyncOps(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "25", rec.Header().Get("X-Per-Page"))
	assert.Contains(t, rec.Header().Get("Link"), "cursor=older-token")
	var body []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, "Linear API: 422 label 'infra' does not exist", body[0]["error_message"])
	_, exposedPayload := body[0]["payload"]
	assert.False(t, exposedPayload, "private replay payload must never be exposed")
}

func TestLinearIntegrationHandler_ListLinearSyncOpsValidatesFilters(t *testing.T) {
	handler := &LinearIntegrationHandler{SyncOperations: &fakeLinearSyncOperationsRouteService{}}
	for _, target := range []string{
		"/api/linear/12/ops?status=running",
		"/api/linear/12/ops?since=yesterday",
		"/api/linear/12/ops?limit=zero",
	} {
		req := linearSyncOpsRequest(http.MethodGet, target, map[string]string{"id": "12"})
		rec := httptest.NewRecorder()
		handler.ListLinearSyncOps(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code, target)
	}
}

func TestLinearIntegrationHandler_RetryAndSyncRun(t *testing.T) {
	startedAt := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	service := &fakeLinearSyncOperationsRouteService{
		retryFn: func(_ context.Context, userID, integrationID, opID int64) (services.LinearSyncOp, error) {
			assert.Equal(t, []int64{7, 12, 91}, []int64{userID, integrationID, opID})
			original := int64(91)
			return services.LinearSyncOp{ID: 92, RetryOfID: &original, Status: "pending"}, nil
		},
		startFn: func(_ context.Context, userID, integrationID int64) (int64, error) {
			assert.Equal(t, []int64{7, 12}, []int64{userID, integrationID})
			return 33, nil
		},
		getFn: func(_ context.Context, userID, integrationID, runID int64) (services.LinearSyncRunStatus, error) {
			assert.Equal(t, []int64{7, 12, 33}, []int64{userID, integrationID, runID})
			return services.LinearSyncRunStatus{
				State: "running", StartedAt: &startedAt,
				Counts: services.LinearSyncCounts{
					Issues:   services.LinearSyncCount{Done: 4, Total: 10, Failed: 1},
					Comments: services.LinearSyncCount{Done: 2, Total: 3, Failed: 0},
				},
			}, nil
		},
	}
	handler := &LinearIntegrationHandler{SyncOperations: service}

	retryRec := httptest.NewRecorder()
	handler.RetryLinearSyncOp(retryRec, linearSyncOpsRequest(http.MethodPost, "/api/linear/12/ops/91/retry", map[string]string{"id": "12", "opId": "91"}))
	require.Equal(t, http.StatusAccepted, retryRec.Code)
	assert.Contains(t, retryRec.Body.String(), `"retry_of_id":91`)
	assert.Contains(t, retryRec.Body.String(), `"status":"pending"`)

	startRec := httptest.NewRecorder()
	handler.StartLinearSyncRun(startRec, linearSyncOpsRequest(http.MethodPost, "/api/linear/12/sync", map[string]string{"id": "12"}))
	require.Equal(t, http.StatusAccepted, startRec.Code)
	assert.JSONEq(t, `{"run_id":33}`, startRec.Body.String())

	getRec := httptest.NewRecorder()
	handler.GetLinearSyncRun(getRec, linearSyncOpsRequest(http.MethodGet, "/api/linear/12/sync/33", map[string]string{"id": "12", "runId": "33"}))
	require.Equal(t, http.StatusOK, getRec.Code)
	assert.JSONEq(t, `{
		"state":"running",
		"counts":{"issues":{"done":4,"total":10,"failed":1},"comments":{"done":2,"total":3,"failed":0}},
		"started_at":"2026-09-02T12:00:00Z",
		"finished_at":null
	}`, getRec.Body.String())
}
