//go:build integration
// +build integration

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestDevtoolsSnapshots(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "snapshots_user")
	repo := routesIntegrationCreateRepo(t, pool, user, "snapshots_repo", false)
	server, anonymousClient := setupRoutesIntegrationServer(t, queries, routesIntegrationServerOptions{
		includeDevtools: true,
	})
	authClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))

	session := routesIntegrationCreateAgentSession(t, queries, repo, user)
	sessionID := session.ID
	workspaceID := uuid.NewString()

	createPayload, err := json.Marshal(map[string]any{
		"kind":         "console",
		"session_id":   sessionID,
		"workspace_id": workspaceID,
		"payload": map[string]any{
			"lines": []string{"hello", "world"},
		},
	})
	require.NoError(t, err)

	createResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/devtools/snapshots",
		createPayload,
	)
	require.Equal(t, http.StatusCreated, createResp.StatusCode)

	var created struct {
		ID        string    `json:"id"`
		CreatedAt time.Time `json:"created_at"`
	}
	routesIntegrationDecodeJSON(t, createResp, &created)
	require.Equal(t, sessionID+":command_output", created.ID)
	require.False(t, created.CreatedAt.IsZero())

	getResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodGet,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/devtools/snapshots/latest?session_id="+sessionID+"&kind=console",
		nil,
	)
	require.Equal(t, http.StatusOK, getResp.StatusCode)

	var latest struct {
		Snapshots []struct {
			ID           string          `json:"id"`
			SessionID    string          `json:"session_id"`
			RepositoryID int64           `json:"repository_id"`
			Kind         string          `json:"kind"`
			WorkspaceID  *string         `json:"workspace_id"`
			Payload      json.RawMessage `json:"payload"`
		} `json:"snapshots"`
	}
	routesIntegrationDecodeJSON(t, getResp, &latest)

	require.Len(t, latest.Snapshots, 1)
	require.Equal(t, created.ID, latest.Snapshots[0].ID)
	require.Equal(t, sessionID, latest.Snapshots[0].SessionID)
	require.Equal(t, repo.ID, latest.Snapshots[0].RepositoryID)
	require.Equal(t, "command_output", latest.Snapshots[0].Kind)
	require.NotNil(t, latest.Snapshots[0].WorkspaceID)
	require.Equal(t, workspaceID, *latest.Snapshots[0].WorkspaceID)
	require.JSONEq(t, `{"lines":["hello","world"],"workspace_id":"`+workspaceID+`"}`, string(latest.Snapshots[0].Payload))

	t.Run("cannot rebind a snapshot to another repository", func(t *testing.T) {
		otherRepo := routesIntegrationCreateRepo(t, pool, user, "other_snapshots_repo", false)
		resp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodPost,
			"/api/repos/"+otherRepo.Owner+"/"+otherRepo.Name+"/devtools/snapshots", createPayload)
		require.Equal(t, http.StatusNotFound, resp.StatusCode)
		var body pkgerrors.APIError
		routesIntegrationDecodeJSON(t, resp, &body)
		require.Equal(t, pkgerrors.CodeNotFound, body.Code)
		require.Equal(t, "agent session not found", body.Message)

		stored, err := queries.GetDevtoolsSnapshot(context.Background(), db.GetDevtoolsSnapshotParams{
			SessionID: sessionID,
			Kind:      "command_output",
		})
		require.NoError(t, err)
		require.Equal(t, repo.ID, stored.RepositoryID)
		require.JSONEq(t, string(latest.Snapshots[0].Payload), string(stored.Payload))
	})

	t.Run("unknown session is not created by snapshot upload", func(t *testing.T) {
		unknownSessionID := uuid.NewString()
		payload := []byte(`{"kind":"console","session_id":"` + unknownSessionID + `","payload":{"lines":["unknown"]}}`)
		resp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodPost,
			"/api/repos/"+repo.Owner+"/"+repo.Name+"/devtools/snapshots", payload)
		require.Equal(t, http.StatusNotFound, resp.StatusCode)
		var body pkgerrors.APIError
		routesIntegrationDecodeJSON(t, resp, &body)
		require.Equal(t, pkgerrors.CodeNotFound, body.Code)
		require.Equal(t, "agent session not found", body.Message)

		_, err := queries.GetDevtoolsSnapshot(context.Background(), db.GetDevtoolsSnapshotParams{
			SessionID: unknownSessionID,
			Kind:      "command_output",
		})
		require.ErrorIs(t, err, pgx.ErrNoRows)
	})

	notFoundResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodGet,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/devtools/snapshots/latest?session_id="+sessionID+"&kind=screenshot",
		nil,
	)
	require.Equal(t, http.StatusNotFound, notFoundResp.StatusCode)
	_ = routesIntegrationReadBody(t, notFoundResp)

	oversizedPayload, err := json.Marshal(map[string]any{
		"kind":       "tool_state",
		"session_id": sessionID,
		"payload": map[string]any{
			"blob": strings.Repeat("x", devtoolsSnapshotPayloadMaxBytes),
		},
	})
	require.NoError(t, err)

	tooLargeResp := routesIntegrationDoRequest(
		t,
		authClient,
		server.URL,
		http.MethodPost,
		"/api/repos/"+repo.Owner+"/"+repo.Name+"/devtools/snapshots",
		oversizedPayload,
	)
	require.Equal(t, http.StatusRequestEntityTooLarge, tooLargeResp.StatusCode)
	_ = routesIntegrationReadBody(t, tooLargeResp)

	publicRepo := routesIntegrationCreateRepo(t, pool, user, "public_snapshots_repo", true)
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
			resp := routesIntegrationDoRequest(t, anonymousClient, server.URL, http.MethodPost,
				"/api/repos/"+tc.repo.Owner+"/"+tc.repo.Name+"/devtools/snapshots", createPayload)
			require.Equal(t, tc.status, resp.StatusCode)
			var body pkgerrors.APIError
			routesIntegrationDecodeJSON(t, resp, &body)
			require.Equal(t, tc.code, body.Code)
			require.Equal(t, tc.message, body.Message)
		})
	}
}
