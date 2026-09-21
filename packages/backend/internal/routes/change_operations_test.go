package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type changeOperationRouteStub struct {
	listRevision *int64
	preview      services.OperationUndoPreview
	undo         services.OperationUndoResponse
}

func (s *changeOperationRouteStub) ListOperations(_ context.Context, repositoryID int64, changeID string, revision *int64) ([]services.ChangeOperationResponse, error) {
	s.listRevision = revision
	return []services.ChangeOperationResponse{{OperationID: "op-a", ChangeIDs: []string{changeID}}}, nil
}

func (s *changeOperationRouteStub) PreviewUndo(context.Context, int64, int64, string, string) (services.OperationUndoPreview, error) {
	return s.preview, nil
}

func (s *changeOperationRouteStub) Undo(context.Context, int64, int64, string, string, string, string) (services.OperationUndoResponse, error) {
	return s.undo, nil
}

func TestJJVCSHandlerListChangeOperationsForRevision(t *testing.T) {
	service := &changeOperationRouteStub{}
	handler := &JJVCSHandler{RepoResolver: jjVCSLegacyResolver{}, ChangeOperations: service}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/change-a/operations?rev=4", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "change-a"})
	recorder := httptest.NewRecorder()

	handler.ListChangeOperations(recorder, req)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.NotNil(t, service.listRevision)
	assert.Equal(t, int64(4), *service.listRevision)
	var body []services.ChangeOperationResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, "op-a", body[0].OperationID)
	assert.Equal(t, []string{"change-a"}, body[0].ChangeIDs)
}

func TestJJVCSHandlerListChangeOperationsRejectsInvalidRevision(t *testing.T) {
	handler := &JJVCSHandler{RepoResolver: jjVCSLegacyResolver{}, ChangeOperations: &changeOperationRouteStub{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/change-a/operations?rev=nope", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "change-a"})
	recorder := httptest.NewRecorder()
	handler.ListChangeOperations(recorder, req)
	assert.Equal(t, http.StatusBadRequest, recorder.Code)
}

func TestJJVCSHandlerPreviewAndUndoOperation(t *testing.T) {
	service := &changeOperationRouteStub{
		preview: services.OperationUndoPreview{AffectsChanges: []string{"a", "b"}, LaterOperations: 2, State: "clean"},
		undo:    services.OperationUndoResponse{OperationID: "undo-op", UndoneOperationID: "target", AffectsChanges: []string{"a", "b"}},
	}
	handler := &JJVCSHandler{RepoResolver: jjVCSLegacyResolver{}, ChangeOperations: service}
	request := func(method, path string) *http.Request {
		req := httptest.NewRequest(method, path, nil)
		req = withJJRouteParams(req, map[string]string{
			"owner": "alice", "repo": "demo", "id": "11111111-1111-4111-8111-111111111111", "op_id": "target",
		})
		ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 11, Username: "alice"}})
		return req.WithContext(ctx)
	}

	previewRecorder := httptest.NewRecorder()
	handler.PreviewOperationUndo(previewRecorder, request(http.MethodGet, "/preview"))
	require.Equal(t, http.StatusOK, previewRecorder.Code)
	assert.JSONEq(t, `{"affects_changes":["a","b"],"later_operations":2,"state":"clean"}`, previewRecorder.Body.String())

	undoRecorder := httptest.NewRecorder()
	handler.UndoOperation(undoRecorder, request(http.MethodPost, "/undo"))
	require.Equal(t, http.StatusOK, undoRecorder.Code)
	assert.Contains(t, undoRecorder.Body.String(), `"operation_id":"undo-op"`)
}
