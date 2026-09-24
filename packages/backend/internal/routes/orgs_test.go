package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockOrgRouteService struct {
	getOrgFn           func(ctx context.Context, viewer *db.User, orgName string) (db.Organization, error)
	createOrgFn        func(ctx context.Context, actor *db.User, req services.CreateOrgRequest) (db.Organization, error)
	updateOrgFn        func(ctx context.Context, actor *db.User, orgName string, req services.UpdateOrgRequest) (db.Organization, error)
	addOrgMemberFn     func(ctx context.Context, actor *db.User, orgName string, targetUserID int64, role string) error
	removeOrgMemberFn  func(ctx context.Context, actor *db.User, orgName, username string) error
	listOrgReposFn     func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Repository, int64, error)
	listOrgMembersFn   func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.ListOrgMembersRow, int64, error)
	listOrgTeamsFn     func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Team, int64, error)
	createTeamFn       func(ctx context.Context, actor *db.User, orgName string, req services.CreateTeamRequest) (db.Team, error)
	getTeamFn          func(ctx context.Context, viewer *db.User, orgName, teamName string) (db.Team, error)
	updateTeamFn       func(ctx context.Context, actor *db.User, orgName, teamName string, req services.UpdateTeamRequest) (db.Team, error)
	deleteTeamFn       func(ctx context.Context, actor *db.User, orgName, teamName string) error
	listTeamMembersFn  func(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.User, int64, error)
	addTeamMemberFn    func(ctx context.Context, actor *db.User, orgName, teamName, username string) error
	removeTeamMemberFn func(ctx context.Context, actor *db.User, orgName, teamName, username string) error
	listTeamReposFn    func(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.Repository, int64, error)
	addTeamRepoFn      func(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error
	removeTeamRepoFn   func(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error
}

func (m mockOrgRouteService) GetOrg(ctx context.Context, viewer *db.User, orgName string) (db.Organization, error) {
	if m.getOrgFn != nil {
		return m.getOrgFn(ctx, viewer, orgName)
	}
	return db.Organization{}, nil
}

func (m mockOrgRouteService) CreateOrg(ctx context.Context, actor *db.User, req services.CreateOrgRequest) (db.Organization, error) {
	if m.createOrgFn != nil {
		return m.createOrgFn(ctx, actor, req)
	}
	return db.Organization{}, nil
}

func (m mockOrgRouteService) UpdateOrg(ctx context.Context, actor *db.User, orgName string, req services.UpdateOrgRequest) (db.Organization, error) {
	if m.updateOrgFn != nil {
		return m.updateOrgFn(ctx, actor, orgName, req)
	}
	return db.Organization{}, nil
}

func (m mockOrgRouteService) AddOrgMember(ctx context.Context, actor *db.User, orgName string, targetUserID int64, role string) error {
	if m.addOrgMemberFn != nil {
		return m.addOrgMemberFn(ctx, actor, orgName, targetUserID, role)
	}
	return nil
}

func (m mockOrgRouteService) RemoveOrgMember(ctx context.Context, actor *db.User, orgName, username string) error {
	if m.removeOrgMemberFn != nil {
		return m.removeOrgMemberFn(ctx, actor, orgName, username)
	}
	return nil
}

func (m mockOrgRouteService) ListOrgRepos(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Repository, int64, error) {
	if m.listOrgReposFn != nil {
		return m.listOrgReposFn(ctx, viewer, orgName, page, perPage)
	}
	return nil, 0, nil
}

func (m mockOrgRouteService) ListOrgMembers(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.ListOrgMembersRow, int64, error) {
	if m.listOrgMembersFn != nil {
		return m.listOrgMembersFn(ctx, viewer, orgName, page, perPage)
	}
	return nil, 0, nil
}

func (m mockOrgRouteService) ListOrgTeams(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Team, int64, error) {
	if m.listOrgTeamsFn != nil {
		return m.listOrgTeamsFn(ctx, viewer, orgName, page, perPage)
	}
	return nil, 0, nil
}

func (m mockOrgRouteService) CreateTeam(ctx context.Context, actor *db.User, orgName string, req services.CreateTeamRequest) (db.Team, error) {
	if m.createTeamFn != nil {
		return m.createTeamFn(ctx, actor, orgName, req)
	}
	return db.Team{}, nil
}

func (m mockOrgRouteService) GetTeam(ctx context.Context, viewer *db.User, orgName, teamName string) (db.Team, error) {
	if m.getTeamFn != nil {
		return m.getTeamFn(ctx, viewer, orgName, teamName)
	}
	return db.Team{}, nil
}

func (m mockOrgRouteService) UpdateTeam(ctx context.Context, actor *db.User, orgName, teamName string, req services.UpdateTeamRequest) (db.Team, error) {
	if m.updateTeamFn != nil {
		return m.updateTeamFn(ctx, actor, orgName, teamName, req)
	}
	return db.Team{}, nil
}

func (m mockOrgRouteService) DeleteTeam(ctx context.Context, actor *db.User, orgName, teamName string) error {
	if m.deleteTeamFn != nil {
		return m.deleteTeamFn(ctx, actor, orgName, teamName)
	}
	return nil
}

func (m mockOrgRouteService) ListTeamMembers(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.User, int64, error) {
	if m.listTeamMembersFn != nil {
		return m.listTeamMembersFn(ctx, viewer, orgName, teamName, page, perPage)
	}
	return nil, 0, nil
}

func (m mockOrgRouteService) AddTeamMember(ctx context.Context, actor *db.User, orgName, teamName, username string) error {
	if m.addTeamMemberFn != nil {
		return m.addTeamMemberFn(ctx, actor, orgName, teamName, username)
	}
	return nil
}

func (m mockOrgRouteService) RemoveTeamMember(ctx context.Context, actor *db.User, orgName, teamName, username string) error {
	if m.removeTeamMemberFn != nil {
		return m.removeTeamMemberFn(ctx, actor, orgName, teamName, username)
	}
	return nil
}

func (m mockOrgRouteService) ListTeamRepos(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.Repository, int64, error) {
	if m.listTeamReposFn != nil {
		return m.listTeamReposFn(ctx, viewer, orgName, teamName, page, perPage)
	}
	return nil, 0, nil
}

func (m mockOrgRouteService) AddTeamRepo(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error {
	if m.addTeamRepoFn != nil {
		return m.addTeamRepoFn(ctx, actor, orgName, teamName, owner, repo)
	}
	return nil
}

func (m mockOrgRouteService) RemoveTeamRepo(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error {
	if m.removeTeamRepoFn != nil {
		return m.removeTeamRepoFn(ctx, actor, orgName, teamName, owner, repo)
	}
	return nil
}

func withRouteParams(req *http.Request, params map[string]string) *http.Request {
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func withAuth(req *http.Request, userID int64, username string) *http.Request {
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: userID, Username: username, LowerUsername: username},
	}))
}

