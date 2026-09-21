package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type orgsHAuditQuerier struct {
	calls int
	last  db.InsertAuditLogParams
}

func (q *orgsHAuditQuerier) InsertAuditLog(_ context.Context, arg db.InsertAuditLogParams) error {
	q.calls++
	q.last = arg
	return nil
}

func orgsHRequest(method, target, body string, params map[string]string, authed bool) *http.Request {
	var user *db.User
	if authed {
		user = &db.User{ID: 10, Username: "alice", LowerUsername: "alice"}
	}
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, params)
	if user != nil {
		req = withAuth(req, user.ID, user.Username)
	}
	return req
}

func orgsHErrorService() mockOrgRouteService {
	err := apierrors.NotFound("missing")
	return mockOrgRouteService{
		getOrgFn: func(context.Context, *db.User, string) (db.Organization, error) {
			return db.Organization{}, err
		},
		createOrgFn: func(context.Context, *db.User, services.CreateOrgRequest) (db.Organization, error) {
			return db.Organization{}, err
		},
		updateOrgFn: func(context.Context, *db.User, string, services.UpdateOrgRequest) (db.Organization, error) {
			return db.Organization{}, err
		},
		addOrgMemberFn: func(context.Context, *db.User, string, int64, string) error {
			return err
		},
		removeOrgMemberFn: func(context.Context, *db.User, string, string) error {
			return err
		},
		listOrgReposFn: func(context.Context, *db.User, string, int, int) ([]db.Repository, int64, error) {
			return nil, 0, err
		},
		listOrgMembersFn: func(context.Context, *db.User, string, int, int) ([]db.ListOrgMembersRow, int64, error) {
			return nil, 0, err
		},
		listOrgTeamsFn: func(context.Context, *db.User, string, int, int) ([]db.Team, int64, error) {
			return nil, 0, err
		},
		createTeamFn: func(context.Context, *db.User, string, services.CreateTeamRequest) (db.Team, error) {
			return db.Team{}, err
		},
		getTeamFn: func(context.Context, *db.User, string, string) (db.Team, error) {
			return db.Team{}, err
		},
		updateTeamFn: func(context.Context, *db.User, string, string, services.UpdateTeamRequest) (db.Team, error) {
			return db.Team{}, err
		},
		deleteTeamFn: func(context.Context, *db.User, string, string) error {
			return err
		},
		listTeamMembersFn: func(context.Context, *db.User, string, string, int, int) ([]db.User, int64, error) {
			return nil, 0, err
		},
		addTeamMemberFn: func(context.Context, *db.User, string, string, string) error {
			return err
		},
		removeTeamMemberFn: func(context.Context, *db.User, string, string, string) error {
			return err
		},
		listTeamReposFn: func(context.Context, *db.User, string, string, int, int) ([]db.Repository, int64, error) {
			return nil, 0, err
		},
		addTeamRepoFn: func(context.Context, *db.User, string, string, string, string) error {
			return err
		},
		removeTeamRepoFn: func(context.Context, *db.User, string, string, string, string) error {
			return err
		},
	}
}

func TestOrgs_H_AuditBranches(t *testing.T) {
	audit := &orgsHAuditQuerier{}
	h := &OrgHandler{
		Service: mockOrgRouteService{
			createOrgFn: func(context.Context, *db.User, services.CreateOrgRequest) (db.Organization, error) {
				return sampleOrg(), nil
			},
			addOrgMemberFn: func(context.Context, *db.User, string, int64, string) error {
				return nil
			},
			removeOrgMemberFn: func(context.Context, *db.User, string, string) error {
				return nil
			},
		},
		AuditService: services.NewAuditService(audit),
	}

	postOrgReq := orgsHRequest(http.MethodPost, "/api/orgs", `{"name":"acme"}`, nil, true)
	postOrgRec := httptest.NewRecorder()
	h.PostOrg(postOrgRec, postOrgReq)
	require.Equal(t, http.StatusCreated, postOrgRec.Code)
	require.Equal(t, 1, audit.calls)
	require.Equal(t, "org.create", audit.last.EventType)

	addReq := orgsHRequest(http.MethodPost, "/api/orgs/acme/members", `{"user_id":11,"role":"member"}`, map[string]string{"org": "acme"}, true)
	addRec := httptest.NewRecorder()
	h.PostOrgMember(addRec, addReq)
	require.Equal(t, http.StatusCreated, addRec.Code)
	require.Equal(t, 2, audit.calls)
	require.Equal(t, "org.member_add", audit.last.EventType)

	deleteReq := orgsHRequest(http.MethodDelete, "/api/orgs/acme/members/bob", "", map[string]string{"org": "acme", "username": "bob"}, true)
	deleteRec := httptest.NewRecorder()
	h.DeleteOrgMember(deleteRec, deleteReq)
	require.Equal(t, http.StatusNoContent, deleteRec.Code)
	require.Equal(t, 3, audit.calls)
	require.Equal(t, "org.member_remove", audit.last.EventType)
}

