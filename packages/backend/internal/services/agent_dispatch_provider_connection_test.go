package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type providerConnectionResolverStub struct {
	resolved *ResolvedProviderConnection
	err      error
	provider string
}

func (s *providerConnectionResolverStub) ResolveForRun(_ context.Context, _, _ int64, provider string) (*ResolvedProviderConnection, error) {
	s.provider = provider
	return s.resolved, s.err
}

func runProviderConnectionDispatch(t *testing.T, resolver AgentProviderConnectionResolver, agentProvider string) (sandbox.CreateRequest, sandbox.ServiceSpec) {
	t.Helper()
	var created sandbox.CreateRequest
	var started sandbox.ServiceSpec
	client := &mockSandboxVMClient{
		createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			created = req
			return sandbox.CreateResult{ID: "vm-byo"}, nil
		},
		createSystemdServiceFn: func(_ context.Context, _ string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			started = req
			return sandbox.CreateServiceResult{Success: true}, nil
		},
	}
	dispatch := newEgressDispatch(t, client)
	dispatch.svc.providerConnections = resolver
	dispatch.input.AgentProvider = agentProvider
	dispatch.input.UserID = 7
	require.NoError(t, dispatch.buildServiceSpec())
	require.NoError(t, dispatch.injectSecrets())
	require.NoError(t, dispatch.requireProviderCredential())
	require.NoError(t, dispatch.createVM())
	require.NoError(t, dispatch.startService())
	return created, started
}

