//go:build integration
// +build integration

package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestApprovals(t *testing.T) {
	t.Setenv("SMITHERS_APPROVALS_FLOW_ENABLED", "true")

	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "approvals_user")
	repo := routesIntegrationCreateRepo(t, pool, user, "approvals_repo", false)
	session := routesIntegrationCreateAgentSession(t, queries, repo, user)
	approveApproval := routesIntegrationCreateApproval(t, queries, session, "shell_command", "approve me")
	denyApproval := routesIntegrationCreateApproval(t, queries, session, "shell_command", "deny me")

	server, anonymousClient := setupRoutesIntegrationServer(t, queries, routesIntegrationServerOptions{
		approvalService: services.NewApprovalsService(queries),
	})
	authClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))

	listResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodGet,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/approvals",
		nil,
	)
	require.Equal(t, http.StatusOK, listResp.StatusCode)

	var listed []services.ApprovalResponse
	routesIntegrationDecodeJSON(t, listResp, &listed)
	require.Len(t, listed, 2)

	listedIDs := map[string]bool{}
	for _, item := range listed {
		listedIDs[item.ID] = true
	}
	require.True(t, listedIDs[approveApproval.ID])
	require.True(t, listedIDs[denyApproval.ID])

	detailResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodGet,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/approvals/"+approveApproval.ID,
		nil,
	)
	require.Equal(t, http.StatusOK, detailResp.StatusCode)

	var detail services.ApprovalResponse
	routesIntegrationDecodeJSON(t, detailResp, &detail)
	require.Equal(t, approveApproval.ID, detail.ID)
	require.Equal(t, "pending", detail.State)
	require.Equal(t, session.ID, detail.SessionID)
	require.Equal(t, repo.ID, detail.RepositoryID)

	for _, decision := range []string{"approve", "deny"} {
		t.Run("reject legacy decision "+decision, func(t *testing.T) {
			resp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodPost,
				"/api/repos/"+repo.Owner+"/"+repo.Name+"/approvals/"+approveApproval.ID+"/decide",
				[]byte(`{"decision":"`+decision+`"}`))
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			var body pkgerrors.APIError
			routesIntegrationDecodeJSON(t, resp, &body)
			require.Equal(t, pkgerrors.CodeBadRequest, body.Code)
			require.Equal(t, "decision must be 'approved' or 'rejected'", body.Message)
			stored, err := queries.GetApproval(context.Background(), approveApproval.ID)
			require.NoError(t, err)
			require.Equal(t, services.ApprovalStatePending, stored.State)
			require.False(t, stored.DecidedAt.Valid)
		})
	}

	approveResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/approvals/"+approveApproval.ID+"/decide",
		[]byte(`{"decision":"approved"}`),
	)
	require.Equal(t, http.StatusOK, approveResp.StatusCode)

	var approved services.ApprovalResponse
	routesIntegrationDecodeJSON(t, approveResp, &approved)
	require.Equal(t, approveApproval.ID, approved.ID)
	require.Equal(t, services.ApprovalStateApproved, approved.State)
	require.NotNil(t, approved.DecidedBy)
	require.Equal(t, user.ID, *approved.DecidedBy)
	require.NotNil(t, approved.DecidedAt)
	require.False(t, approved.DecidedAt.IsZero())

	repeatResp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/approvals/"+approveApproval.ID+"/decide",
		[]byte(`{"decision":"approved"}`))
	require.Equal(t, http.StatusOK, repeatResp.StatusCode)
	var repeated services.ApprovalResponse
	routesIntegrationDecodeJSON(t, repeatResp, &repeated)
	require.Equal(t, approved, repeated, "repeating a decision must preserve the original receipt")

	denyResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/approvals/"+denyApproval.ID+"/decide",
		[]byte(`{"decision":"rejected"}`),
	)
	require.Equal(t, http.StatusOK, denyResp.StatusCode)

	var denied services.ApprovalResponse
	routesIntegrationDecodeJSON(t, denyResp, &denied)
	require.Equal(t, denyApproval.ID, denied.ID)
	require.Equal(t, services.ApprovalStateRejected, denied.State)
	require.NotNil(t, denied.DecidedBy)
	require.Equal(t, user.ID, *denied.DecidedBy)
	require.NotNil(t, denied.DecidedAt)
	require.False(t, denied.DecidedAt.IsZero())

	conflictResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/approvals/"+approveApproval.ID+"/decide",
		[]byte(`{"decision":"rejected"}`),
	)
	require.Equal(t, http.StatusConflict, conflictResp.StatusCode)
	require.Contains(t, string(routesIntegrationReadBody(t, conflictResp)), "approval already decided")
	stored, err := queries.GetApproval(context.Background(), approveApproval.ID)
	require.NoError(t, err)
	require.Equal(t, services.ApprovalStateApproved, stored.State)
	require.True(t, stored.DecidedAt.Valid)
	require.Equal(t, *approved.DecidedAt, stored.DecidedAt.Time)

	publicRepo := routesIntegrationCreateRepo(t, pool, user, "public_approvals_repo", true)
	for _, tc := range []struct {
		name    string
		repo    routesIntegrationRepo
		status  int
		code    pkgerrors.Code
		message string
	}{
		{"private repository is masked", repo, http.StatusNotFound, pkgerrors.CodeNotFound, "repository not found"},
		{"public repository still requires auth", publicRepo, http.StatusUnauthorized, pkgerrors.CodeUnauthorized, "authentication required"},
	} {
		t.Run("anonymous "+tc.name, func(t *testing.T) {
			resp := routesIntegrationDoRequest(t, anonymousClient, server.URL, http.MethodGet,
				"/api/repos/"+tc.repo.Owner+"/"+tc.repo.Name+"/approvals", nil)
			require.Equal(t, tc.status, resp.StatusCode)
			var body pkgerrors.APIError
			routesIntegrationDecodeJSON(t, resp, &body)
			require.Equal(t, tc.code, body.Code)
			require.Equal(t, tc.message, body.Message)
		})
	}
}
