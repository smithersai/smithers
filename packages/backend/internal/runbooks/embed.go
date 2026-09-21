// Package runbooks embeds the alert auto-remediation registry so the Go API
// can load it without any codegen while keeping docs/runbooks/registry.json
// the single source of truth (also read directly by
// .smithers/workflows/remediate-runner.ts).
package runbooks

import _ "embed"

// RegistryJSON is the raw contents of registry.json, mapping every GCP Cloud
// Monitoring alert policy display-name prefix to its runbook and remediation
// workflow. Parsed by internal/services/alertregistry.
//
//go:embed registry.json
var RegistryJSON []byte
