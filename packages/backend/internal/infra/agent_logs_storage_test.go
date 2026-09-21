package infra_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Agent-log retention bucket wiring
//
// Terraform provisions a dedicated retention-limited agent-logs bucket
// (90-day lifecycle delete). These tests pin the full injection chain —
// storage module → prod environment → deploy module → Helm env → runtime
// config — so archived agent transcripts land in that bucket instead of the
// versioned long-retention blobs bucket.
// Reference: docs/specs/infra.md §6.3
// ---------------------------------------------------------------------------

func readInfraFile(t *testing.T, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{"..", ".."}, parts...)...)
	content, err := os.ReadFile(path)
	require.NoError(t, err)
	return string(content)
}

// TestStorageModule_AgentLogsBucketHasRetentionLifecycle verifies the
// dedicated bucket exists and ages objects out via a lifecycle delete rule.
func TestStorageModule_AgentLogsBucketHasRetentionLifecycle(t *testing.T) {
	t.Parallel()

	mainTf := readInfraFile(t, "infra", "terraform", "modules", "storage", "main.tf")
	assert.Contains(t, mainTf, `"google_storage_bucket" "agent_logs"`,
		"storage module must define the dedicated agent-logs bucket")
	assert.Contains(t, mainTf, "age = var.agent_logs_retention_days",
		"agent-logs bucket must delete objects after the retention period")

	variablesTf := readInfraFile(t, "infra", "terraform", "modules", "storage", "variables.tf")
	assert.Contains(t, variablesTf, `variable "agent_logs_retention_days"`)
	assert.Contains(t, variablesTf, "default     = 90")
}

// TestDeployModule_InjectsAgentLogsBucketEnv verifies the deploy module passes
// the dedicated bucket into the API pods via Helm.
func TestDeployModule_InjectsAgentLogsBucketEnv(t *testing.T) {
	t.Parallel()

	mainTf := readInfraFile(t, "infra", "terraform", "modules", "deploy", "main.tf")
	assert.Contains(t, mainTf, `name  = "api.env.SMITHERS_BLOB_AGENT_LOGS_GCS_BUCKET"`,
		"deploy module must set the agent-logs bucket env var on the API")
	assert.Contains(t, mainTf, "value = var.agent_logs_gcs_bucket")

	variablesTf := readInfraFile(t, "infra", "terraform", "modules", "deploy", "variables.tf")
	assert.Contains(t, variablesTf, `variable "agent_logs_gcs_bucket"`)
	assert.Contains(t, variablesTf, "agent_logs_gcs_bucket must not be empty",
		"deploy module must fail closed when the agent-logs bucket is absent")
}

// TestProdEnvironment_PassesAgentLogsBucketToDeploy verifies production wires
// the storage module's agent-logs bucket into the deploy module (previously
// only the blobs bucket was passed, so transcripts landed in versioned
// long-retention storage).
func TestProdEnvironment_PassesAgentLogsBucketToDeploy(t *testing.T) {
	t.Parallel()

	mainTf := readInfraFile(t, "infra", "terraform", "environments", "prod", "main.tf")
	assert.Contains(t, mainTf, "agent_logs_gcs_bucket                   = module.storage.agent_logs_bucket_name",
		"prod deploy module call must pass the dedicated agent-logs bucket")
}

// TestHelmValues_DeclareAgentLogsBucketEnv verifies the chart documents the
// env contract the deploy module injects.
func TestHelmValues_DeclareAgentLogsBucketEnv(t *testing.T) {
	t.Parallel()

	values := readInfraFile(t, "infra", "helm", "smithers", "values.yaml")
	assert.Contains(t, values, "SMITHERS_BLOB_AGENT_LOGS_GCS_BUCKET:",
		"helm values must declare the agent-logs bucket env var")
}

// TestIamModule_GrantsWorkloadAccessToAgentLogsBucket verifies the workload SA
// can actually write to the dedicated bucket the API now targets.
func TestIamModule_GrantsWorkloadAccessToAgentLogsBucket(t *testing.T) {
	t.Parallel()

	mainTf := readInfraFile(t, "infra", "terraform", "modules", "iam", "main.tf")
	assert.Contains(t, mainTf, "var.agent_logs_bucket_name",
		"iam module must grant the workload SA access to the agent-logs bucket")

	// Transcript archives overwrite a deterministic per-session key on each
	// terminal transition; objectCreator (create-only) 403s on overwrite once
	// the object exists, so the grant must be objectAdmin.
	grantIdx := strings.Index(mainTf, "var.agent_logs_bucket_name")
	require.GreaterOrEqual(t, grantIdx, 0)
	assert.Contains(t, mainTf[grantIdx:], `role   = "roles/storage.objectAdmin"`,
		"agent-logs grant must allow overwriting existing transcript objects")
}
