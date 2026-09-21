package alertregistry

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoad_ParsesEmbeddedRegistry(t *testing.T) {
	t.Parallel()

	reg, err := Load()
	require.NoError(t, err)
	require.NotEmpty(t, reg.Alerts)
}

func TestLookup_MatchesEnvironmentSuffixAndLongestPrefix(t *testing.T) {
	t.Parallel()

	reg, err := Parse([]byte(`{"alerts":[
		{"policyDisplayNamePrefix":"Smithers Workflow Push-Hook Load Failures","runbook":"a.md","workflow":"w.tsx","remediable":true,"maxAutoAttemptsPerDay":2},
		{"policyDisplayNamePrefix":"Smithers Workflow Push-Hook Load Failures Extended","runbook":"b.md","workflow":"w.tsx","remediable":true,"maxAutoAttemptsPerDay":2}
	]}`))
	require.NoError(t, err)

	entry := reg.Lookup("Smithers Workflow Push-Hook Load Failures - prod")
	require.NotNil(t, entry)
	assert.Equal(t, "a.md", entry.Runbook)

	entry = reg.Lookup("Smithers Workflow Push-Hook Load Failures Extended - prod")
	require.NotNil(t, entry)
	assert.Equal(t, "b.md", entry.Runbook)

	assert.Nil(t, reg.Lookup("Unknown Policy - prod"))
	assert.Nil(t, reg.Lookup(""))
}

func TestParse_RejectsInvalidRegistries(t *testing.T) {
	t.Parallel()

	_, err := Parse([]byte(`not json`))
	assert.Error(t, err)

	_, err = Parse([]byte(`{"alerts":[{"policyDisplayNamePrefix":"","runbook":"a.md"}]}`))
	assert.Error(t, err)

	_, err = Parse([]byte(`{"alerts":[
		{"policyDisplayNamePrefix":"A","runbook":"a.md"},
		{"policyDisplayNamePrefix":"a","runbook":"b.md"}
	]}`))
	assert.Error(t, err, "duplicate prefixes must be rejected")

	_, err = Parse([]byte(`{"alerts":[{"policyDisplayNamePrefix":"A","runbook":""}]}`))
	assert.Error(t, err)

	_, err = Parse([]byte(`{"alerts":[{"policyDisplayNamePrefix":"A","runbook":"a.md","remediable":true,"workflow":""}]}`))
	assert.Error(t, err)
}

func TestPolicySlug(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "smithers-high-error-rate", PolicySlug("Smithers High Error Rate - prod"))
	assert.Equal(t, "smithers-workflow-push-hook-load-failures", PolicySlug("Smithers Workflow Push-Hook Load Failures - prod"))
	assert.Equal(t, "smithers-gcs-error-rate-high", PolicySlug("Smithers GCS Error Rate High"))
}
