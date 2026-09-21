//go:build integration
// +build integration

package routes

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestUserRepos(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	user := routesIntegrationCreateUser(t, pool, "repos_user")
	otherUser := routesIntegrationCreateUser(t, pool, "repos_other")
	oldRepo := routesIntegrationCreateRepo(t, pool, user, "old_repo", false)
	newRepo := routesIntegrationCreateRepo(t, pool, user, "new_repo", false)
	publicRepo := routesIntegrationCreateRepo(t, pool, otherUser, "public_repo", true)
	privateForeignRepo := routesIntegrationCreateRepo(t, pool, otherUser, "private_repo", false)

	server, anonymousClient := setupRoutesIntegrationServer(t, queries, routesIntegrationServerOptions{
		includeUserRepos: true,
	})
	authClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, user))

	resp := routesIntegrationDoRequest(t, authClient, server.URL, http.MethodGet, "/api/user/repos", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var body struct {
		Repos []struct {
			RepositoryID int64  `json:"repository_id"`
			Owner        string `json:"owner"`
			RepoOwner    string `json:"repo_owner"`
			Name         string `json:"name"`
			RepoName     string `json:"repo_name"`
			FullName     string `json:"full_name"`
		} `json:"repos"`
	}
	routesIntegrationDecodeJSON(t, resp, &body)

	require.Len(t, body.Repos, 3)
	reposByID := make(map[int64]struct {
		Owner     string
		RepoOwner string
		Name      string
		RepoName  string
		FullName  string
	}, len(body.Repos))
	for _, repo := range body.Repos {
		require.NotEqual(t, privateForeignRepo.ID, repo.RepositoryID)
		reposByID[repo.RepositoryID] = struct {
			Owner     string
			RepoOwner string
			Name      string
			RepoName  string
			FullName  string
		}{
			Owner:     repo.Owner,
			RepoOwner: repo.RepoOwner,
			Name:      repo.Name,
			RepoName:  repo.RepoName,
			FullName:  repo.FullName,
		}
	}

	require.Contains(t, reposByID, oldRepo.ID)
	require.Contains(t, reposByID, newRepo.ID)
	require.Contains(t, reposByID, publicRepo.ID)
	require.Equal(t, user.Username, reposByID[newRepo.ID].Owner)
	require.Equal(t, user.Username, reposByID[newRepo.ID].RepoOwner)
	require.Equal(t, newRepo.Name, reposByID[newRepo.ID].Name)
	require.Equal(t, newRepo.Name, reposByID[newRepo.ID].RepoName)
	require.Equal(t, user.Username+"/"+newRepo.Name, reposByID[newRepo.ID].FullName)

	unauthorizedResp := routesIntegrationDoRequest(t, anonymousClient, server.URL, http.MethodGet, "/api/user/repos", nil)
	require.Equal(t, http.StatusUnauthorized, unauthorizedResp.StatusCode)
	_ = routesIntegrationReadBody(t, unauthorizedResp)
}
