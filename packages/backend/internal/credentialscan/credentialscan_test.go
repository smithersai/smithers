package credentialscan

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestScanForCredentialMaterial(t *testing.T) {
	tests := []struct {
		name string
		text string
		rule string
		line int
	}{
		{name: "provider token", text: "safe line\nsk-ant-abcdefghijklmnopqrstuvwxyz", rule: "anthropic_api_key", line: 2},
		{name: "high entropy assignment", text: `api_key: "u9N4mK8pR2xV7qL5cB3jH6sT1wZ0dF4a"`, rule: "credential_assignment", line: 1},
		{name: "bearer literal", text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", rule: "bearer_literal", line: 1},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			finding := ScanForCredentialMaterial(test.text)
			if assert.NotNil(t, finding) {
				assert.Equal(t, test.rule, finding.Rule)
				assert.Equal(t, test.line, finding.Line)
			}
		})
	}
}

func TestScanForCredentialMaterialCatchesPrefixedEnvAssignments(t *testing.T) {
	// The canonical .env form prefixes the secret field with a service name:
	// DB_PASSWORD, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY. The keyword is glued
	// to the prefix with an underscore, which must not shield it from the
	// generic assignment rule.
	tests := []struct {
		name string
		text string
		line int
	}{
		{name: "prefixed password", text: "DB_PASSWORD=x9N4mK8pR2xV7qL5cB3jH6sT1wZ0dF4a", line: 1},
		{name: "prefixed token", text: "safe line\nGITHUB_TOKEN=u9N4mK8pR2xV7qL5cB3jH6sT1wZ0dF4a", line: 2},
		{name: "aws secret access key", text: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", line: 1},
		{name: "kebab prefix", text: "staging-api-key: x9N4mK8pR2xV7qL5cB3jH6sT1wZ0dF4a", line: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			finding := ScanForCredentialMaterial(test.text)
			if assert.NotNil(t, finding) {
				assert.Equal(t, "credential_assignment", finding.Rule)
				assert.Equal(t, test.line, finding.Line)
			}
		})
	}
}

func TestScanForCredentialMaterialAllowsReferences(t *testing.T) {
	clean := `
const token = process.env.GITHUB_TOKEN
headers: { Authorization: "Bearer ${SLACK_TOKEN}" }
apiKey: "your-api-key"
secret: connectors.github.token
`
	assert.Nil(t, ScanForCredentialMaterial(clean))
}

func TestScanForCredentialMaterialCatchesSmithersTokens(t *testing.T) {
	// The product's own tokens travel as `Authorization: token <pat>`, a
	// scheme no provider rule or `key = value` rule covers, so every minted
	// shape needs its own context-free rule.
	pat := "smithers_0123456789abcdef0123456789abcdef01234567"
	tests := []struct {
		name string
		text string
		line int
	}{
		{name: "header form", text: `fetch(url, { headers: { Authorization: "token ` + pat + `" } })`, line: 1},
		{name: "curl form", text: "curl -H 'Authorization: token " + pat + "' https://api.smithers.sh", line: 1},
		{name: "bare pat", text: "safe line\n" + pat, line: 2},
		{name: "oauth access token", text: "smithers_oat_" + strings.Repeat("ab", 32), line: 1},
		{name: "agent token", text: "smithers_agent_" + strings.Repeat("cd", 20), line: 1},
		{name: "gateway token", text: "smithers_gateway_" + strings.Repeat("ef", 20), line: 1},
		{name: "desktop token", text: "smithers_desk_" + strings.Repeat("01", 24), line: 1},
		{name: "sandbox token", text: "smithers_sandbox_NDI6MTc1ODA2NzIwMA.q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c", line: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			finding := ScanForCredentialMaterial(test.text)
			if assert.NotNil(t, finding) {
				assert.Equal(t, "smithers_token", finding.Rule)
				assert.Equal(t, test.line, finding.Line)
			}
		})
	}
}

func TestScanForCredentialMaterialAllowsSmithersIdentifiers(t *testing.T) {
	// The public build-cache read token is committed by design, and
	// snake_case identifiers share the prefix without being credentials.
	clean := "cache: smithers_cachero_" + strings.Repeat("0", 40) + "\nclient_id: smithers_first_party_apps\nsmithers_workflow_runs_total 3"
	assert.Nil(t, ScanForCredentialMaterial(clean))
}
