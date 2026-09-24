package services

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func bootstrapModel(env AgentEnvironmentProvisioningConfig) string {
	for _, variable := range env.Env {
		if variable.Name == "SMITHERS_CODING_IMPLEMENT_MODEL" {
			return variable.Value
		}
	}
	return ""
}

func TestWorkspaceProviderBootstrapPrecedenceAndRedaction(t *testing.T) {
	for _, source := range []string{"repository", "subscription", "platform"} {
		t.Run(source, func(t *testing.T) {
			platform := map[string]string{"OPENAI_API_KEY": "platform-openai-private", "ANTHROPIC_API_KEY": "platform-anthropic-private", "CEREBRAS_API_KEY": "platform-cerebras-private", "UNKNOWN_KEY": "platform-unknown-private"}
			var options []WorkspaceServiceOption
			options = append(options, WithWorkspaceProviderBootstrap(platform, "cerebras:gpt-oss-120b"))
			if source == "repository" {
				secret, _ := ProviderCredentialEgressSecret("ANTHROPIC_API_KEY", "repository-private")
				options = append(options, WithWorkspaceAgentEnvironment(&boundSecretsAgentEnvironmentProvider{bound: []sandbox.EgressProxySecret{secret}, staticAgentEnvironmentProvider: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{ProxyBound: []string{"ANTHROPIC_API_KEY"}}}}))
			}
			if source != "platform" {
				options = append(options, WithWorkspaceProviderConnections(&workspaceProviderResolver{connections: map[string]*ResolvedProviderConnection{ProviderConnectionProviderClaude: {Provider: ProviderConnectionProviderClaude, AccessToken: "subscription-private"}}}))
			}
			s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, options...)
			binding, err := s.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("boot"))
			require.NoError(t, err)
			if source == "platform" {
				require.Equal(t, "cerebras:gpt-oss-120b", bootstrapModel(binding.environment))
			} else {
				require.Equal(t, "anthropic:claude-sonnet-4-6", bootstrapModel(binding.environment))
			}
			if source == "repository" {
				secret, _ := ProviderCredentialEgressSecret("ANTHROPIC_API_KEY", "repository-private")
				require.Contains(t, binding.egress.Secrets, secret)
			}
			if source == "subscription" {
				require.Contains(t, binding.egress.SecretNames(), "ANTHROPIC_AUTH_TOKEN")
				require.NotContains(t, binding.egress.SecretNames(), "ANTHROPIC_API_KEY")
			}
			require.NotContains(t, binding.egress.SecretNames(), "UNKNOWN_KEY")
			profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
			require.NoError(t, err)
			files, err := json.Marshal(binding.files)
			require.NoError(t, err)
			require.NotContains(t, profile, "private")
			require.NotContains(t, string(files), "private")
			require.Empty(t, binding.environment.Secrets)
			for _, secret := range binding.egress.Secrets {
				require.NotEmpty(t, secret.Hosts)
				require.NotEmpty(t, secret.MatchHeaders)
			}
		})
	}
}

