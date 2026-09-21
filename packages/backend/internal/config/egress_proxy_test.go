package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The per-sandbox egress proxy is not configurable: every agent sandbox is
// created with it. A deployment that still exports the retired
// SMITHERS_SANDBOX_EGRESS_PROXY variable must keep booting, whatever its value.
func TestLoad_IgnoresRetiredEgressProxyVariable(t *testing.T) {
	for _, value := range []string{"off", "on", "enabled", ""} {
		t.Run("value="+value, func(t *testing.T) {
			clearConfigEnv(t)
			t.Setenv("SMITHERS_SANDBOX_EGRESS_PROXY", value)
			cfg, err := Load("")
			require.NoError(t, err)
			require.NotNil(t, cfg)
		})
	}
}
