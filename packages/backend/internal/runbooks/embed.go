// Package runbooks embeds the alert auto-remediation registry so the Go API
// can load it without codegen. The source of truth is Plue's
// docs/runbooks/registry.json, next to the Terraform alert policies and the
// runbooks it names; this file is a copy. registry_drift_test.go fails when
// the copy and a local Plue checkout disagree.
package runbooks

import _ "embed"

// RegistryJSON is the raw contents of registry.json, mapping every GCP Cloud
// Monitoring alert policy display-name prefix to its runbook and remediation
// workflow. Parsed by internal/services/alertregistry.
//
//go:embed registry.json
var RegistryJSON []byte
