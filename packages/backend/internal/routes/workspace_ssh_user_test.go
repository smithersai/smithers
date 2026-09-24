package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// userSelectingWorkspaceService adds the ?user= surface to the route mock.
type userSelectingWorkspaceService struct {
	*mockWorkspaceRouteService
	asFn func(guestUser string) (services.WorkspaceSSHConnectionInfo, error)
}

func (m *userSelectingWorkspaceService) GetWorkspaceSSHConnectionInfoAs(ctx context.Context, workspaceID string, repositoryID, userID int64, guestUser string) (services.WorkspaceSSHConnectionInfo, error) {
	return m.asFn(guestUser)
}

func TestWorkspaceHandler_GetWorkspaceSSHConnectionInfo_UserQuerySelectsGuestUser(t *testing.T) {
	t.Parallel()

	svc := &userSelectingWorkspaceService{
		mockWorkspaceRouteService: &mockWorkspaceRouteService{},
		asFn: func(guestUser string) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{Username: guestUser}, nil
		},
	}
	h := &WorkspaceHandler{Service: svc}

	req := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/ssh?user=root", "", map[string]string{"owner": "alice", "repo": "demo", "id": "ws-1"}, true)
	rec := httptest.NewRecorder()
	h.GetWorkspaceSSHConnectionInfo(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var info services.WorkspaceSSHConnectionInfo
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &info))
	assert.Equal(t, "root", info.Username)
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

func TestWorkspaceHandler_GetWorkspaceSSHConnectionInfo_UserQueryWithoutSelectorIsTyped400(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}
	req := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/ssh?user=root", "", map[string]string{"owner": "alice", "repo": "demo", "id": "ws-1"}, true)
	rec := httptest.NewRecorder()
	h.GetWorkspaceSSHConnectionInfo(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "workspace_ssh_user_invalid")
}
