package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type egressBoundSecretsStub struct {
	secrets []sandbox.EgressProxySecret
	err     error
	calls   int
}

func (s *egressBoundSecretsStub) LoadProxyBoundSecrets(context.Context, int64) ([]sandbox.EgressProxySecret, error) {
	s.calls++
	return s.secrets, s.err
}

type egressMetricsStub struct {
	mockSandboxMetricsRecorder
	deliveries map[string]int
}

func (m *egressMetricsStub) AddAgentSecretDelivery(path string, count int) {
	if m.deliveries == nil {
		m.deliveries = map[string]int{}
	}
	m.deliveries[path] += count
}

func newEgressDispatch(t *testing.T, sandboxClient SandboxVMClient) *agentDispatch {
	t.Helper()
	return &agentDispatch{
		svc: &AgentService{
			dispatchQ:  &mockAgentDispatchQuerier{},
			sandbox:    sandboxClient,
			apiBaseURL: "https://api.example.test",
			sandboxConfig: AgentSandboxConfig{
				ProviderEnv: map[string]string{
					"ANTHROPIC_API_KEY": "sk-ant-real-value",
					"CUSTOM_LLM_KEY":    "custom-real-value",
				},
			},
		},
		ctx:            context.Background(),
		input:          DispatchAgentRunInput{SessionID: "sess-1", RepositoryID: 42},
		plaintext:      "agent-token",
		repositoryPath: "/workspace/demo",
		run:            db.WorkflowRun{ID: 10},
		step:           db.WorkflowStep{ID: 20},
		task:           db.WorkflowTask{ID: 30},
	}
}

// A platform credential with a known API host reaches the guest as NAME=NAME and the real value travels only inside the create
// request's egress block. A provider without a binding keeps the legacy path.
func TestAgentDispatch_EgressProxyReplacesBoundProviderCredentialsWithPlaceholders(t *testing.T) {
	t.Parallel()
	var created sandbox.CreateRequest
	var started sandbox.ServiceSpec
	client := &mockSandboxVMClient{
		createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			created = req
			return sandbox.CreateResult{ID: "vm-egress"}, nil
		},
		createSystemdServiceFn: func(_ context.Context, _ string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			started = req
			return sandbox.CreateServiceResult{Success: true}, nil
		},
	}
	dispatch := newEgressDispatch(t, client)
	metrics := &egressMetricsStub{}
	dispatch.svc.sandboxMetrics = metrics

	require.NoError(t, dispatch.buildServiceSpec())
	require.NoError(t, dispatch.injectSecrets())
	require.NoError(t, dispatch.requireProviderCredential())
	require.NoError(t, dispatch.createVM())
	require.NoError(t, dispatch.startService())

	env := started.Env
	assert.Equal(t, "ANTHROPIC_API_KEY", env["ANTHROPIC_API_KEY"], "bound credential is a placeholder in the guest")
	assert.Equal(t, "custom-real-value", env["CUSTOM_LLM_KEY"], "an unbound provider keeps the legacy path")
	assert.Equal(t, "agent-token", env["SMITHERS_AGENT_TOKEN"])

	require.NotNil(t, created.EgressProxy)
	assert.True(t, created.EgressProxy.Enabled)
	require.Len(t, created.EgressProxy.Secrets, 1)
	secret := created.EgressProxy.Secrets[0]
	assert.Equal(t, "ANTHROPIC_API_KEY", secret.Name)
	assert.Equal(t, "sk-ant-real-value", secret.Value)
	assert.Equal(t, []string{"api.anthropic.com"}, secret.Hosts)
	assert.ElementsMatch(t, []string{"x-api-key", "authorization"}, secret.MatchHeaders)

	serviceJSON, err := json.Marshal(started)
	require.NoError(t, err)
	assert.NotContains(t, string(serviceJSON), "sk-ant-real-value", "the service spec sent to the guest never carries the value")
	assert.Equal(t, 1, metrics.deliveries[secretDeliveryPathEgressProxy])
}

// Bound agent-environment secrets reach the session only through the proxy,
// never as plaintext in the guest, and never shadow a reserved runtime key.
func TestAgentDispatch_BoundAgentEnvironmentSecretsGoThroughTheProxyOnly(t *testing.T) {
	t.Parallel()
	var created sandbox.CreateRequest
	client := &mockSandboxVMClient{createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		created = req
		return sandbox.CreateResult{ID: "vm-bound"}, nil
	}}
	dispatch := newEgressDispatch(t, client)
	dispatch.svc.boundSecrets = &egressBoundSecretsStub{secrets: []sandbox.EgressProxySecret{
		{Name: "WAREHOUSE_TOKEN", Value: "wh-real", Hosts: []string{"warehouse.internal.example"}, MatchHeaders: []string{"authorization"}},
		{Name: "SMITHERS_AGENT_TOKEN", Value: "attacker", Hosts: []string{"evil.example"}, MatchHeaders: []string{"authorization"}},
	}}

	require.NoError(t, dispatch.buildServiceSpec())
	require.NoError(t, dispatch.injectSecrets())
	require.NoError(t, dispatch.createVM())

	assert.Equal(t, "WAREHOUSE_TOKEN", dispatch.agentServiceSpec.Env["WAREHOUSE_TOKEN"])
	assert.Equal(t, "agent-token", dispatch.agentServiceSpec.Env["SMITHERS_AGENT_TOKEN"], "a bound secret cannot shadow a reserved runtime key")
	names := created.EgressProxy.SecretNames()
	assert.Contains(t, names, "WAREHOUSE_TOKEN")
	assert.NotContains(t, names, "SMITHERS_AGENT_TOKEN")
}

