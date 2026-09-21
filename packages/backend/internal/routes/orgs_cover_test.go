package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func orgsCovRequest(method, target, body string, params map[string]string, user *db.User) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	for k, v := range params {
		routeCtx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	if user != nil {
		ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: user})
	}
	return req.WithContext(ctx)
}

func TestOrgs_Cov_TeamMemberAndRepoRoutes(t *testing.T) {
	user := &db.User{ID: 10, Username: "alice", LowerUsername: "alice"}
	params := map[string]string{"org": "acme", "team": "backend", "username": "bob", "owner": "acme", "repo": "api"}
	svc := mockOrgRouteService{
		listOrgMembersFn: func(_ context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.ListOrgMembersRow, int64, error) {
			require.Equal(t, user.ID, viewer.ID)
			assert.Equal(t, "acme", orgName)
			assert.Equal(t, 2, page)
			assert.Equal(t, 2, perPage)
			return []db.ListOrgMembersRow{{ID: 11, Username: "bob", DisplayName: "Bob", AvatarUrl: "https://example/avatar.png", Role: "admin"}}, 3, nil
		},
		listOrgTeamsFn: func(_ context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Team, int64, error) {
			require.Equal(t, user.ID, viewer.ID)
			assert.Equal(t, "acme", orgName)
			return []db.Team{sampleTeam()}, 1, nil
		},
		createTeamFn: func(_ context.Context, actor *db.User, orgName string, req services.CreateTeamRequest) (db.Team, error) {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "backend", req.Name)
			assert.Equal(t, "write", req.Permission)
			return sampleTeam(), nil
		},
		getTeamFn: func(_ context.Context, viewer *db.User, orgName, teamName string) (db.Team, error) {
			require.Equal(t, user.ID, viewer.ID)
			assert.Equal(t, "backend", teamName)
			return sampleTeam(), nil
		},
		updateTeamFn: func(_ context.Context, actor *db.User, orgName, teamName string, req services.UpdateTeamRequest) (db.Team, error) {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "backend", teamName)
			assert.Equal(t, "admin", req.Permission)
			team := sampleTeam()
			team.Permission = "admin"
			return team, nil
		},
		deleteTeamFn: func(_ context.Context, actor *db.User, orgName, teamName string) error {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "backend", teamName)
			return nil
		},
		listTeamMembersFn: func(_ context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.User, int64, error) {
			require.Equal(t, user.ID, viewer.ID)
			assert.Equal(t, "backend", teamName)
			return []db.User{{ID: 11, Username: "bob", DisplayName: "Bob", AvatarUrl: "https://example/avatar.png"}}, 1, nil
		},
		addTeamMemberFn: func(_ context.Context, actor *db.User, orgName, teamName, username string) error {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "bob", username)
			return nil
		},
		removeTeamMemberFn: func(_ context.Context, actor *db.User, orgName, teamName, username string) error {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "bob", username)
			return nil
		},
		listTeamReposFn: func(_ context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.Repository, int64, error) {
			require.Equal(t, user.ID, viewer.ID)
			assert.Equal(t, "backend", teamName)
			return []db.Repository{sampleRepo()}, 1, nil
		},
		addTeamRepoFn: func(_ context.Context, actor *db.User, orgName, teamName, owner, repo string) error {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "api", repo)
			return nil
		},
		removeTeamRepoFn: func(_ context.Context, actor *db.User, orgName, teamName, owner, repo string) error {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "api", repo)
			return nil
		},
	}
	h := &OrgHandler{Service: svc}

	t.Run("org members and teams", func(t *testing.T) {
		membersReq := orgsCovRequest(http.MethodGet, "/api/orgs/acme/members?cursor=2&limit=2", "", params, user)
		membersRec := httptest.NewRecorder()
		h.GetOrgMembers(membersRec, membersReq)
		require.Equal(t, http.StatusOK, membersRec.Code)
		assert.Equal(t, "3", membersRec.Header().Get("X-Total-Count"))
		assert.Contains(t, membersRec.Body.String(), `"role":"admin"`)

		teamsReq := orgsCovRequest(http.MethodGet, "/api/orgs/acme/teams", "", params, user)
		teamsRec := httptest.NewRecorder()
		h.GetOrgTeams(teamsRec, teamsReq)
		require.Equal(t, http.StatusOK, teamsRec.Code)
		assert.Contains(t, teamsRec.Body.String(), `"name":"backend"`)
	})

	t.Run("team create get patch delete", func(t *testing.T) {
		createReq := orgsCovRequest(http.MethodPost, "/api/orgs/acme/teams", `{"name":"backend","permission":"write"}`, params, user)
		createRec := httptest.NewRecorder()
		h.PostOrgTeam(createRec, createReq)
		require.Equal(t, http.StatusCreated, createRec.Code)

		getReq := orgsCovRequest(http.MethodGet, "/api/orgs/acme/teams/backend", "", params, user)
		getRec := httptest.NewRecorder()
		h.GetOrgTeam(getRec, getReq)
		require.Equal(t, http.StatusOK, getRec.Code)

		patchReq := orgsCovRequest(http.MethodPatch, "/api/orgs/acme/teams/backend", `{"permission":"admin"}`, params, user)
		patchRec := httptest.NewRecorder()
		h.PatchOrgTeam(patchRec, patchReq)
		require.Equal(t, http.StatusOK, patchRec.Code)
		assert.Contains(t, patchRec.Body.String(), `"permission":"admin"`)

		deleteReq := orgsCovRequest(http.MethodDelete, "/api/orgs/acme/teams/backend", "", params, user)
		deleteRec := httptest.NewRecorder()
		h.DeleteOrgTeam(deleteRec, deleteReq)
		require.Equal(t, http.StatusNoContent, deleteRec.Code)
	})

	t.Run("team members", func(t *testing.T) {
		listReq := orgsCovRequest(http.MethodGet, "/api/orgs/acme/teams/backend/members", "", params, user)
		listRec := httptest.NewRecorder()
		h.GetOrgTeamMembers(listRec, listReq)
		require.Equal(t, http.StatusOK, listRec.Code)
		assert.Contains(t, listRec.Body.String(), `"username":"bob"`)

		putReq := orgsCovRequest(http.MethodPut, "/api/orgs/acme/teams/backend/members/bob", "", params, user)
		putRec := httptest.NewRecorder()
		h.PutOrgTeamMember(putRec, putReq)
		require.Equal(t, http.StatusNoContent, putRec.Code)

		deleteReq := orgsCovRequest(http.MethodDelete, "/api/orgs/acme/teams/backend/members/bob", "", params, user)
		deleteRec := httptest.NewRecorder()
		h.DeleteOrgTeamMember(deleteRec, deleteReq)
		require.Equal(t, http.StatusNoContent, deleteRec.Code)
	})

	t.Run("team repos", func(t *testing.T) {
		listReq := orgsCovRequest(http.MethodGet, "/api/orgs/acme/teams/backend/repos", "", params, user)
		listRec := httptest.NewRecorder()
		h.GetOrgTeamRepos(listRec, listReq)
		require.Equal(t, http.StatusOK, listRec.Code)
		assert.Contains(t, listRec.Body.String(), `"name":"repo"`)

		putReq := orgsCovRequest(http.MethodPut, "/api/orgs/acme/teams/backend/repos/acme/api", "", params, user)
		putRec := httptest.NewRecorder()
		h.PutOrgTeamRepo(putRec, putReq)
		require.Equal(t, http.StatusNoContent, putRec.Code)

		deleteReq := orgsCovRequest(http.MethodDelete, "/api/orgs/acme/teams/backend/repos/acme/api", "", params, user)
		deleteRec := httptest.NewRecorder()
		h.DeleteOrgTeamRepo(deleteRec, deleteReq)
		require.Equal(t, http.StatusNoContent, deleteRec.Code)
	})
}

