package middleware

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAuthInfoIsResourceBound(t *testing.T) {
	t.Parallel()
	pathScope := PathRestrictionScopes([]string{"src/app"})[0]

	cases := []struct {
		name string
		info *AuthInfo
		want bool
	}{
		{name: "nil auth info", info: nil, want: false},
		{name: "session caller ignores raw scopes", info: &AuthInfo{IsTokenAuth: false, RawScopes: "write:repository,repo:123,agent-session:s1"}, want: false},
		{name: "token with no scopes", info: &AuthInfo{IsTokenAuth: true, RawScopes: ""}, want: false},
		{name: "unrestricted comma-joined token", info: &AuthInfo{IsTokenAuth: true, RawScopes: "read:repository,write:repository"}, want: false},
		{name: "unrestricted legacy space-joined token", info: &AuthInfo{IsTokenAuth: true, RawScopes: "read:repository write:repository read:user"}, want: false},
		{name: "unrestricted with surrounding whitespace", info: &AuthInfo{IsTokenAuth: true, RawScopes: " write:repository , read:user "}, want: false},
		{name: "repository binding", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository,repo:123"}, want: true},
		{name: "repository binding upper case prefix", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository,REPO:123"}, want: true},
		{name: "repository binding with agent session", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository,repo:123,agent-session:s1"}, want: true},
		{name: "agent session binding only", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository,agent-session:s1"}, want: true},
		{name: "path allowlist only", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository," + pathScope}, want: true},
		{name: "workspace binding only", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository," + WorkspaceRestrictionScope("ws-1")}, want: true},
		{name: "workspace binding space-joined", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository " + WorkspaceRestrictionScope("ws-1")}, want: true},
		{name: "full per-run sandbox token", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository," + RepositoryRestrictionScope(7) + "," + AgentSessionRestrictionScope("sess") + "," + pathScope}, want: true},
		{name: "malformed repository binding is inert like everywhere else", info: &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository,repo:abc"}, want: false},
		{name: "oauth2 access token with binding", info: &AuthInfo{IsTokenAuth: true, TokenSource: TokenSourceOAuth2AccessToken, RawScopes: "write:repository,repo:123"}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, tc.info.IsResourceBound())
		})
	}
}
