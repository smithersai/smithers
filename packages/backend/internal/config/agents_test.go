package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAgentsNeverStartedTimeout(t *testing.T) {
	t.Setenv("SMITHERS_AGENT_NEVER_STARTED_TIMEOUT", "1h")
	cfg, err := Load("")
	require.NoError(t, err)
	require.Equal(t, "1h", cfg.Agents.NeverStartedTimeout)
	t.Setenv("SMITHERS_AGENT_NEVER_STARTED_TIMEOUT", "2h")
	cfg, err = Load("")
	require.NoError(t, err)
	require.Equal(t, "2h", cfg.Agents.NeverStartedTimeout)
	for _, value := range []string{"invalid", "0s", "-1h"} {
		t.Setenv("SMITHERS_AGENT_NEVER_STARTED_TIMEOUT", value)
		_, err = Load("")
		require.ErrorContains(t, err, "agents.never_started_timeout")
	}
}