func TestOrgs_H_HandlerErrorBranches(t *testing.T) {
	defaultService := mockOrgRouteService{}
	errorService := orgsHErrorService()
	orgParam := map[string]string{"org": "acme"}
	teamParams := map[string]string{"org": "acme", "team": "backend"}
	memberParams := map[string]string{"org": "acme", "team": "backend", "username": "bob"}
	repoParams := map[string]string{"org": "acme", "team": "backend", "owner": "acme", "repo": "api"}

	tests := []struct {
		name       string
		handler    func(*OrgHandler, http.ResponseWriter, *http.Request)
		method     string
		target     string
		body       string
		params     map[string]string
		authed     bool
		service    mockOrgRouteService
		wantStatus int
	}{
		{"get org missing org", (*OrgHandler).GetOrg, http.MethodGet, "/x", "", map[string]string{"org": " "}, false, defaultService, http.StatusBadRequest},
		{"patch org missing org", (*OrgHandler).PatchOrg, http.MethodPatch, "/x", `{}`, map[string]string{"org": " "}, true, defaultService, http.StatusBadRequest},
		{"patch org invalid body", (*OrgHandler).PatchOrg, http.MethodPatch, "/x", "{", orgParam, true, defaultService, http.StatusBadRequest},
		{"patch org service error", (*OrgHandler).PatchOrg, http.MethodPatch, "/x", `{}`, orgParam, true, errorService, http.StatusNotFound},
		{"org repos missing org", (*OrgHandler).GetOrgRepos, http.MethodGet, "/x", "", map[string]string{"org": " "}, false, defaultService, http.StatusBadRequest},
		{"org repos service error", (*OrgHandler).GetOrgRepos, http.MethodGet, "/x", "", orgParam, false, errorService, http.StatusNotFound},
		{"org members no auth", (*OrgHandler).GetOrgMembers, http.MethodGet, "/x", "", orgParam, false, defaultService, http.StatusUnauthorized},
		{"org members missing org", (*OrgHandler).GetOrgMembers, http.MethodGet, "/x", "", map[string]string{"org": " "}, true, defaultService, http.StatusBadRequest},
		{"org members invalid pagination", (*OrgHandler).GetOrgMembers, http.MethodGet, "/x?limit=bad", "", orgParam, true, defaultService, http.StatusBadRequest},
		{"org members service error", (*OrgHandler).GetOrgMembers, http.MethodGet, "/x", "", orgParam, true, errorService, http.StatusNotFound},
		{"post org member no auth", (*OrgHandler).PostOrgMember, http.MethodPost, "/x", `{"user_id":11}`, orgParam, false, defaultService, http.StatusUnauthorized},
		{"post org member missing org", (*OrgHandler).PostOrgMember, http.MethodPost, "/x", `{"user_id":11}`, map[string]string{"org": " "}, true, defaultService, http.StatusBadRequest},
		{"post org member service error", (*OrgHandler).PostOrgMember, http.MethodPost, "/x", `{"user_id":11}`, orgParam, true, errorService, http.StatusNotFound},
		{"org teams missing org", (*OrgHandler).GetOrgTeams, http.MethodGet, "/x", "", map[string]string{"org": " "}, true, defaultService, http.StatusBadRequest},
		{"org teams invalid pagination", (*OrgHandler).GetOrgTeams, http.MethodGet, "/x?limit=bad", "", orgParam, true, defaultService, http.StatusBadRequest},
		{"org teams service error", (*OrgHandler).GetOrgTeams, http.MethodGet, "/x", "", orgParam, true, errorService, http.StatusNotFound},
		{"post team no auth", (*OrgHandler).PostOrgTeam, http.MethodPost, "/x", `{"name":"backend"}`, orgParam, false, defaultService, http.StatusUnauthorized},
		{"post team missing org", (*OrgHandler).PostOrgTeam, http.MethodPost, "/x", `{"name":"backend"}`, map[string]string{"org": " "}, true, defaultService, http.StatusBadRequest},
		{"post team invalid body", (*OrgHandler).PostOrgTeam, http.MethodPost, "/x", "{", orgParam, true, defaultService, http.StatusBadRequest},
		{"post team service error", (*OrgHandler).PostOrgTeam, http.MethodPost, "/x", `{"name":"backend"}`, orgParam, true, errorService, http.StatusNotFound},
		{"get team no auth", (*OrgHandler).GetOrgTeam, http.MethodGet, "/x", "", teamParams, false, defaultService, http.StatusUnauthorized},
		{"get team missing org", (*OrgHandler).GetOrgTeam, http.MethodGet, "/x", "", map[string]string{"org": " ", "team": "backend"}, true, defaultService, http.StatusBadRequest},
		{"get team service error", (*OrgHandler).GetOrgTeam, http.MethodGet, "/x", "", teamParams, true, errorService, http.StatusNotFound},
		{"patch team no auth", (*OrgHandler).PatchOrgTeam, http.MethodPatch, "/x", `{}`, teamParams, false, defaultService, http.StatusUnauthorized},
		{"patch team missing org", (*OrgHandler).PatchOrgTeam, http.MethodPatch, "/x", `{}`, map[string]string{"org": " ", "team": "backend"}, true, defaultService, http.StatusBadRequest},
		{"patch team missing team", (*OrgHandler).PatchOrgTeam, http.MethodPatch, "/x", `{}`, map[string]string{"org": "acme", "team": " "}, true, defaultService, http.StatusBadRequest},
		{"patch team invalid body", (*OrgHandler).PatchOrgTeam, http.MethodPatch, "/x", "{", teamParams, true, defaultService, http.StatusBadRequest},
		{"patch team service error", (*OrgHandler).PatchOrgTeam, http.MethodPatch, "/x", `{}`, teamParams, true, errorService, http.StatusNotFound},
		{"delete team no auth", (*OrgHandler).DeleteOrgTeam, http.MethodDelete, "/x", "", teamParams, false, defaultService, http.StatusUnauthorized},
		{"delete team missing org", (*OrgHandler).DeleteOrgTeam, http.MethodDelete, "/x", "", map[string]string{"org": " ", "team": "backend"}, true, defaultService, http.StatusBadRequest},
		{"delete team missing team", (*OrgHandler).DeleteOrgTeam, http.MethodDelete, "/x", "", map[string]string{"org": "acme", "team": " "}, true, defaultService, http.StatusBadRequest},
		{"delete team service error", (*OrgHandler).DeleteOrgTeam, http.MethodDelete, "/x", "", teamParams, true, errorService, http.StatusNotFound},
		{"delete org member no auth", (*OrgHandler).DeleteOrgMember, http.MethodDelete, "/x", "", map[string]string{"org": "acme", "username": "bob"}, false, defaultService, http.StatusUnauthorized},
		{"delete org member missing org", (*OrgHandler).DeleteOrgMember, http.MethodDelete, "/x", "", map[string]string{"org": " ", "username": "bob"}, true, defaultService, http.StatusBadRequest},
		{"delete org member missing username", (*OrgHandler).DeleteOrgMember, http.MethodDelete, "/x", "", map[string]string{"org": "acme", "username": " "}, true, defaultService, http.StatusBadRequest},
		{"team members no auth", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "/x", "", teamParams, false, defaultService, http.StatusUnauthorized},
		{"team members missing org", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "/x", "", map[string]string{"org": " ", "team": "backend"}, true, defaultService, http.StatusBadRequest},
		{"team members missing team", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "/x", "", map[string]string{"org": "acme", "team": " "}, true, defaultService, http.StatusBadRequest},
		{"team members invalid pagination", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "/x?limit=bad", "", teamParams, true, defaultService, http.StatusBadRequest},
		{"team members service error", (*OrgHandler).GetOrgTeamMembers, http.MethodGet, "/x", "", teamParams, true, errorService, http.StatusNotFound},
		{"put member no auth", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "/x", "", memberParams, false, defaultService, http.StatusUnauthorized},
		{"put member missing org", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "/x", "", map[string]string{"org": " ", "team": "backend", "username": "bob"}, true, defaultService, http.StatusBadRequest},
		{"put member missing team", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "/x", "", map[string]string{"org": "acme", "team": " ", "username": "bob"}, true, defaultService, http.StatusBadRequest},
		{"put member missing username", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "/x", "", map[string]string{"org": "acme", "team": "backend", "username": " "}, true, defaultService, http.StatusBadRequest},
		{"put member service error", (*OrgHandler).PutOrgTeamMember, http.MethodPut, "/x", "", memberParams, true, errorService, http.StatusNotFound},
		{"delete member no auth", (*OrgHandler).DeleteOrgTeamMember, http.MethodDelete, "/x", "", memberParams, false, defaultService, http.StatusUnauthorized},
		{"delete member missing org", (*OrgHandler).DeleteOrgTeamMember, http.MethodDelete, "/x", "", map[string]string{"org": " ", "team": "backend", "username": "bob"}, true, defaultService, http.StatusBadRequest},
		{"delete member missing team", (*OrgHandler).DeleteOrgTeamMember, http.MethodDelete, "/x", "", map[string]string{"org": "acme", "team": " ", "username": "bob"}, true, defaultService, http.StatusBadRequest},
		{"delete member missing username", (*OrgHandler).DeleteOrgTeamMember, http.MethodDelete, "/x", "", map[string]string{"org": "acme", "team": "backend", "username": " "}, true, defaultService, http.StatusBadRequest},
		{"team repos no auth", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "/x", "", teamParams, false, defaultService, http.StatusUnauthorized},
		{"team repos missing org", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "/x", "", map[string]string{"org": " ", "team": "backend"}, true, defaultService, http.StatusBadRequest},
		{"team repos missing team", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "/x", "", map[string]string{"org": "acme", "team": " "}, true, defaultService, http.StatusBadRequest},
		{"team repos invalid pagination", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "/x?limit=bad", "", teamParams, true, defaultService, http.StatusBadRequest},
		{"team repos service error", (*OrgHandler).GetOrgTeamRepos, http.MethodGet, "/x", "", teamParams, true, errorService, http.StatusNotFound},
		{"put repo no auth", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "/x", "", repoParams, false, defaultService, http.StatusUnauthorized},
		{"put repo missing org", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "/x", "", map[string]string{"org": " ", "team": "backend", "owner": "acme", "repo": "api"}, true, defaultService, http.StatusBadRequest},
		{"put repo missing team", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "/x", "", map[string]string{"org": "acme", "team": " ", "owner": "acme", "repo": "api"}, true, defaultService, http.StatusBadRequest},
		{"put repo missing repo", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "/x", "", map[string]string{"org": "acme", "team": "backend", "owner": "acme", "repo": " "}, true, defaultService, http.StatusBadRequest},
		{"put repo service error", (*OrgHandler).PutOrgTeamRepo, http.MethodPut, "/x", "", repoParams, true, errorService, http.StatusNotFound},
		{"delete repo no auth", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "/x", "", repoParams, false, defaultService, http.StatusUnauthorized},
		{"delete repo missing org", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "/x", "", map[string]string{"org": " ", "team": "backend", "owner": "acme", "repo": "api"}, true, defaultService, http.StatusBadRequest},
		{"delete repo missing team", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "/x", "", map[string]string{"org": "acme", "team": " ", "owner": "acme", "repo": "api"}, true, defaultService, http.StatusBadRequest},
		{"delete repo missing owner", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "/x", "", map[string]string{"org": "acme", "team": "backend", "owner": " ", "repo": "api"}, true, defaultService, http.StatusBadRequest},
		{"delete repo missing repo", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "/x", "", map[string]string{"org": "acme", "team": "backend", "owner": "acme", "repo": " "}, true, defaultService, http.StatusBadRequest},
		{"delete repo service error", (*OrgHandler).DeleteOrgTeamRepo, http.MethodDelete, "/x", "", repoParams, true, errorService, http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &OrgHandler{Service: tt.service}
			req := orgsHRequest(tt.method, tt.target, tt.body, tt.params, tt.authed)
			rec := httptest.NewRecorder()

			tt.handler(h, rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}
