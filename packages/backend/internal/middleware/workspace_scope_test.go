package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseTokenWorkspaceRestriction(t *testing.T) {
	t.Parallel()
	id := "0f8fad5b-d9cb-469f-a165-70867728950e"
	assert.Equal(t, id, ParseTokenWorkspaceRestriction("write:repository,repo:3,"+WorkspaceRestrictionScope(id)))
	assert.Equal(t, id, ParseTokenWorkspaceRestriction("write:repository workspace:0F8FAD5B-D9CB-469F-A165-70867728950E"))
	assert.Equal(t, "", ParseTokenWorkspaceRestriction("write:repository,repo:3,agent-session:"+id))
	assert.Equal(t, "", ParseTokenWorkspaceRestriction(""))
	info := &AuthInfo{IsTokenAuth: true, RawScopes: WorkspaceRestrictionScope(id)}
	assert.Equal(t, id, info.WorkspaceRestriction())
	assert.Equal(t, "", (&AuthInfo{RawScopes: WorkspaceRestrictionScope(id)}).WorkspaceRestriction(), "session auth carries no workspace binding")
}

func TestAllowWorkspaceRestrictedToken(t *testing.T) {
	t.Parallel()
	id := "0f8fad5b-d9cb-469f-a165-70867728950e"
	bound := &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository,repo:3," + WorkspaceRestrictionScope(id)}
	unbound := &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository"}
	cases := []struct {
		name   string
		info   *AuthInfo
		method string
		path   string
		allow  bool
	}{
		{"own head report", bound, http.MethodPost, "/api/repos/alice/demo/workspaces/" + id + "/head", true},
		{"own head report, upper-case id", bound, http.MethodPost, "/api/repos/alice/demo/workspaces/0F8FAD5B-D9CB-469F-A165-70867728950E/head", true},
		{"other workspace head", bound, http.MethodPost, "/api/repos/alice/demo/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/head", false},
		{"GET on the head route", bound, http.MethodGet, "/api/repos/alice/demo/workspaces/" + id + "/head", false},
		{"any other API route", bound, http.MethodGet, "/api/repos/alice/demo", false},
		{"workspace suspend", bound, http.MethodPost, "/api/repos/alice/demo/workspaces/" + id + "/suspend", false},
		{"git smart http is outside /api", bound, http.MethodPost, "/alice/demo/git-receive-pack", true},
		{"unbound token anywhere", unbound, http.MethodGet, "/api/repos/alice/demo", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			rec := httptest.NewRecorder()
			got := allowWorkspaceRestrictedToken(rec, req, tc.info)
			require.Equal(t, tc.allow, got)
			if !tc.allow {
				assert.Equal(t, http.StatusForbidden, rec.Code)
			}
		})
	}
}
