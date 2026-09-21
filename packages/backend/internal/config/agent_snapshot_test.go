package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoad_AgentsEnabledWithSnapshotRemainsEnabled(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_FEATURE_FLAGS_AGENTS", "true")
	t.Setenv("SMITHERS_SANDBOX_AGENT_SNAPSHOT_ID", " msbs_agent_release ")

	cfg, err := Load("")
	require.NoError(t, err)
	require.NotNil(t, cfg)
	assert.True(t, cfg.FeatureFlags.Agents)
	assert.Equal(t, " msbs_agent_release ", cfg.Sandbox.AgentSnapshotID)
}

func TestLoad_AgentsEnabledWithoutSnapshotReturnsExplicitError(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_FEATURE_FLAGS_AGENTS", "true")

	cfg, err := Load("")
	require.Error(t, err)
	assert.Nil(t, cfg)
	assert.Contains(t, err.Error(), "feature_flags.agents requires sandbox.agent_snapshot_id")
	assert.Contains(t, err.Error(), "SMITHERS_SANDBOX_AGENT_SNAPSHOT_ID")
}