func withTokenAuth(req *http.Request, userID int64, username string, scopes ...middleware.TokenScope) *http.Request {
	scopeSet := make(middleware.ScopeSet)
	for _, scope := range scopes {
		scopeSet[scope] = struct{}{}
	}
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: userID, Username: username, LowerUsername: username},
		IsTokenAuth: true,
		Scopes:      scopeSet,
	}))
}

func sampleOrg() db.Organization {
	now := time.Now().UTC().Truncate(time.Second)
	return db.Organization{
		ID:          1,
		Name:        "acme",
		LowerName:   "acme",
		Description: "desc",
		Visibility:  "public",
		Website:     "",
		Location:    "",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func sampleTeam() db.Team {
	now := time.Now().UTC().Truncate(time.Second)
	return db.Team{
		ID:             5,
		OrganizationID: 1,
		Name:           "backend",
		LowerName:      "backend",
		Description:    "backend team",
		Permission:     "write",
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func sampleRepo() db.Repository {
	now := time.Now().UTC().Truncate(time.Second)
	return db.Repository{
		ID:              9,
		OrgID:           pgtype.Int8{Int64: 1, Valid: true},
		Name:            "repo",
		LowerName:       "repo",
		Description:     "",
		IsPublic:        true,
		DefaultBookmark: "main",
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}

func TestOrgHandler_GetOrg(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			getOrgFn: func(ctx context.Context, viewer *db.User, orgName string) (db.Organization, error) {
				require.Nil(t, viewer)
				assert.Equal(t, "acme", orgName)
				return sampleOrg(), nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme", nil)
	req = withRouteParams(req, map[string]string{"org": "acme"})
	rec := httptest.NewRecorder()

	h.GetOrg(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "acme", payload["name"])
}

func TestOrgHandler_PatchOrg(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{},
	}

	unauthReq := httptest.NewRequest(http.MethodPatch, "/api/orgs/acme", strings.NewReader(`{"name":"renamed"}`))
	unauthReq = withRouteParams(unauthReq, map[string]string{"org": "acme"})
	unauthRec := httptest.NewRecorder()
	h.PatchOrg(unauthRec, unauthReq)
	require.Equal(t, http.StatusUnauthorized, unauthRec.Code)

	h.Service = mockOrgRouteService{
		updateOrgFn: func(ctx context.Context, actor *db.User, orgName string, req services.UpdateOrgRequest) (db.Organization, error) {
			assert.Equal(t, int64(1), actor.ID)
			assert.Equal(t, "acme", orgName)
			assert.Equal(t, "renamed", req.Name)
			org := sampleOrg()
			org.Name = "renamed"
			return org, nil
		},
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/orgs/acme", strings.NewReader(`{"name":"renamed"}`))
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PatchOrg(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestOrgHandler_GetOrgRepos(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			listOrgReposFn: func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Repository, int64, error) {
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, 2, page)
				assert.Equal(t, 15, perPage)
				return []db.Repository{sampleRepo()}, 31, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?page=2&per_page=15", nil)
	req = withRouteParams(req, map[string]string{"org": "acme"})
	rec := httptest.NewRecorder()

	h.GetOrgRepos(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "31", rec.Header().Get("X-Total-Count"))
	assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)

	// Regression (#120): the response must be the curated RepoResponse DTO,
	// never the raw db.Repository row (which leaks org_id, lower_name,
	// storage_set_id, next_issue_number, etc.).
	body := rec.Body.String()
	assert.Contains(t, body, `"full_name"`)
	assert.Contains(t, body, `"clone_url"`)
	assert.NotContains(t, body, `"storage_set_id"`)
	assert.NotContains(t, body, `"lower_name"`)
	assert.NotContains(t, body, `"next_issue_number"`)
	assert.NotContains(t, body, `"next_landing_number"`)
	assert.NotContains(t, body, `"user_id"`)
	assert.NotContains(t, body, `"org_id"`)
}

func TestOrgHandler_GetOrgMembers(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			listOrgMembersFn: func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.ListOrgMembersRow, int64, error) {
				assert.Equal(t, int64(1), viewer.ID)
				return []db.ListOrgMembersRow{{ID: 2, Username: "bob", Role: "member"}}, 1, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/members", nil)
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.GetOrgMembers(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, "bob", body[0]["username"])
	assert.NotContains(t, body[0], "lower_username")
	assert.NotContains(t, body[0], "lower_email")
	assert.NotContains(t, body[0], "is_admin")
	assert.NotContains(t, body[0], "wallet_address")
}

func TestOrgHandler_GetOrgTeams(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			listOrgTeamsFn: func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Team, int64, error) {
				assert.Equal(t, int64(1), viewer.ID)
				return []db.Team{sampleTeam()}, 1, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/teams", nil)
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.GetOrgTeams(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestOrgHandler_PostOrgTeam(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			createTeamFn: func(ctx context.Context, actor *db.User, orgName string, req services.CreateTeamRequest) (db.Team, error) {
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "backend", req.Name)
				return sampleTeam(), nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/teams", strings.NewReader(`{"name":"backend","permission":"write"}`))
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PostOrgTeam(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
}

func TestOrgHandler_PostOrgMember_Success(t *testing.T) {
	t.Parallel()

	var called bool
	h := OrgHandler{
		Service: mockOrgRouteService{
			addOrgMemberFn: func(ctx context.Context, actor *db.User, orgName string, targetUserID int64, role string) error {
				called = true
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, int64(2), targetUserID)
				assert.Equal(t, "member", role)
				return nil
			},
		},
	}

	router := chi.NewRouter()
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).
		Post("/api/orgs/{org}/members", h.PostOrgMember)

	req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/members", strings.NewReader(`{"user_id":2,"role":"member"}`))
	req = withTokenAuth(req, 1, "alice", middleware.ScopeWriteOrganization)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.True(t, called, "service AddOrgMember should be called")
}

func TestOrgHandler_PostOrgMember_ForbiddenWithoutScope(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			addOrgMemberFn: func(ctx context.Context, actor *db.User, orgName string, targetUserID int64, role string) error {
				t.Fatalf("service should not be called when scope is missing")
				return nil
			},
		},
	}

	router := chi.NewRouter()
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).
		Post("/api/orgs/{org}/members", h.PostOrgMember)

	req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/members", strings.NewReader(`{"user_id":2,"role":"member"}`))
	req = withTokenAuth(req, 1, "alice", middleware.ScopeReadOrganization)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestOrgHandler_PostOrgMember_UnauthorizedWithoutAuth(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			addOrgMemberFn: func(ctx context.Context, actor *db.User, orgName string, targetUserID int64, role string) error {
				t.Fatalf("service should not be called when auth is missing")
				return nil
			},
		},
	}

	router := chi.NewRouter()
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).
		Post("/api/orgs/{org}/members", h.PostOrgMember)

	req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/members", strings.NewReader(`{"user_id":2,"role":"member"}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestOrgHandler_GetOrgTeam(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			getTeamFn: func(ctx context.Context, viewer *db.User, orgName, teamName string) (db.Team, error) {
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "backend", teamName)
				return sampleTeam(), nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/teams/backend", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.GetOrgTeam(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestOrgHandler_PatchOrgTeam(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			updateTeamFn: func(ctx context.Context, actor *db.User, orgName, teamName string, req services.UpdateTeamRequest) (db.Team, error) {
				assert.Equal(t, "platform", req.Name)
				team := sampleTeam()
				team.Name = "platform"
				return team, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/orgs/acme/teams/backend", strings.NewReader(`{"name":"platform"}`))
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PatchOrgTeam(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestOrgHandler_DeleteOrgTeam(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			deleteTeamFn: func(ctx context.Context, actor *db.User, orgName, teamName string) error {
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "backend", teamName)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/teams/backend", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.DeleteOrgTeam(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestOrgHandler_GetOrgTeamMembers(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			listTeamMembersFn: func(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.User, int64, error) {
				return []db.User{{ID: 3, Username: "bob", LowerUsername: "bob"}}, 1, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/teams/backend/members", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.GetOrgTeamMembers(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, "bob", body[0]["username"])
	assert.NotContains(t, body[0], "lower_username")
	assert.NotContains(t, body[0], "lower_email")
	assert.NotContains(t, body[0], "is_admin")
	assert.NotContains(t, body[0], "wallet_address")
}

func TestOrgHandler_PutOrgTeamMember(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			addTeamMemberFn: func(ctx context.Context, actor *db.User, orgName, teamName, username string) error {
				assert.Equal(t, "bob", username)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/teams/backend/members/bob", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend", "username": "bob"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PutOrgTeamMember(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

// ────────────────────────────────────────────────────────────────
// DeleteOrgMember (DELETE /api/orgs/{org}/members/{username})
// ────────────────────────────────────────────────────────────────

func TestOrgHandler_DeleteOrgMember_Success(t *testing.T) {
	t.Parallel()

	var called bool
	h := OrgHandler{
		Service: mockOrgRouteService{
			removeOrgMemberFn: func(ctx context.Context, actor *db.User, orgName, username string) error {
				called = true
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "bob", username)
				return nil
			},
		},
	}

	router := chi.NewRouter()
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).
		Delete("/api/orgs/{org}/members/{username}", h.DeleteOrgMember)

	req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/members/bob", nil)
	req = withTokenAuth(req, 1, "alice", middleware.ScopeWriteOrganization)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, called, "service RemoveOrgMember should be called")
}

func TestOrgHandler_DeleteOrgMember_Unauthenticated(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			removeOrgMemberFn: func(ctx context.Context, actor *db.User, orgName, username string) error {
				t.Fatalf("service should not be called when auth is missing")
				return nil
			},
		},
	}

	router := chi.NewRouter()
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).
		Delete("/api/orgs/{org}/members/{username}", h.DeleteOrgMember)

	req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/members/bob", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestOrgHandler_DeleteOrgMember_PropagatesServiceError(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			removeOrgMemberFn: func(ctx context.Context, actor *db.User, orgName, username string) error {
				return pkgerrors.NotFound("user not found")
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/members/bob", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "username": "bob"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.DeleteOrgMember(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestOrgHandler_DeleteOrgMember_PropagatesConflict(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			removeOrgMemberFn: func(ctx context.Context, actor *db.User, orgName, username string) error {
				return pkgerrors.Conflict("cannot remove the last organization owner")
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/members/bob", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "username": "bob"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.DeleteOrgMember(rec, req)

	require.Equal(t, http.StatusConflict, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "cannot remove the last organization owner", payload["message"])
}

