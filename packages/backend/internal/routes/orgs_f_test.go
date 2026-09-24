package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// orgsFOKService returns a mock whose every method succeeds with deterministic
// payloads, independently driving the success (2xx) path of every OrgHandler
// endpoint.
func orgsFOKService() mockOrgRouteService {
	return mockOrgRouteService{
		getOrgFn: func(context.Context, *db.User, string) (db.Organization, error) {
			return sampleOrg(), nil
		},
		createOrgFn: func(context.Context, *db.User, services.CreateOrgRequest) (db.Organization, error) {
			return sampleOrg(), nil
		},
		updateOrgFn: func(context.Context, *db.User, string, services.UpdateOrgRequest) (db.Organization, error) {
			return sampleOrg(), nil
		},
		addOrgMemberFn:    func(context.Context, *db.User, string, int64, string) error { return nil },
		removeOrgMemberFn: func(context.Context, *db.User, string, string) error { return nil },
		listOrgReposFn: func(context.Context, *db.User, string, int, int) ([]db.Repository, int64, error) {
			return []db.Repository{{ID: 1, Name: "r"}}, 1, nil
		},
		listOrgMembersFn: func(context.Context, *db.User, string, int, int) ([]db.ListOrgMembersRow, int64, error) {
			return []db.ListOrgMembersRow{{ID: 2, Username: "bob", Role: "member"}}, 1, nil
		},
		listOrgTeamsFn: func(context.Context, *db.User, string, int, int) ([]db.Team, int64, error) {
			return []db.Team{sampleTeam()}, 1, nil
		},
		createTeamFn: func(context.Context, *db.User, string, services.CreateTeamRequest) (db.Team, error) {
			return sampleTeam(), nil
		},
		getTeamFn: func(context.Context, *db.User, string, string) (db.Team, error) {
			return sampleTeam(), nil
		},
		updateTeamFn: func(context.Context, *db.User, string, string, services.UpdateTeamRequest) (db.Team, error) {
			return sampleTeam(), nil
		},
		deleteTeamFn: func(context.Context, *db.User, string, string) error { return nil },
		listTeamMembersFn: func(context.Context, *db.User, string, string, int, int) ([]db.User, int64, error) {
			return []db.User{{ID: 3, Username: "carol"}}, 1, nil
		},
		addTeamMemberFn:    func(context.Context, *db.User, string, string, string) error { return nil },
		removeTeamMemberFn: func(context.Context, *db.User, string, string, string) error { return nil },
		listTeamReposFn: func(context.Context, *db.User, string, string, int, int) ([]db.Repository, int64, error) {
			return []db.Repository{{ID: 1, Name: "r"}}, 1, nil
		},
		addTeamRepoFn:    func(context.Context, *db.User, string, string, string, string) error { return nil },
		removeTeamRepoFn: func(context.Context, *db.User, string, string, string, string) error { return nil },
	}
}

