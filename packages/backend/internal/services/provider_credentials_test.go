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