func TestAgentDispatch_RepositoryAgentEnvironmentVariablesReachService(t *testing.T) {
	t.Parallel()
	store := &agentEnvironmentTestQuerier{config: &db.RepositoryAgentEnvironment{
		RepositoryID: 42,
		EnvironmentVariables: json.RawMessage(`[
			{"name":"SMITHERS_ANTHROPIC_MODEL","value":"claude-haiku-4-5"},
			{"name":"DEPLOYMENT_TIER","value":"variable-value"},
			{"name":"SMITHERS_AGENT_TOKEN","value":"repository-value"}
		]`),
	}}
	environment := NewAgentEnvironmentService(store, nil)
	dispatch := newEgressDispatch(t, &mockSandboxVMClient{})
	dispatch.svc.secretService = &mockAgentSecretReader{listDecryptedSecretsForRepoFn: func(context.Context, int64) (map[string]string, error) {
		return map[string]string{"DEPLOYMENT_TIER": "secret-value", "SMITHERS_AGENT_TOKEN": "secret-token"}, nil
	}}
	WithAgentEnvironmentVariables(environment)(dispatch.svc)
	WithAgentEnvironmentBoundSecrets(environment)(dispatch.svc)

	require.NoError(t, dispatch.buildServiceSpec())
	require.NoError(t, dispatch.injectSecrets())

	assert.Equal(t, "claude-haiku-4-5", dispatch.agentServiceSpec.Env["SMITHERS_ANTHROPIC_MODEL"])
	assert.Equal(t, "secret-value", dispatch.agentServiceSpec.Env["DEPLOYMENT_TIER"], "repository secrets win over non-secret variables")
	assert.Equal(t, "agent-token", dispatch.agentServiceSpec.Env["SMITHERS_AGENT_TOKEN"], "reserved runtime values win over repository variables and secrets")
}

func TestAgentDispatch_BoundSecretLoadFailureMarksInfraFailed(t *testing.T) {
	t.Parallel()
	dispatch := newEgressDispatch(t, &mockSandboxVMClient{})
	dispatch.svc.boundSecrets = &egressBoundSecretsStub{err: errors.New("db down")}
	require.NoError(t, dispatch.buildServiceSpec())
	err := dispatch.injectSecrets()
	require.Error(t, err)
	assert.True(t, dispatch.infraFailedMarked)
}

// The credential guard accepts a placeholder only for a name the proxy holds;
// the operator-seeded "placeholder-pending" stand-in is still refused.
func TestRequireProviderCredential_AcceptsProxyPlaceholderOnlyForBoundNames(t *testing.T) {
	t.Parallel()
	dispatch := &agentDispatch{
		svc: &AgentService{dispatchQ: &mockAgentDispatchQuerier{}},
		ctx: context.Background(),
		agentServiceSpec: sandbox.ServiceSpec{Env: map[string]string{
			"ANTHROPIC_API_KEY": sandbox.EgressProxyPlaceholder("ANTHROPIC_API_KEY"),
		}},
	}
	require.Error(t, dispatch.requireProviderCredential(), "a bare NAME=NAME without a proxy binding is not a credential")

	dispatch = &agentDispatch{
		svc:         &AgentService{dispatchQ: &mockAgentDispatchQuerier{}},
		ctx:         context.Background(),
		egressNames: map[string]struct{}{"ANTHROPIC_API_KEY": {}},
		agentServiceSpec: sandbox.ServiceSpec{Env: map[string]string{
			"ANTHROPIC_API_KEY": sandbox.EgressProxyPlaceholder("ANTHROPIC_API_KEY"),
		}},
	}
	require.NoError(t, dispatch.requireProviderCredential())

	dispatch = &agentDispatch{
		svc:         &AgentService{dispatchQ: &mockAgentDispatchQuerier{}},
		ctx:         context.Background(),
		egressNames: map[string]struct{}{"OPENAI_API_KEY": {}},
		agentServiceSpec: sandbox.ServiceSpec{Env: map[string]string{
			"ANTHROPIC_API_KEY": "placeholder-pending-h1-credential-seed",
		}},
	}
	require.Error(t, dispatch.requireProviderCredential(), "the seeded placeholder stays refused even when another name is proxied")
}

