package infra_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMicrosandboxWorkerDiskAndUpgradeSafety(t *testing.T) {
	prod := readInfraFile(t, "infra", "terraform", "environments", "prod", "main.tf")
	assert.Regexp(t, `(?m)^\s*relocation_disk_type\s*=\s*"hyperdisk-balanced"\s*$`, prod)
	assert.Contains(t, prod, `disk_size_gb               = local.sandbox_disk_size_gb`)

	assert.Contains(t, prod, `sandbox_disk_size_gb    = 250`)
	assert.Contains(t, prod, `sandbox_disk_reserve_gb = 50`)
	module := readInfraFile(t, "infra", "terraform", "modules", "gke-standard-sandbox", "main.tf")
	relocationStart := strings.Index(module, `resource "google_container_node_pool" "nested_kvm_relocation"`)
	systemStart := strings.Index(module, `resource "google_container_node_pool" "system"`)
	if assert.GreaterOrEqual(t, relocationStart, 0) && assert.Greater(t, systemStart, relocationStart) {
		relocation := module[relocationStart:systemStart]
		assert.Contains(t, relocation, "max_surge       = 0")
		assert.Contains(t, relocation, "max_unavailable = 1")
	}

	workerValues := readInfraFile(t, "infra", "helm", "microsandbox", "values.yaml")
	assert.Contains(t, workerValues, `terminationGracePeriodSeconds: 600`)
	assert.Contains(t, workerValues, `highWaterPercent: "60"`)
	assert.Contains(t, workerValues, `usableCapacityPercent: "80"`)

	workerTemplate := readInfraFile(t, "infra", "helm", "microsandbox", "templates", "worker.yaml")
	assert.Contains(t, workerTemplate, "priorityClassName: system-node-critical")
}
