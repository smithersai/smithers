package config

import "strings"

const (
	AuthModeSelfHosted  = "selfhost"
	AuthModeMultitenant = "multitenant"
)

// IsSingleOwner reports whether composition explicitly selected the trusted,
// exactly-one-owner identity boundary. Deployment environment names never
// select an identity topology.
func IsSingleOwner(auth AuthConfig) bool {
	return strings.EqualFold(strings.TrimSpace(auth.Mode), AuthModeSelfHosted)
}
