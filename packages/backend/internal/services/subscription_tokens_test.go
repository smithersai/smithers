package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func chatGPTAccessTokenForTest(t *testing.T) string {
	t.Helper()
	claims, err := json.Marshal(map[string]any{"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct_1", "chatgpt_plan_type": "pro"}})
	require.NoError(t, err)
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"RS256"}`)) + "." + enc(claims) + "." + enc([]byte("sig"))
}

func TestIsSubscriptionToken(t *testing.T) {
	t.Parallel()
	chatgpt := chatGPTAccessTokenForTest(t)
	for _, tc := range []struct {
		name, value string
		want        bool
	}{
		{"ANTHROPIC_AUTH_TOKEN", "sk-ant-oat01-abcdef", true},
		{"CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-abcdef", true},
		{"ANYTHING", "  sk-ant-oat01-abcdef\n", true},
		{"CLAUDE_REFRESH", "sk-ant-ort01-abcdef", true},
		{"CLAUDE_CODE_OAUTH_TOKEN", "whatever", true},
		{"OPENAI_CODEX_ACCESS_TOKEN", "whatever", true},
		{"CODEX_TOKEN", chatgpt, true},
		{"CODEX_AUTH", `{"auth_mode":"chatgpt","tokens":{"access_token":"a","refresh_token":"r"}}`, true},
		{"ANTHROPIC_API_KEY", "sk-ant-api03-abcdef", false},
		{"ANTHROPIC_AUTH_TOKEN", "gateway-bearer-token", false},
		{"OPENAI_API_KEY", "sk-proj-abcdef", false},
		{"GITHUB_TOKEN", "a.b.c", false},
		{"CONFIG", `{"auth_mode":"apikey"}`, false},
	} {
		assert.Equal(t, tc.want, isSubscriptionToken(tc.name, tc.value), "%s=%s", tc.name, tc.value)
	}
}

func requireSubscriptionTokenRefused(t *testing.T, err error) {
	t.Helper()
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 403, apiErr.Status)
	assert.Contains(t, apiErr.Message, "feature not available")
}

// Hosted Plue (flag off, the default) refuses to store a Claude or ChatGPT
// subscription token through any secret or variable path; a self-hosted
// deployment with the flag on stores it.
func TestSubscriptionTokensRefusedUnlessFlagOn(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	actor := &db.User{ID: 1}
	const token = "sk-ant-oat01-subscription"
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)

	type write func(allowed bool) error
	for name, fn := range map[string]write{
		"repo secret": func(allowed bool) error {
			_, err := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}, WithSecretSubscriptionTokens(allowed)).SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_AUTH_TOKEN", token)
			return err
		},
		"org secret": func(allowed bool) error {
			_, err := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}, WithSecretSubscriptionTokens(allowed)).SetOrgSecret(ctx, actor, "acme", "CLAUDE_CODE_OAUTH_TOKEN", token)
			return err
		},
		"repo variable": func(allowed bool) error {
			_, err := NewVariableService(&mockVariableQuerier{}, WithVariableSubscriptionTokens(allowed)).SetVariable(ctx, actor, "alice", "demo", "ANTHROPIC_AUTH_TOKEN", token)
			return err
		},
		"org variable": func(allowed bool) error {
			_, err := NewVariableService(&mockVariableQuerier{}, WithVariableSubscriptionTokens(allowed)).SetOrgVariable(ctx, actor, "acme", "ANTHROPIC_AUTH_TOKEN", token)
			return err
		},
		"agent environment secret": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironmentSecret(ctx, &db.User{ID: 7}, "alice", "demo", AgentEnvironmentSecretWrite{Name: "CLAUDE_CODE_OAUTH_TOKEN", Value: token})
			return err
		},
		"agent environment bulk secret": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{Secrets: []AgentEnvironmentSecretWrite{{Name: "ANTHROPIC_AUTH_TOKEN", Value: token}}})
			return err
		},
		"agent environment variable": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{Env: []AgentEnvironmentVariable{{Name: "ANTHROPIC_AUTH_TOKEN", Value: token}}})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			requireSubscriptionTokenRefused(t, fn(false))
			require.NoError(t, fn(true))
		})
	}

	// The default constructor is the hosted posture.
	_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_AUTH_TOKEN", token)
	requireSubscriptionTokenRefused(t, err)
	// An ordinary API key is unaffected.
	_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_API_KEY", "sk-ant-api03-key")
	require.NoError(t, err)
}
