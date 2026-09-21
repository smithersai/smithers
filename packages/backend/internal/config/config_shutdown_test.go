package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestLoad_SSHShutdownDrainTimeoutDefault verifies the SSH shutdown drain timeout
// defaults to "30s" as specified in the SSH-003 graceful shutdown plan.
func TestLoad_SSHShutdownDrainTimeoutDefault(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "30s", cfg.SSH.ShutdownDrainTimeout,
		"ssh.shutdown_drain_timeout should default to 30s")
}

// TestLoad_SSHShutdownDrainTimeoutEnvOverride verifies SMITHERS_SSH_SHUTDOWN_DRAIN_TIMEOUT
// overrides the default drain timeout.
func TestLoad_SSHShutdownDrainTimeoutEnvOverride(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_SSH_SHUTDOWN_DRAIN_TIMEOUT", "45s")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "45s", cfg.SSH.ShutdownDrainTimeout,
		"SMITHERS_SSH_SHUTDOWN_DRAIN_TIMEOUT=45s should override default")
}

func TestLoad_ServerShutdownTimeoutDefault(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "30s", cfg.Server.ShutdownTimeout,
		"server.shutdown_timeout should default to 30s")
}

func TestLoad_ServerShutdownTimeoutEnvOverride(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_SERVER_SHUTDOWN_TIMEOUT", "45s")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "45s", cfg.Server.ShutdownTimeout,
		"SMITHERS_SERVER_SHUTDOWN_TIMEOUT=45s should override default")
}
