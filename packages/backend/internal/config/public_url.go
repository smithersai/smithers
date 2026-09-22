package config

import (
	"fmt"
	"net/url"
	"strings"
)

// PublicOrigin is the one externally reachable HTTP origin for links issued by
// the API. Listen and loopback callback addresses are separate concerns.
func PublicOrigin(cfg *Config) string {
	if cfg == nil {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(cfg.Server.PublicURL), "/")
}

// CanonicalOrigin validates and canonicalizes one exact browser Origin value.
// It deliberately does not equate localhost with an IP loopback alias: every
// trusted origin must be listed exactly as a browser will send it.
func CanonicalOrigin(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("parse origin: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" || parsed.Opaque != "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || strings.Contains(value, "#") || parsed.RawPath != "" {
		return "", fmt.Errorf("origin must contain only scheme and host")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", fmt.Errorf("origin must not contain a path")
	}
	return strings.ToLower(parsed.Scheme + "://" + parsed.Host), nil
}
