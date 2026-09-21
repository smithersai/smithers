//go:build integration
// +build integration

package routes

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestUserWorkspaces(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "workspaces_user")
	oldRepo := routesIntegrationCreateRepo(t, pool, user, "old_repo", false)
	midRepo := routesIntegrationCreateRepo(t, pool, user, "mid_repo", false)
	newRepo := routesIntegrationCreateRepo(t, pool, user, "new_repo", false)

	baseTime := time.Date(2026, 4, 24, 12, 0, 0, 0, time.UTC)
	oldWorkspace := routesIntegrationCreateWorkspace(t, queries, pool, oldRepo, user, "old-workspace", baseTime.Add(-3*time.Hour))
	midWorkspace := routesIntegrationCreateWorkspace(t, queries, pool, midRepo, user, "mid-workspace", baseTime.Add(-2*time.Hour))
	newWorkspace := routesIntegrationCreateWorkspace(t, queries, pool, newRepo, user, "new-workspace", baseTime.Add(-1*time.Hour))

	server, anonymousClient := setupRoutesIntegrationServer(t, queries, routesIntegrationServerOptions{
		includeUserWorkspaces: true,
	})
	authClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))

	resp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodGet, "/api/user/workspaces", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var workspaces []struct {
		WorkspaceID     string     `json:"workspace_id"`
		RepositoryID    int64      `json:"repository_id"`
		RepositoryOwner string     `json:"repository_owner"`
		RepositoryName  string     `json:"repository_name"`
		WorkspaceTitle  string     `json:"workspace_title"`
		LastAccessedAt  *time.Time `json:"last_accessed_at"`
		SortTimestamp   time.Time  `json:"sort_timestamp"`
	}
	routesIntegrationDecodeJSON(t, resp, &workspaces)

	require.Equal(t, "3", resp.Header.Get("X-Total-Count"))
	require.Len(t, workspaces, 3)
	for i, want := range []struct {
		workspace db.Workspace
		repo      routesIntegrationRepo
	}{
		{newWorkspace, newRepo},
		{midWorkspace, midRepo},
		{oldWorkspace, oldRepo},
	} {
		got := workspaces[i]
		require.Equal(t, want.workspace.ID, got.WorkspaceID)
		require.Equal(t, want.repo.ID, got.RepositoryID)
		require.Equal(t, user.Username, got.RepositoryOwner)
		require.Equal(t, want.repo.Name, got.RepositoryName)
		require.Equal(t, want.workspace.Name, got.WorkspaceTitle)
		require.NotNil(t, got.LastAccessedAt)
		require.Equal(t, want.workspace.LastAccessedAt.Time, got.LastAccessedAt.UTC())
		require.Equal(t, want.workspace.LastAccessedAt.Time, got.SortTimestamp.UTC())
	}

	unauthorizedResp := routesIntegrationDoRequest(t, anonymousClient, server.URL, http.MethodGet, "/api/user/workspaces", nil)
	require.Equal(t, http.StatusUnauthorized, unauthorizedResp.StatusCode)
	_ = routesIntegrationReadBody(t, unauthorizedResp)
}

func TestUserWorkspaces_DoesNotMutateLastAccessedAt(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "workspaces_read_only")
	repo := routesIntegrationCreateRepo(t, pool, user, "workspace_read_only_repo", false)

	lastAccessed := time.Date(2026, 4, 24, 13, 30, 0, 0, time.UTC)
	workspace := routesIntegrationCreateWorkspace(t, queries, pool, repo, user, "read-only-workspace", lastAccessed)

	server, _ := setupRoutesIntegrationServer(t, queries, routesIntegrationServerOptions{
		includeUserWorkspaces: true,
	})
	authClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))

	resp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodGet, "/api/user/workspaces", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	_ = routesIntegrationReadBody(t, resp)

	after, err := queries.GetWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	require.True(t, after.LastAccessedAt.Valid, "fixture should keep last_accessed_at populated")
	require.Equal(t, lastAccessed, after.LastAccessedAt.Time.UTC(), "GET /api/user/workspaces must not rewrite recency")
}