func TestProviderCredentialEgressSecretBindsKnownProvidersOnly(t *testing.T) {
	t.Parallel()
	secret, ok := ProviderCredentialEgressSecret("OPENAI_API_KEY", " sk-real ")
	require.True(t, ok)
	assert.Equal(t, "sk-real", secret.Value)
	assert.Equal(t, []string{"api.openai.com"}, secret.Hosts)
	require.NoError(t, secret.Validate())

	google, ok := ProviderCredentialEgressSecret("GOOGLE_API_KEY", "g-real")
	require.True(t, ok)
	assert.True(t, google.MatchQuery, "Google accepts ?key= as well as x-goog-api-key")

	_, ok = ProviderCredentialEgressSecret("OPENAI_API_KEY", "placeholder-pending-seed")
	assert.False(t, ok, "an unusable value is never bound")
	_, ok = ProviderCredentialEgressSecret("UNKNOWN_PROVIDER_KEY", "real")
	assert.False(t, ok, "an unknown provider keeps the legacy path")

	for _, name := range AgentProviderCredentialEnvNames {
		_, bound := ProviderCredentialBindingFor(name)
		assert.True(t, bound, "%s must have a proxy binding", name)
	}
}

// The proxy is not optional: a session with no bound secret at all still asks
// the worker for its proxy, so the guest's only network path is the boundary
// even when there is nothing to substitute yet. A provider without a known
// host stays on the legacy environment path.
func TestAgentDispatch_EgressProxyIsRequestedForEverySession(t *testing.T) {
	t.Parallel()
	var created sandbox.CreateRequest
	client := &mockSandboxVMClient{createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		created = req
		return sandbox.CreateResult{ID: "vm-unbound"}, nil
	}}
	dispatch := newEgressDispatch(t, client)
	dispatch.svc.sandboxConfig.ProviderEnv = map[string]string{"CUSTOM_LLM_KEY": "custom-real-value"}
	metrics := &egressMetricsStub{}
	dispatch.svc.sandboxMetrics = metrics

	require.NoError(t, dispatch.buildServiceSpec())
	require.NoError(t, dispatch.injectSecrets())
	require.NoError(t, dispatch.createVM())

	require.NotNil(t, created.EgressProxy)
	assert.True(t, created.EgressProxy.Enabled)
	assert.Empty(t, created.EgressProxy.Secrets)
	assert.Equal(t, "custom-real-value", dispatch.agentServiceSpec.Env["CUSTOM_LLM_KEY"], "an unbound provider keeps the legacy path")
	assert.Equal(t, 0, metrics.deliveries[secretDeliveryPathEgressProxy])
}

// The per-run repository token doubles as the build cache write credential:
// it reaches the guest as a placeholder bound to the API host, and the cache
// endpoint is announced so smithers-build needs no declaration.
func TestAgentDispatch_BindsBuildCacheWriteTokenThroughProxy(t *testing.T) {
	t.Parallel()
	var created sandbox.CreateRequest
	client := &mockSandboxVMClient{createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		created = req
		return sandbox.CreateResult{ID: "vm-cache"}, nil
	}}
	dispatch := newEgressDispatch(t, client)
	dispatch.svc.sandboxConfig.ProviderEnv = map[string]string{}
	dispatch.input.RepoOwner = "acme"
	dispatch.input.RepoName = "app"
	dispatch.jjhubToken = temporaryRepoCloneToken{ID: 1, Plaintext: "smithers_" + strings.Repeat("c", 40)}
	dispatch.hasJJHubToken = true

	require.NoError(t, dispatch.buildServiceSpec())
	require.NoError(t, dispatch.injectSecrets())
	require.NoError(t, dispatch.createVM())

	assert.Equal(t, sandbox.EgressProxyPlaceholder("SMITHERS_CACHE_TOKEN"), dispatch.agentServiceSpec.Env["SMITHERS_CACHE_TOKEN"])
	assert.Equal(t, "https://api.example.test/api/repos/acme/app/build-cache", dispatch.agentServiceSpec.Env["SMITHERS_CACHE_URL"])
	require.NotNil(t, created.EgressProxy)
	var bound *sandbox.EgressProxySecret
	for index := range created.EgressProxy.Secrets {
		if created.EgressProxy.Secrets[index].Name == "SMITHERS_CACHE_TOKEN" {
			bound = &created.EgressProxy.Secrets[index]
		}
	}
	require.NotNil(t, bound, "the cache token travels only in the egress block")
	assert.Equal(t, dispatch.jjhubToken.Plaintext, bound.Value)
	assert.Equal(t, []string{"api.example.test"}, bound.Hosts)
	assert.Equal(t, []string{"authorization"}, bound.MatchHeaders)
}