// A connected Claude subscription replaces the platform Anthropic key for the
// run: the guest sees two placeholders, the proxy holds one value.
func TestAgentDispatch_ClaudeConnectionReplacesPlatformCredential(t *testing.T) {
	t.Parallel()
	resolver := &providerConnectionResolverStub{resolved: &ResolvedProviderConnection{ConnectionID: "conn-1", Provider: "claude", Kind: "setup_token", AccessToken: "sk-ant-oat01-subscription"}}
	created, started := runProviderConnectionDispatch(t, resolver, "smithers")

	assert.Equal(t, "claude", resolver.provider)
	assert.Equal(t, "ANTHROPIC_AUTH_TOKEN", started.Env["ANTHROPIC_AUTH_TOKEN"])
	assert.Equal(t, "CLAUDE_CODE_OAUTH_TOKEN", started.Env["CLAUDE_CODE_OAUTH_TOKEN"])
	_, hasPlatformKey := started.Env["ANTHROPIC_API_KEY"]
	assert.False(t, hasPlatformKey, "the platform seat must not compete with the subscription")
	_, hasPlatformURL := started.Env["ANTHROPIC_BASE_URL"]
	assert.False(t, hasPlatformURL, "the subscription keeps Anthropic's own origin")

	names := created.EgressProxy.SecretNames()
	assert.ElementsMatch(t, []string{"ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "SMITHERS_AGENT_TOKEN"}, names)
	for _, secret := range created.EgressProxy.Secrets {
		if secret.Name == "SMITHERS_AGENT_TOKEN" {
			continue
		}
		assert.Equal(t, "sk-ant-oat01-subscription", secret.Value)
		assert.Equal(t, []string{"api.anthropic.com"}, secret.Hosts)
		assert.Equal(t, []string{"authorization"}, secret.MatchHeaders)
	}
	assertNoSubscriptionTokenOutsideProxy(t, created, started, "sk-ant-oat01-subscription")
}

// A connected Codex subscription plants a placeholder-only auth.json and binds
// the access token to chatgpt.com.
func TestAgentDispatch_CodexConnectionPlantsPlaceholderAuthJSON(t *testing.T) {
	t.Parallel()
	resolver := &providerConnectionResolverStub{resolved: &ResolvedProviderConnection{ConnectionID: "conn-2", Provider: "codex", Kind: "oauth", AccessToken: "chatgpt-access-secret", AccountID: "acct_77", AccountEmail: "p@example.com", Plan: "pro"}}
	created, started := runProviderConnectionDispatch(t, resolver, "codex")

	assert.Equal(t, "codex", resolver.provider)
	assert.Equal(t, "OPENAI_CODEX_ACCESS_TOKEN", started.Env["OPENAI_CODEX_ACCESS_TOKEN"])
	assert.Equal(t, "/root/.codex", started.Env["CODEX_HOME"])
	assert.Equal(t, "ANTHROPIC_API_KEY", started.Env["ANTHROPIC_API_KEY"], "the platform seat stays metered for other providers")
	assert.Equal(t, "anthropic", started.Env["SMITHERS_MODEL_PROXY_PROVIDERS"])

	file, ok := created.Files["/root/.codex/auth.json"]
	require.True(t, ok, "auth.json is planted in the guest")
	var doc struct {
		Tokens struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
	}
	require.NoError(t, json.Unmarshal([]byte(file.Content), &doc))
	assert.Equal(t, "OPENAI_CODEX_ACCESS_TOKEN", doc.Tokens.AccessToken)
	assert.Equal(t, "acct_77", doc.Tokens.AccountID)
	assert.NotContains(t, doc.Tokens.RefreshToken, "secret")

	var bound *sandbox.EgressProxySecret
	for i := range created.EgressProxy.Secrets {
		if created.EgressProxy.Secrets[i].Name == "OPENAI_CODEX_ACCESS_TOKEN" {
			bound = &created.EgressProxy.Secrets[i]
		}
	}
	require.NotNil(t, bound)
	assert.Equal(t, "chatgpt-access-secret", bound.Value)
	assert.Equal(t, []string{"chatgpt.com"}, bound.Hosts)
	assertNoSubscriptionTokenOutsideProxy(t, created, started, "chatgpt-access-secret")
}

// No connection means the platform seat stays on the metered model proxy.
func TestAgentDispatch_NoConnectionKeepsPlatformPath(t *testing.T) {
	t.Parallel()
	created, started := runProviderConnectionDispatch(t, &providerConnectionResolverStub{}, "smithers")
	assert.Equal(t, "ANTHROPIC_API_KEY", started.Env["ANTHROPIC_API_KEY"])
	assert.ElementsMatch(t, []string{"ANTHROPIC_API_KEY", "SMITHERS_AGENT_TOKEN"}, created.EgressProxy.SecretNames())
	assert.Empty(t, created.Files)
}

// A resolver failure fails the run closed rather than booting on a guess.
func TestAgentDispatch_ProviderConnectionResolveFailureMarksInfraFailed(t *testing.T) {
	t.Parallel()
	client := &mockSandboxVMClient{}
	dispatch := newEgressDispatch(t, client)
	dispatch.svc.providerConnections = &providerConnectionResolverStub{err: context.DeadlineExceeded}
	require.NoError(t, dispatch.buildServiceSpec())
	err := dispatch.injectSecrets()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "resolve provider connection")
}

// assertNoSubscriptionTokenOutsideProxy is the sentinel: the value appears in
// the egress block of the create request and nowhere else the guest can see.
func assertNoSubscriptionTokenOutsideProxy(t *testing.T, created sandbox.CreateRequest, started sandbox.ServiceSpec, token string) {
	t.Helper()
	serviceJSON, err := json.Marshal(started)
	require.NoError(t, err)
	assert.NotContains(t, string(serviceJSON), token, "service spec never carries the subscription token")
	for path, file := range created.Files {
		assert.NotContains(t, file.Content, token, "guest file %s never carries the subscription token", path)
	}
	stripped := created
	stripped.EgressProxy = nil
	createJSON, err := json.Marshal(stripped)
	require.NoError(t, err)
	assert.NotContains(t, string(createJSON), token, "outside the egress block the create request never carries the token")
	for name, value := range started.Env {
		assert.False(t, strings.Contains(value, token), "env %s carries the token", name)
	}
}

// The hosted default: the resolver is wired but the deployment flag is off,
// so a user with a stored Claude subscription still runs on the platform
// binding and the token never reaches the create request.
func TestAgentDispatch_DisabledSubscriptionConnectionsBindNoToken(t *testing.T) {
	t.Parallel()
	q := newFakePCQ()
	q.repos[42] = db.Repository{ID: 42, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	_, err := newPCService(q, nil).ConnectForUser(context.Background(), &db.User{ID: 7}, ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-oat01-subscription"})
	require.NoError(t, err)

	disabled := NewProviderConnectionService(q, plainCodec{}, nil)
	created, started := runProviderConnectionDispatch(t, disabled, "smithers")
	assert.ElementsMatch(t, []string{"ANTHROPIC_API_KEY", "SMITHERS_AGENT_TOKEN"}, created.EgressProxy.SecretNames())
	_, hasOAuth := started.Env["CLAUDE_CODE_OAUTH_TOKEN"]
	assert.False(t, hasOAuth)
	raw, err := json.Marshal(struct {
		C sandbox.CreateRequest
		S sandbox.ServiceSpec
	}{created, started})
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "sk-ant-oat01-subscription")

	// Flag on, same user and repository: the subscription binds.
	created, started = runProviderConnectionDispatch(t, newPCService(q, nil), "smithers")
	assert.ElementsMatch(t, []string{"ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "SMITHERS_AGENT_TOKEN"}, created.EgressProxy.SecretNames())
	assert.Equal(t, "CLAUDE_CODE_OAUTH_TOKEN", started.Env["CLAUDE_CODE_OAUTH_TOKEN"])
}