func TestOrgs_Cov_OrgRoutesAndErrors(t *testing.T) {
	user := &db.User{ID: 10, Username: "alice", LowerUsername: "alice"}
	params := map[string]string{"org": "acme", "username": "bob", "team": "backend", "owner": "acme", "repo": "api"}
	svc := mockOrgRouteService{
		updateOrgFn: func(_ context.Context, actor *db.User, orgName string, req services.UpdateOrgRequest) (db.Organization, error) {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "acme", orgName)
			assert.Equal(t, "Acme Inc", req.Description)
			org := sampleOrg()
			org.Description = req.Description
			return org, nil
		},
		listOrgReposFn: func(_ context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Repository, int64, error) {
			assert.Equal(t, "acme", orgName)
			assert.Equal(t, 1, page)
			assert.Equal(t, 30, perPage)
			return []db.Repository{sampleRepo()}, 1, nil
		},
		addOrgMemberFn: func(_ context.Context, actor *db.User, orgName string, targetUserID int64, role string) error {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, int64(11), targetUserID)
			assert.Equal(t, "member", role)
			return nil
		},
		removeOrgMemberFn: func(_ context.Context, actor *db.User, orgName, username string) error {
			require.Equal(t, user.ID, actor.ID)
			assert.Equal(t, "bob", username)
			return nil
		},
		removeTeamMemberFn: func(context.Context, *db.User, string, string, string) error {
			return apierrors.NotFound("team member not found")
		},
		addTeamRepoFn: func(context.Context, *db.User, string, string, string, string) error {
			return nil
		},
	}
	h := &OrgHandler{Service: svc}

	t.Run("patch org", func(t *testing.T) {
		req := orgsCovRequest(http.MethodPatch, "/api/orgs/acme", `{"description":"Acme Inc"}`, params, user)
		rec := httptest.NewRecorder()
		h.PatchOrg(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"description":"Acme Inc"`)
	})

	t.Run("org repos", func(t *testing.T) {
		req := orgsCovRequest(http.MethodGet, "/api/orgs/acme/repos", "", params, nil)
		rec := httptest.NewRecorder()
		h.GetOrgRepos(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "1", rec.Header().Get("X-Total-Count"))
	})

	t.Run("org member add remove", func(t *testing.T) {
		addReq := orgsCovRequest(http.MethodPost, "/api/orgs/acme/members", `{"user_id":11,"role":"member"}`, params, user)
		addRec := httptest.NewRecorder()
		h.PostOrgMember(addRec, addReq)
		require.Equal(t, http.StatusCreated, addRec.Code)

		deleteReq := orgsCovRequest(http.MethodDelete, "/api/orgs/acme/members/bob", "", params, user)
		deleteRec := httptest.NewRecorder()
		h.DeleteOrgMember(deleteRec, deleteReq)
		require.Equal(t, http.StatusNoContent, deleteRec.Code)
	})

	t.Run("invalid bodies and pagination", func(t *testing.T) {
		postReq := orgsCovRequest(http.MethodPost, "/api/orgs/acme/members", "{", params, user)
		postRec := httptest.NewRecorder()
		h.PostOrgMember(postRec, postReq)
		require.Equal(t, http.StatusBadRequest, postRec.Code)

		pageReq := orgsCovRequest(http.MethodGet, "/api/orgs/acme/repos?page=0", "", params, nil)
		pageRec := httptest.NewRecorder()
		h.GetOrgRepos(pageRec, pageReq)
		require.Equal(t, http.StatusBadRequest, pageRec.Code)
	})

	t.Run("missing auth and params", func(t *testing.T) {
		noAuthReq := orgsCovRequest(http.MethodGet, "/api/orgs/acme/teams", "", params, nil)
		noAuthRec := httptest.NewRecorder()
		h.GetOrgTeams(noAuthRec, noAuthReq)
		require.Equal(t, http.StatusUnauthorized, noAuthRec.Code)

		missingTeamReq := orgsCovRequest(http.MethodGet, "/api/orgs/acme/teams/%20", "", map[string]string{"org": "acme", "team": " "}, user)
		missingTeamRec := httptest.NewRecorder()
		h.GetOrgTeam(missingTeamRec, missingTeamReq)
		require.Equal(t, http.StatusBadRequest, missingTeamRec.Code)
		assert.Contains(t, missingTeamRec.Body.String(), "team name is required")
	})

	t.Run("team member service error", func(t *testing.T) {
		req := orgsCovRequest(http.MethodDelete, "/api/orgs/acme/teams/backend/members/bob", "", params, user)
		rec := httptest.NewRecorder()
		h.DeleteOrgTeamMember(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("team repo missing owner", func(t *testing.T) {
		req := orgsCovRequest(http.MethodPut, "/api/orgs/acme/teams/backend/repos", "", map[string]string{"org": "acme", "team": "backend", "owner": " ", "repo": "api"}, user)
		rec := httptest.NewRecorder()
		h.PutOrgTeamRepo(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "owner is required")
	})
}
