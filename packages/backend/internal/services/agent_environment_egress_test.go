package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func TestAgentEnvironmentService_SecretBindingsRoundTripAndOnlyBoundSecretsReachTheProxy(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	store := &agentEnvironmentTestQuerier{now: now}
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	service := NewAgentEnvironmentService(store, codec)
	actor := &db.User{ID: 7}

	saved, err := service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", AgentEnvironmentSecretWrite{
		Name: "WAREHOUSE_TOKEN", Value: "wh-real",
		Hosts: []string{" Warehouse.Internal.Example ", "warehouse.internal.example"}, MatchHeaders: []string{"Authorization"},
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"warehouse.internal.example"}, saved.Hosts, "normalised and deduplicated")
	assert.Equal(t, []string{"authorization"}, saved.MatchHeaders)
	assert.True(t, saved.ProxyBound())
	encoded, err := json.Marshal(saved)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "wh-real")
	assert.Contains(t, string(encoded), `"hosts":["warehouse.internal.example"]`)

	bound, err := service.LoadProxyBoundSecrets(context.Background(), 42)
	require.NoError(t, err)
	require.Len(t, bound, 1)
	assert.Equal(t, "WAREHOUSE_TOKEN", bound[0].Name)
	assert.Equal(t, "wh-real", bound[0].Value)
	assert.Equal(t, []string{"warehouse.internal.example"}, bound[0].Hosts)

	// An unbound secret stays on the legacy path and is invisible to the proxy loader.
	_, err = service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", AgentEnvironmentSecretWrite{Name: "LEGACY", Value: "plain"})
	require.NoError(t, err)
	bound, err = service.LoadProxyBoundSecrets(context.Background(), 42)
	require.NoError(t, err)
	assert.Empty(t, bound, "the test querier keeps one row; the unbound replacement is not proxy-visible")
}

func TestAgentEnvironmentService_RejectsUnenforceableBindings(t *testing.T) {
	t.Parallel()
	store := &agentEnvironmentTestQuerier{now: time.Now()}
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	service := NewAgentEnvironmentService(store, codec)
	actor := &db.User{ID: 7}
	cases := map[string]AgentEnvironmentSecretWrite{
		"hosts without headers": {Name: "K", Value: "v", Hosts: []string{"a.example"}},
		"headers without hosts": {Name: "K", Value: "v", MatchHeaders: []string{"authorization"}},
		"host with scheme":      {Name: "K", Value: "v", Hosts: []string{"https://a.example"}, MatchHeaders: []string{"authorization"}},
		"bad header":            {Name: "K", Value: "v", Hosts: []string{"a.example"}, MatchHeaders: []string{"not a header"}},
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", input)
			require.Error(t, err)
		})
	}
}
