package config

import "strings"

// PublicOrigin is the one externally reachable HTTP origin for links issued by
// the API. Listen and loopback callback addresses are separate concerns.
func PublicOrigin(cfg *Config) string {
	if cfg == nil {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(cfg.Server.PublicURL), "/")
}
