package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Secret Manager holds "placeholder-pending-h1-credential-seed" until a real
// credential is provisioned. That string is non-empty, so every "is it set?"
// check treated it as configured and production injected it into every agent
// VM as ANTHROPIC_API_KEY. The VM selects a provider by env-var PRESENCE, so
// the placeholder won, every model call came back 401 "invalid x-api-key", and
// the agent session sat active forever with no reply and no error — while
// CEREBRAS_API_KEY, the one credential that was real, went unused.
func TestIsUsableProviderCredential(t *testing.T) {
	t.Parallel()

	assert.False(t, IsUsableProviderCredential(""))
	assert.False(t, IsUsableProviderCredential("   "))
	assert.False(t, IsUsableProviderCredential("placeholder-pending-h1-credential-seed"))
	assert.False(t, IsUsableProviderCredential("PLACEHOLDER"))
	assert.False(t, IsUsableProviderCredential("changeme"))
	assert.False(t, IsUsableProviderCredential("<your-api-key>"))
	assert.False(t, IsUsableProviderCredential("TODO"))

	assert.True(t, IsUsableProviderCredential("sk-ant-abc123"))
	assert.True(t, IsUsableProviderCredential("csk-abc123"))
	assert.True(t, IsUsableProviderCredential("  sk-abc123  "))
}

func TestUsableProviderCredentials_DropsPlaceholders(t *testing.T) {
	t.Parallel()

	usable := UsableProviderCredentials(map[string]string{
		"ANTHROPIC_API_KEY":  "placeholder-pending-h1-credential-seed",
		"OPENAI_API_KEY":     "placeholder-pending-h1-credential-seed",
		"OPENROUTER_API_KEY": "",
		"CEREBRAS_API_KEY":   " csk-real ",
		"":                   "orphan",
	})

	assert.Equal(t, map[string]string{"CEREBRAS_API_KEY": "csk-real"}, usable)
}

func TestHasUsableProviderCredential(t *testing.T) {
	t.Parallel()

	assert.False(t, HasUsableProviderCredential(nil))
	assert.False(t, HasUsableProviderCredential(map[string]string{
		"ANTHROPIC_API_KEY": "placeholder-pending-h1-credential-seed",
		"OPENAI_API_KEY":    "",
	}))
	assert.True(t, HasUsableProviderCredential(map[string]string{
		"ANTHROPIC_API_KEY": "placeholder-pending-h1-credential-seed",
		"CEREBRAS_API_KEY":  "csk-real",
	}))
	assert.True(t, HasUsableProviderCredential(map[string]string{
		"ANTHROPIC_AUTH_TOKEN": "smithers_subscription_token",
	}))
	// A repository secret is a legitimate source, not just the platform map.
	assert.True(t, HasUsableProviderCredential(map[string]string{
		"GOOGLE_API_KEY": "AIza-real",
	}))
}