func TestWorkspaceProviderBootstrapDefaultsAndExplicitChoice(t *testing.T) {
	for _, tc := range []struct{ name, key, value, pin, want string }{
		{"openai", "OPENAI_API_KEY", "real-openai", "", "openai:gpt-6-luna"},
		{"anthropic", "ANTHROPIC_API_KEY", "real-anthropic", "", "anthropic:claude-sonnet-4-6"},
		{"cerebras", "CEREBRAS_API_KEY", "real-cerebras", "", "cerebras:gpt-oss-120b"},
		{"placeholder", "OPENAI_API_KEY", "placeholder-pending-seed", "", ""},
		{"proxy-placeholder", "OPENAI_API_KEY", sandbox.EgressProxyPlaceholder("OPENAI_API_KEY"), "", ""},
		{"unsupported", "UNKNOWN_KEY", "real-unsupported", "", ""},
		{"unavailable pin", "CEREBRAS_API_KEY", "real-cerebras", "openai:gpt-6-luna", ""},
		{"malformed pin", "CEREBRAS_API_KEY", "real-cerebras", "invalid", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceProviderBootstrap(map[string]string{tc.key: tc.value}, tc.pin))
			binding, err := s.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("boot"))
			require.NoError(t, err)
			require.Equal(t, tc.want, bootstrapModel(binding.environment))
			profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
			require.NoError(t, err)
			command := exec.Command("/bin/sh", "-c", profile+"\n"+workspaceCodingModelFallbackScript()+"\nprintf '%s' \"${SMITHERS_CODING_IMPLEMENT_MODEL-}\"")
			command.Env = []string{}
			output, err := command.CombinedOutput()
			require.NoError(t, err, string(output))
			require.Equal(t, tc.want, string(output), "unavailable explicit pin must not silently switch provider in the guest")
		})
	}
	for _, value := range []string{"", "anthropic:explicit-owner-model"} {
		t.Run("explicit="+value, func(t *testing.T) {
			env := &boundSecretsAgentEnvironmentProvider{staticAgentEnvironmentProvider: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{Env: []AgentEnvironmentVariable{{Name: "SMITHERS_CODING_IMPLEMENT_MODEL", Value: value}}}}}
			s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceAgentEnvironment(env), WithWorkspaceProviderBootstrap(map[string]string{"OPENAI_API_KEY": "real-key"}, ""))
			binding, err := s.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("boot"))
			require.NoError(t, err)
			require.Equal(t, value, bootstrapModel(binding.environment))
		})
	}
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceProviderBootstrap(map[string]string{"OPENAI_API_KEY": "real-key"}, ""))
	for _, which := range []string{"golden", "agent"} {
		workspace := sampleDBWorkspace(which)
		if which == "golden" {
			workspace.RepositoryID = 0
			workspace.UserID = 0
		} else {
			workspace.Kind = "agent"
		}
		binding, err := s.resolveWorkspaceProviderBindings(context.Background(), workspace)
		require.NoError(t, err)
		require.Empty(t, binding.egress.Secrets)
		require.Empty(t, bootstrapModel(binding.environment))
	}
}

func TestWorkspaceProviderBootstrapPreservesSetupOnlySecret(t *testing.T) {
	env := &boundSecretsAgentEnvironmentProvider{staticAgentEnvironmentProvider: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{Secrets: map[string]string{"OPENAI_API_KEY": "setup-only-private"}}}}
	resolver := &workspaceProviderResolver{connections: map[string]*ResolvedProviderConnection{ProviderConnectionProviderCodex: {AccessToken: "subscription-private"}}}
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceAgentEnvironment(env), WithWorkspaceProviderConnections(resolver), WithWorkspaceProviderBootstrap(map[string]string{"OPENAI_API_KEY": "platform-private"}, ""))
	binding, err := s.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("boot"))
	require.NoError(t, err)
	require.Empty(t, binding.egress.Secrets)
	require.Empty(t, bootstrapModel(binding.environment))
	require.NotContains(t, resolver.calls, ProviderConnectionProviderCodex)
}

func TestWorkspaceCodingModelFallbackOnlyChangesPublicModel(t *testing.T) {
	for _, tc := range []struct {
		env  []string
		want string
	}{
		{nil, ""},
		{[]string{"OPENAI_API_KEY=" + sandbox.EgressProxyPlaceholder("OPENAI_API_KEY")}, "openai:gpt-6-luna"},
		{[]string{"CEREBRAS_API_KEY=placeholder-pending-seed"}, ""},
		{[]string{"OPENAI_API_KEY=private-owner-value", "SMITHERS_CODING_IMPLEMENT_MODEL=owner:chosen"}, "owner:chosen"},
		{[]string{"OPENAI_API_KEY=private-owner-value", "SMITHERS_CODING_IMPLEMENT_MODEL="}, ""},
	} {
		command := exec.Command("/bin/sh", "-c", workspaceCodingModelFallbackScript()+"\nprintf '%s' \"${SMITHERS_CODING_IMPLEMENT_MODEL-}\"")
		command.Env = tc.env
		if command.Env == nil {
			command.Env = []string{}
		}
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		require.Equal(t, tc.want, string(output))
		require.NotContains(t, string(output), "private")
	}
	require.NotContains(t, workspaceCodingModelFallbackScript(), "StartSandbox")
	require.NotContains(t, strings.ToLower(workspaceCodingModelFallbackScript()), "curl")
}