func TestOrgHandler_DeleteOrgMember(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			removeTeamMemberFn: func(ctx context.Context, actor *db.User, orgName, teamName, username string) error {
				assert.Equal(t, "bob", username)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/teams/backend/members/bob", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend", "username": "bob"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.DeleteOrgTeamMember(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestOrgHandler_GetOrgTeamRepos(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			listTeamReposFn: func(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.Repository, int64, error) {
				return []db.Repository{sampleRepo()}, 1, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/teams/backend/repos", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.GetOrgTeamRepos(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	// Regression (#120): team repo listing must also use the curated
	// RepoResponse DTO, not the raw db.Repository row.
	body := rec.Body.String()
	assert.Contains(t, body, `"full_name"`)
	assert.Contains(t, body, `"clone_url"`)
	assert.NotContains(t, body, `"storage_set_id"`)
	assert.NotContains(t, body, `"lower_name"`)
	assert.NotContains(t, body, `"next_issue_number"`)
	assert.NotContains(t, body, `"user_id"`)
}

func TestOrgHandler_PutOrgTeamRepo(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			addTeamRepoFn: func(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error {
				assert.Equal(t, "acme", owner)
				assert.Equal(t, "repo", repo)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/teams/backend/repos/acme/repo", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend", "owner": "acme", "repo": "repo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PutOrgTeamRepo(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestOrgHandler_DeleteOrgTeamRepo(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			removeTeamRepoFn: func(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error {
				assert.Equal(t, "acme", owner)
				assert.Equal(t, "repo", repo)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/teams/backend/repos/acme/repo", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "team": "backend", "owner": "acme", "repo": "repo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.DeleteOrgTeamRepo(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestPaginationURL_UsesRelativeURLForHTTPSRequest(t *testing.T) {
	t.Parallel()

	// Simulate a request that arrives via HTTPS (with Host set, as a real
	// reverse-proxy or Go HTTP server would populate).
	req := httptest.NewRequest(http.MethodGet, "https://api.smithers.sh/api/orgs/acme/repos?page=1&per_page=10", nil)
	// httptest.NewRequest already sets Host from the URL.

	got := paginationURL(req, 2, 10)

	// The result must be a relative URL (no scheme, no host).
	assert.NotContains(t, got, "http://", "paginationURL must not hardcode http:// scheme")
	assert.NotContains(t, got, "https://", "paginationURL should return relative URL, not absolute")
	assert.NotContains(t, got, "smithers.sh", "paginationURL should not include the host")
	assert.Contains(t, got, "/api/orgs/acme/repos", "paginationURL must include the request path")
	assert.Contains(t, got, "page=2", "paginationURL must set the target page")
	assert.Contains(t, got, "per_page=10", "paginationURL must set per_page")
}

func TestPaginationURL_PreservesExistingQueryParams(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?state=open&sort=name&page=1&per_page=30", nil)

	got := paginationURL(req, 3, 15)

	assert.Contains(t, got, "state=open", "existing query param 'state' must be preserved")
	assert.Contains(t, got, "sort=name", "existing query param 'sort' must be preserved")
	assert.Contains(t, got, "page=3", "page must be overridden to target value")
	assert.Contains(t, got, "per_page=15", "per_page must be overridden to target value")
	// Verify page and per_page are correctly set (not the old values).
	// Parse the URL to check query params precisely rather than substring matching,
	// since "page=1" could match inside "per_page=15".
	parsedURL, err := url.Parse(got)
	require.NoError(t, err)
	assert.Equal(t, "3", parsedURL.Query().Get("page"), "page must be overridden to target value")
	assert.Equal(t, "15", parsedURL.Query().Get("per_page"), "per_page must be overridden to target value")
}

func TestSetPaginationHeaders_EmitsRelativeLinks(t *testing.T) {
	t.Parallel()

	// Request with Host set (simulates real HTTP traffic behind reverse proxy).
	req := httptest.NewRequest(http.MethodGet, "https://api.smithers.sh/api/orgs/acme/repos?page=2&per_page=10", nil)
	rec := httptest.NewRecorder()

	setPaginationHeaders(rec, req, 2, 10, 10, 50) // page 2, 10 results returned, 50 total items

	linkHeader := rec.Header().Get("Link")
	require.NotEmpty(t, linkHeader, "Link header must be set")

	// All four rels should be present (page 2 of 5).
	assert.Contains(t, linkHeader, `rel="first"`)
	assert.Contains(t, linkHeader, `rel="last"`)
	assert.Contains(t, linkHeader, `rel="prev"`)
	assert.Contains(t, linkHeader, `rel="next"`)

	// No link should contain an absolute http:// URL.
	assert.NotContains(t, linkHeader, "http://", "Link header must not contain http:// scheme")
	assert.NotContains(t, linkHeader, "https://", "Link header must not contain https:// scheme")

	// Total count header.
	assert.Equal(t, "50", rec.Header().Get("X-Total-Count"))
}

func TestOrgHandler_GetOrgRepos_LinkHeaderDoesNotForceHTTP(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			listOrgReposFn: func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Repository, int64, error) {
				return []db.Repository{sampleRepo()}, 45, nil // 45 items to trigger next/last links
			},
		},
	}

	// Simulate an HTTPS request with Host header set (as a real server sees).
	req := httptest.NewRequest(http.MethodGet, "https://api.smithers.sh/api/orgs/acme/repos?page=1&per_page=10", nil)
	req = withRouteParams(req, map[string]string{"org": "acme"})
	rec := httptest.NewRecorder()

	h.GetOrgRepos(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	linkHeader := rec.Header().Get("Link")
	require.NotEmpty(t, linkHeader, "Link header must be present")

	// Regression: must not contain hardcoded http:// scheme.
	assert.NotContains(t, linkHeader, "http://", "Link header must not force http:// scheme")
	assert.NotContains(t, linkHeader, "https://", "Link header should use relative URLs")

	// Validate expected rels are present.
	assert.Contains(t, linkHeader, `rel="first"`)
	assert.Contains(t, linkHeader, `rel="last"`)
	assert.Contains(t, linkHeader, `rel="next"`)

	// Validate link targets contain the expected path.
	assert.Contains(t, linkHeader, "/api/orgs/acme/repos")
}

func TestOrgHandler_PaginationValidation(t *testing.T) {
	t.Parallel()

	h := OrgHandler{Service: mockOrgRouteService{}}

	badPageReq := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?page=0", nil)
	badPageReq = withRouteParams(badPageReq, map[string]string{"org": "acme"})
	badPageRec := httptest.NewRecorder()
	h.GetOrgRepos(badPageRec, badPageReq)
	require.Equal(t, http.StatusBadRequest, badPageRec.Code)

	badPerPageReq := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?per_page=101", nil)
	badPerPageReq = withRouteParams(badPerPageReq, map[string]string{"org": "acme"})
	badPerPageRec := httptest.NewRecorder()
	h.GetOrgRepos(badPerPageRec, badPerPageReq)
	require.Equal(t, http.StatusBadRequest, badPerPageRec.Code)
}

// ────────────────────────────────────────────────────────────────
// PostOrg (POST /api/orgs) handler tests
// ────────────────────────────────────────────────────────────────

func TestOrgHandler_PostOrg_Success(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			createOrgFn: func(ctx context.Context, actor *db.User, req services.CreateOrgRequest) (db.Organization, error) {
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "acme", req.Name)
				assert.Equal(t, "A company", req.Description)
				assert.Equal(t, "public", req.Visibility)
				return sampleOrg(), nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/orgs", strings.NewReader(`{"name":"acme","description":"A company","visibility":"public"}`))
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PostOrg(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "acme", payload["name"])
}

func TestOrgHandler_PostOrg_Unauthenticated(t *testing.T) {
	t.Parallel()

	h := OrgHandler{Service: mockOrgRouteService{}}

	req := httptest.NewRequest(http.MethodPost, "/api/orgs", strings.NewReader(`{"name":"acme"}`))
	rec := httptest.NewRecorder()

	h.PostOrg(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestOrgHandler_PostOrg_InvalidJSON(t *testing.T) {
	t.Parallel()

	h := OrgHandler{Service: mockOrgRouteService{}}

	req := httptest.NewRequest(http.MethodPost, "/api/orgs", strings.NewReader(`{not valid json`))
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PostOrg(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestOrgHandler_PostOrg_PropagatesServiceError(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			createOrgFn: func(ctx context.Context, actor *db.User, req services.CreateOrgRequest) (db.Organization, error) {
				return db.Organization{}, pkgerrors.Conflict("organization name already exists")
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/orgs", strings.NewReader(`{"name":"acme","visibility":"public"}`))
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.PostOrg(rec, req)

	require.Equal(t, http.StatusConflict, rec.Code)
}

func TestOrgHandler_PropagatesServiceAPIError(t *testing.T) {
	t.Parallel()

	h := OrgHandler{
		Service: mockOrgRouteService{
			getOrgFn: func(ctx context.Context, viewer *db.User, orgName string) (db.Organization, error) {
				return db.Organization{}, pkgerrors.NotFound("organization not found")
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme", nil)
	req = withRouteParams(req, map[string]string{"org": "acme"})
	rec := httptest.NewRecorder()

	h.GetOrg(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}