func TestOrgs_F_SuccessPaths(t *testing.T) {
	orgParam := map[string]string{"org": "acme"}
	teamParam := map[string]string{"org": "acme", "team": "backend"}
	memberParam := map[string]string{"org": "acme", "username": "bob"}
	teamMemberParam := map[string]string{"org": "acme", "team": "backend", "username": "carol"}
	teamRepoParam := map[string]string{"org": "acme", "team": "backend", "owner": "acme", "repo": "demo"}

	tests := []struct {
		name       string
		handler    func(*OrgHandler, http.ResponseWriter, *http.Request)
		method     string
		body       string
		params     map[string]string
		wantStatus int
	}{
		{"get org", (*OrgHandler).GetOrg, http.MethodGet, "", orgParam, http.StatusOK},
		{"post org", (*OrgHandler).PostOrg, http.MethodPost, `{"name":"acme"}`, nil, http.StatusCreated},
		{"patch org", (*OrgHandler).PatchOrg, http.MethodPatch, `{"description":"x"}`, orgParam, http.StatusOK},
		{"get org repos", (*OrgHandler).GetOrgRepos, http.MethodGet, "", orgParam, http.StatusOK},
		{"get org members", (*OrgHandler).GetOrgMembers, http.MethodGet, "", orgParam, http.StatusOK},
		{"post org member", (*OrgHandler).PostOrgMember, http.MethodPost, `{"user_id":11,"role":"member"}`, orgParam, http.StatusCreated},
		{"get org teams", (*OrgHandler).GetOrgTeams, http.MethodGet, "", orgParam, http.StatusOK},
		{"post org team", (*OrgHandler).PostOrgTeam, http.MethodPost, `{"name":"backend"}`, orgParam, http.StatusCreated},
		{"get org team", (*OrgHandler).GetOrgTeam, http.MethodGet, "", teamParam, http.StatusOK},
		{"patch org team", (*OrgHandler).PatchOrgTeam, http.MethodPatch, `{"permission":"read"}`, teamParam, http.StatusOK},
		{"delete org team", (*OrgHandler).DeleteOrgTeam, http.MethodDelete, "", teamParam, http.StatusNoContent},
		{"delete org member", (*OrgHandler).DeleteOrgMember, http.MethodDelete, "", memberParam, http.StatusNoContent},
		{"get org team members", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "", teamParam, http.StatusOK},
		{"put org team member", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "", teamMemberParam, http.StatusNoContent},
		{"delete org team member", (*OrgHandler).DeleteOrgTeamMember, http.MethodDelete, "", teamMemberParam, http.StatusNoContent},
		{"get org team repos", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "", teamParam, http.StatusOK},
		{"put org team repo", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "", teamRepoParam, http.StatusNoContent},
		{"delete org team repo", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "", teamRepoParam, http.StatusNoContent},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &OrgHandler{Service: orgsFOKService()}
			req := orgsHRequest(tt.method, "/x", tt.body, tt.params, true)
			rec := httptest.NewRecorder()

			tt.handler(h, rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

// TestOrgs_F_AuditBranches drives the AuditService != nil branches for the
// three handlers that emit audit events.
func TestOrgs_F_AuditBranches(t *testing.T) {
	audit := &orgsHAuditQuerier{}
	h := &OrgHandler{Service: orgsFOKService(), AuditService: services.NewAuditService(audit)}

	postRec := httptest.NewRecorder()
	h.PostOrg(postRec, orgsHRequest(http.MethodPost, "/x", `{"name":"acme"}`, nil, true))
	require.Equal(t, http.StatusCreated, postRec.Code)

	addRec := httptest.NewRecorder()
	h.PostOrgMember(addRec, orgsHRequest(http.MethodPost, "/x", `{"user_id":11,"role":"member"}`, map[string]string{"org": "acme"}, true))
	require.Equal(t, http.StatusCreated, addRec.Code)

	delRec := httptest.NewRecorder()
	h.DeleteOrgMember(delRec, orgsHRequest(http.MethodDelete, "/x", "", map[string]string{"org": "acme", "username": "bob"}, true))
	require.Equal(t, http.StatusNoContent, delRec.Code)

	require.Equal(t, 3, audit.calls)
}

// TestOrgs_F_GuardBranches exercises auth, missing-param, bad-body, invalid
// pagination, and service-error branches across the handlers.
func TestOrgs_F_GuardBranches(t *testing.T) {
	ok := orgsFOKService()
	errSvc := orgsHErrorService()
	orgParam := map[string]string{"org": "acme"}
	teamParam := map[string]string{"org": "acme", "team": "backend"}

	tests := []struct {
		name       string
		handler    func(*OrgHandler, http.ResponseWriter, *http.Request)
		method     string
		body       string
		params     map[string]string
		authed     bool
		service    mockOrgRouteService
		wantStatus int
	}{
		// missing org route param
		{"get org missing param", (*OrgHandler).GetOrg, http.MethodGet, "", nil, true, ok, http.StatusBadRequest},
		{"patch org missing param", (*OrgHandler).PatchOrg, http.MethodPatch, `{}`, nil, true, ok, http.StatusBadRequest},
		{"get org repos missing param", (*OrgHandler).GetOrgRepos, http.MethodGet, "", nil, true, ok, http.StatusBadRequest},
		// auth guards
		{"post org no auth", (*OrgHandler).PostOrg, http.MethodPost, `{"name":"acme"}`, nil, false, ok, http.StatusUnauthorized},
		{"patch org no auth", (*OrgHandler).PatchOrg, http.MethodPatch, `{}`, orgParam, false, ok, http.StatusUnauthorized},
		{"get members no auth", (*OrgHandler).GetOrgMembers, http.MethodGet, "", orgParam, false, ok, http.StatusUnauthorized},
		{"post member no auth", (*OrgHandler).PostOrgMember, http.MethodPost, `{}`, orgParam, false, ok, http.StatusUnauthorized},
		{"get teams no auth", (*OrgHandler).GetOrgTeams, http.MethodGet, "", orgParam, false, ok, http.StatusUnauthorized},
		{"post team no auth", (*OrgHandler).PostOrgTeam, http.MethodPost, `{}`, orgParam, false, ok, http.StatusUnauthorized},
		{"get team no auth", (*OrgHandler).GetOrgTeam, http.MethodGet, "", teamParam, false, ok, http.StatusUnauthorized},
		{"patch team no auth", (*OrgHandler).PatchOrgTeam, http.MethodPatch, `{}`, teamParam, false, ok, http.StatusUnauthorized},
		{"delete team no auth", (*OrgHandler).DeleteOrgTeam, http.MethodDelete, "", teamParam, false, ok, http.StatusUnauthorized},
		{"delete member no auth", (*OrgHandler).DeleteOrgMember, http.MethodDelete, "", orgParam, false, ok, http.StatusUnauthorized},
		{"team members no auth", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "", teamParam, false, ok, http.StatusUnauthorized},
		{"put team member no auth", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "", teamParam, false, ok, http.StatusUnauthorized},
		{"delete team member no auth", (*OrgHandler).DeleteOrgTeamMember, http.MethodDelete, "", teamParam, false, ok, http.StatusUnauthorized},
		{"team repos no auth", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "", teamParam, false, ok, http.StatusUnauthorized},
		{"put team repo no auth", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "", teamParam, false, ok, http.StatusUnauthorized},
		{"delete team repo no auth", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "", teamParam, false, ok, http.StatusUnauthorized},
		// missing org param after auth
		{"post member missing org", (*OrgHandler).PostOrgMember, http.MethodPost, `{}`, nil, true, ok, http.StatusBadRequest},
		{"get teams missing org", (*OrgHandler).GetOrgTeams, http.MethodGet, "", nil, true, ok, http.StatusBadRequest},
		{"post team missing org", (*OrgHandler).PostOrgTeam, http.MethodPost, `{}`, nil, true, ok, http.StatusBadRequest},
		{"get team missing org", (*OrgHandler).GetOrgTeam, http.MethodGet, "", nil, true, ok, http.StatusBadRequest},
		{"get team missing team", (*OrgHandler).GetOrgTeam, http.MethodGet, "", orgParam, true, ok, http.StatusBadRequest},
		{"patch team missing team", (*OrgHandler).PatchOrgTeam, http.MethodPatch, `{}`, orgParam, true, ok, http.StatusBadRequest},
		{"delete team missing team", (*OrgHandler).DeleteOrgTeam, http.MethodDelete, "", orgParam, true, ok, http.StatusBadRequest},
		{"delete member missing username", (*OrgHandler).DeleteOrgMember, http.MethodDelete, "", orgParam, true, ok, http.StatusBadRequest},
		{"team members missing team", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "", orgParam, true, ok, http.StatusBadRequest},
		{"put team member missing username", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "", teamParam, true, ok, http.StatusBadRequest},
		{"delete team member missing username", (*OrgHandler).DeleteOrgTeamMember, http.MethodDelete, "", teamParam, true, ok, http.StatusBadRequest},
		{"team repos missing team", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "", orgParam, true, ok, http.StatusBadRequest},
		{"put team repo missing owner", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "", teamParam, true, ok, http.StatusBadRequest},
		{"delete team repo missing owner", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "", teamParam, true, ok, http.StatusBadRequest},
		// invalid json body
		{"post org bad body", (*OrgHandler).PostOrg, http.MethodPost, "{", nil, true, ok, http.StatusBadRequest},
		{"patch org bad body", (*OrgHandler).PatchOrg, http.MethodPatch, "{", orgParam, true, ok, http.StatusBadRequest},
		{"post member bad body", (*OrgHandler).PostOrgMember, http.MethodPost, "{", orgParam, true, ok, http.StatusBadRequest},
		{"post team bad body", (*OrgHandler).PostOrgTeam, http.MethodPost, "{", orgParam, true, ok, http.StatusBadRequest},
		{"patch team bad body", (*OrgHandler).PatchOrgTeam, http.MethodPatch, "{", teamParam, true, ok, http.StatusBadRequest},
		// invalid pagination
		{"get repos bad pagination", (*OrgHandler).GetOrgRepos, http.MethodGet, "", orgParam, true, ok, http.StatusBadRequest},
		{"get members bad pagination", (*OrgHandler).GetOrgMembers, http.MethodGet, "", orgParam, true, ok, http.StatusBadRequest},
		{"get teams bad pagination", (*OrgHandler).GetOrgTeams, http.MethodGet, "", orgParam, true, ok, http.StatusBadRequest},
		{"team members bad pagination", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "", teamParam, true, ok, http.StatusBadRequest},
		{"team repos bad pagination", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "", teamParam, true, ok, http.StatusBadRequest},
		// service errors
		{"get org service error", (*OrgHandler).GetOrg, http.MethodGet, "", orgParam, true, errSvc, http.StatusNotFound},
		{"post org service error", (*OrgHandler).PostOrg, http.MethodPost, `{"name":"acme"}`, nil, true, errSvc, http.StatusNotFound},
		{"patch org service error", (*OrgHandler).PatchOrg, http.MethodPatch, `{}`, orgParam, true, errSvc, http.StatusNotFound},
		{"get repos service error", (*OrgHandler).GetOrgRepos, http.MethodGet, "", orgParam, true, errSvc, http.StatusNotFound},
		{"get members service error", (*OrgHandler).GetOrgMembers, http.MethodGet, "", orgParam, true, errSvc, http.StatusNotFound},
		{"post member service error", (*OrgHandler).PostOrgMember, http.MethodPost, `{"user_id":11}`, orgParam, true, errSvc, http.StatusNotFound},
		{"get teams service error", (*OrgHandler).GetOrgTeams, http.MethodGet, "", orgParam, true, errSvc, http.StatusNotFound},
		{"post team service error", (*OrgHandler).PostOrgTeam, http.MethodPost, `{"name":"backend"}`, orgParam, true, errSvc, http.StatusNotFound},
		{"get team service error", (*OrgHandler).GetOrgTeam, http.MethodGet, "", teamParam, true, errSvc, http.StatusNotFound},
		{"patch team service error", (*OrgHandler).PatchOrgTeam, http.MethodPatch, `{}`, teamParam, true, errSvc, http.StatusNotFound},
		{"delete team service error", (*OrgHandler).DeleteOrgTeam, http.MethodDelete, "", teamParam, true, errSvc, http.StatusNotFound},
		{"delete member service error", (*OrgHandler).DeleteOrgMember, http.MethodDelete, "", map[string]string{"org": "acme", "username": "bob"}, true, errSvc, http.StatusNotFound},
		{"team members service error", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "", teamParam, true, errSvc, http.StatusNotFound},
		{"put team member service error", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "", map[string]string{"org": "acme", "team": "backend", "username": "carol"}, true, errSvc, http.StatusNotFound},
		{"delete team member service error", (*OrgHandler).DeleteOrgTeamMember, http.MethodDelete, "", map[string]string{"org": "acme", "team": "backend", "username": "carol"}, true, errSvc, http.StatusNotFound},
		{"team repos service error", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "", teamParam, true, errSvc, http.StatusNotFound},
		{"put team repo service error", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "", map[string]string{"org": "acme", "team": "backend", "owner": "acme", "repo": "demo"}, true, errSvc, http.StatusNotFound},
		{"delete team repo service error", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "", map[string]string{"org": "acme", "team": "backend", "owner": "acme", "repo": "demo"}, true, errSvc, http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &OrgHandler{Service: tt.service}
			target := "/x"
			// Force invalid pagination for the pagination cases via a bad limit query.
			if tt.wantStatus == http.StatusBadRequest && (tt.name == "get repos bad pagination" ||
				tt.name == "get members bad pagination" || tt.name == "get teams bad pagination" ||
				tt.name == "team members bad pagination" || tt.name == "team repos bad pagination") {
				target = "/x?limit=bad"
			}
			req := orgsHRequest(tt.method, target, tt.body, tt.params, tt.authed)
			rec := httptest.NewRecorder()

			tt.handler(h, rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

func TestOrgs_F_MapHelpers(t *testing.T) {
	members := mapOrgMembersResponse([]db.ListOrgMembersRow{{ID: 1, Username: "u", DisplayName: "U", AvatarUrl: "a", Role: "admin"}})
	require.Len(t, members, 1)
	require.Equal(t, "admin", members[0].Role)

	teamMembers := mapTeamMembersResponse([]db.User{{ID: 2, Username: "t", DisplayName: "T", AvatarUrl: "b"}})
	require.Len(t, teamMembers, 1)
	require.Equal(t, "t", teamMembers[0].Username)
}

func TestOrgs_F_RouteHelpers(t *testing.T) {
	req := orgsHRequest(http.MethodGet, "/x", "", map[string]string{"org": "  acme  "}, false)
	val, err := routeParam(req, "org", "organization name is required")
	require.NoError(t, err)
	require.Equal(t, "acme", val)

	_, err = routeParam(req, "missing", "boom")
	require.Error(t, err)
	require.IsType(t, &apierrors.APIError{}, err)

	_, err = requireRouteUser(req)
	require.Error(t, err)

	authed := orgsHRequest(http.MethodGet, "/x", "", nil, true)
	u, err := requireRouteUser(authed)
	require.NoError(t, err)
	require.Equal(t, int64(10), u.ID)
}
