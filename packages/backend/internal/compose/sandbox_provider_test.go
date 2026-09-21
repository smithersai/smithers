package compose

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestBuildSandboxProviderConstructsMicrosandbox(t *testing.T) {
	provider, err := buildSandboxProvider(config.SandboxConfig{
		Provider:               string(sandbox.ProviderMicrosandbox),
		MicrosandboxControlURL: "http://microsandbox.test",
		MicrosandboxAPIKey:     "controller-key",
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, provider)
	assert.Equal(t, sandbox.ProviderMicrosandbox, provider.Name())
}

func TestBuildSandboxProviderRejectsPartialMTLS(t *testing.T) {
	provider, err := buildSandboxProvider(config.SandboxConfig{
		Provider:               string(sandbox.ProviderMicrosandbox),
		MicrosandboxControlURL: "https://microsandbox.test",
		MicrosandboxAPIKey:     "controller-key",
		MicrosandboxClientCert: "/missing/client.crt",
		MicrosandboxServerName: "microsandbox-controller.smithers.svc",
	}, nil)
	assert.Nil(t, provider)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "mTLS requires cert, key, and CA files")
}
