package alertregistry

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	require.NoError(t, err)
	// internal/services/alertregistry → repo root
	return filepath.Clean(filepath.Join(wd, "..", "..", ".."))
}

func TestLoad_ParsesEmbeddedRegistry(t *testing.T) {
	t.Parallel()

	reg, err := Load()
	require.NoError(t, err)
	require.NotEmpty(t, reg.Alerts)
}

func TestRegistry_EveryRunbookAndWorkflowExists(t *testing.T) {
	t.Parallel()

	reg, err := Load()
	require.NoError(t, err)

	root := repoRoot(t)
	for _, entry := range reg.Alerts {
		info, err := os.Stat(filepath.Join(root, entry.Runbook))
		assert.NoError(t, err, "runbook for %q must exist: %s", entry.PolicyDisplayNamePrefix, entry.Runbook)
		if err == nil {
			assert.False(t, info.IsDir(), "runbook %s must be a file", entry.Runbook)
		}
		if entry.Remediable {
			_, err := os.Stat(filepath.Join(root, entry.Workflow))
			assert.NoError(t, err, "workflow for %q must exist: %s", entry.PolicyDisplayNamePrefix, entry.Workflow)
		}
	}
}

// TestRegistry_CoversEveryMonitoringAlertPolicy parses the Terraform
// monitoring module and asserts every alert policy display-name prefix has a
// registry entry.
func TestRegistry_CoversEveryMonitoringAlertPolicy(t *testing.T) {
	t.Parallel()

	reg, err := Load()
	require.NoError(t, err)

	tfPath := filepath.Join(repoRoot(t), "infra", "terraform", "modules", "monitoring", "main.tf")
	raw, err := os.ReadFile(tfPath)
	require.NoError(t, err)

	// Alert policy display names look like:
	//   display_name = "Smithers High Error Rate - ${var.environment}"
	re := regexp.MustCompile(`display_name\s*=\s*"(Smithers [^"]+?) - \$\{var\.environment\}"`)
	matches := re.FindAllStringSubmatch(string(raw), -1)
	require.NotEmpty(t, matches, "expected alert policy display names in %s", tfPath)

	seen := map[string]struct{}{}
	for _, m := range matches {
		prefix := strings.TrimSpace(m[1])
		if _, dup := seen[prefix]; dup {
			continue
		}
		seen[prefix] = struct{}{}
		entry := reg.Lookup(prefix + " - prod")
		assert.NotNil(t, entry, "alert policy %q has no registry entry in docs/runbooks/registry.json", prefix)
	}
	// Sanity: the monitoring module currently defines 20+ policies.
	assert.GreaterOrEqual(t, len(seen), 20, "unexpectedly few alert policies parsed from %s", tfPath)
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
