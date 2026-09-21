package sandbox

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEgressProxySecretValidateFailsClosed(t *testing.T) {
	t.Parallel()
	valid := EgressProxySecret{Name: "ANTHROPIC_API_KEY", Value: "v", Hosts: []string{"api.anthropic.com"}, MatchHeaders: []string{"x-api-key"}}
	require.NoError(t, valid.Validate())
	cases := map[string]EgressProxySecret{
		"bad name":       {Name: "not a name", Value: "v", Hosts: []string{"a.example"}, MatchHeaders: []string{"h"}},
		"no value":       {Name: "K", Hosts: []string{"a.example"}, MatchHeaders: []string{"h"}},
		"no hosts":       {Name: "K", Value: "v", MatchHeaders: []string{"h"}},
		"host with path": {Name: "K", Value: "v", Hosts: []string{"a.example/v1"}, MatchHeaders: []string{"h"}},
		"host with port": {Name: "K", Value: "v", Hosts: []string{"a.example:443"}, MatchHeaders: []string{"h"}},
		"scheme":         {Name: "K", Value: "v", Hosts: []string{"https://a.example"}, MatchHeaders: []string{"h"}},
		"no location":    {Name: "K", Value: "v", Hosts: []string{"a.example"}},
	}
	for name, secret := range cases {
		t.Run(name, func(t *testing.T) { require.Error(t, secret.Validate()) })
	}
}

func TestValidEgressHostAcceptsNamesWildcardsAndCIDRs(t *testing.T) {
	t.Parallel()
	for _, host := range []string{"api.anthropic.com", "*.anthropic.com", "127.0.0.0/8", "10.0.0.0/8", "Api.OpenAI.com"} {
		assert.True(t, ValidEgressHost(host), host)
	}
	for _, host := range []string{"", "localhost", "a b.example", "user@a.example", "-bad.example", "a.example."} {
		assert.False(t, ValidEgressHost(host), host)
	}
}

func TestEgressProxyPolicyRejectsDuplicateNamesAndListsThem(t *testing.T) {
	t.Parallel()
	policy := &EgressProxyPolicy{Enabled: true, Secrets: []EgressProxySecret{
		{Name: "B", Value: "v", Hosts: []string{"b.example"}, MatchHeaders: []string{"h"}},
		{Name: "A", Value: "v", Hosts: []string{"a.example"}, MatchHeaders: []string{"h"}},
	}}
	require.NoError(t, policy.Validate())
	assert.Equal(t, []string{"A", "B"}, policy.SecretNames())
	policy.Secrets = append(policy.Secrets, policy.Secrets[0])
	require.Error(t, policy.Validate())
	var disabled *EgressProxyPolicy
	require.NoError(t, disabled.Validate())
	assert.Nil(t, disabled.SecretNames())
}

func TestEgressProxySecretValueIsOmittedWhenEmpty(t *testing.T) {
	t.Parallel()
	payload, err := json.Marshal(EgressProxySecret{Name: "K", Hosts: []string{"a.example"}})
	require.NoError(t, err)
	assert.NotContains(t, string(payload), `"value"`)
	assert.Equal(t, "K", EgressProxyPlaceholder(" K "))
}
