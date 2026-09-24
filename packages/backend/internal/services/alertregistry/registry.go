// Package alertregistry maps GCP Cloud Monitoring alert policies to runbooks
// and auto-remediation workflows. The registry data is Plue's
// docs/runbooks/registry.json, embedded through internal/runbooks.
package alertregistry

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/runbooks"
)

// Entry maps one alert policy (matched by display-name prefix, since policy
// display names are "<prefix> - <environment>") to its runbook and workflow.
type Entry struct {
	PolicyDisplayNamePrefix string `json:"policyDisplayNamePrefix"`
	Runbook                 string `json:"runbook"`
	Workflow                string `json:"workflow"`
	Remediable              bool   `json:"remediable"`
	MaxAutoAttemptsPerDay   int    `json:"maxAutoAttemptsPerDay"`
}

// Registry holds the parsed alert → runbook → workflow mapping.
type Registry struct {
	Alerts []Entry `json:"alerts"`
}

// Load parses the embedded registry.
func Load() (*Registry, error) {
	return Parse(runbooks.RegistryJSON)
}

// Parse parses registry JSON and validates basic invariants.
func Parse(data []byte) (*Registry, error) {
	var reg Registry
	if err := json.Unmarshal(data, &reg); err != nil {
		return nil, fmt.Errorf("parse alert remediation registry: %w", err)
	}
	seen := make(map[string]struct{}, len(reg.Alerts))
	for i, entry := range reg.Alerts {
		prefix := strings.TrimSpace(entry.PolicyDisplayNamePrefix)
		if prefix == "" {
			return nil, fmt.Errorf("alert registry entry %d: empty policyDisplayNamePrefix", i)
		}
		if _, dup := seen[strings.ToLower(prefix)]; dup {
			return nil, fmt.Errorf("alert registry entry %d: duplicate policyDisplayNamePrefix %q", i, prefix)
		}
		seen[strings.ToLower(prefix)] = struct{}{}
		if strings.TrimSpace(entry.Runbook) == "" {
			return nil, fmt.Errorf("alert registry entry %q: empty runbook", prefix)
		}
		if entry.Remediable && strings.TrimSpace(entry.Workflow) == "" {
			return nil, fmt.Errorf("alert registry entry %q: remediable but no workflow", prefix)
		}
	}
	return &reg, nil
}

// Lookup returns the registry entry whose display-name prefix matches the
// given policy display name (e.g. "Smithers High Error Rate - prod"). The
// longest matching prefix wins. Returns nil when no entry matches.
func (r *Registry) Lookup(policyDisplayName string) *Entry {
	if r == nil {
		return nil
	}
	name := strings.ToLower(strings.TrimSpace(policyDisplayName))
	if name == "" {
		return nil
	}
	var best *Entry
	for i := range r.Alerts {
		prefix := strings.ToLower(strings.TrimSpace(r.Alerts[i].PolicyDisplayNamePrefix))
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		if best == nil || len(prefix) > len(strings.TrimSpace(best.PolicyDisplayNamePrefix)) {
			best = &r.Alerts[i]
		}
	}
	return best
}

// PolicySlug converts a policy display name into a stable slug for remediation
// artifacts (environment suffix stripped).
func PolicySlug(policyDisplayName string) string {
	name := strings.TrimSpace(policyDisplayName)
	if idx := strings.LastIndex(name, " - "); idx > 0 {
		name = name[:idx]
	}
	name = strings.ToLower(name)
	var b strings.Builder
	lastDash := true
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
