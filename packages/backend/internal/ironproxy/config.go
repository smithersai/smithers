// Package ironproxy renders iron-proxy (docs.iron.sh) configuration for the
// per-sandbox credential-substituting egress proxy and the guest-side
// environment that routes traffic through it.
//
// The package is pure: it never starts a process, touches the network, or
// reads secrets. Secret VALUES never enter a rendered config; the config
// names the proxy-process environment variable that carries each value
// (iron-proxy's `env` secret source), and the worker sets that variable on
// the proxy child process only.
package ironproxy

import (
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// DefaultUpstreamDenyCIDRs are the destinations the proxy must never dial on
// a sandbox's behalf: loopback, RFC 1918, carrier-grade NAT, link-local (which
// includes the GCP/AWS/Azure IMDS 169.254.169.254), the AWS IPv6 IMDS, the
// unspecified and benchmark ranges, multicast/reserved, IPv6 ULA and
// link-local, and IPv4-mapped IPv6 so the same ranges cannot be reached by
// spelling them as ::ffff:a.b.c.d.
var DefaultUpstreamDenyCIDRs = []string{
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"::/128",
	"::1/128",
	"::ffff:0.0.0.0/96",
	"fc00::/7",
	"fe80::/10",
	"fd00:ec2::254/128",
}

// SecretBinding maps one proxy-process environment variable to the upstream
// hosts and request locations where the guest's placeholder is swapped for it.
type SecretBinding struct {
	// EnvVar is the variable the worker sets on the proxy process.
	EnvVar string
	// ProxyValue is the placeholder the guest sends. Defaults to EnvVar.
	ProxyValue   string
	Hosts        []string
	MatchHeaders []string
	MatchQuery   bool
	MatchPath    bool
	// Require rejects requests to a bound host that do not carry the
	// placeholder, so a workload cannot bypass the swap with its own key.
	Require bool
}

// Spec is everything Render needs. Zero values pick the production defaults.
type Spec struct {
	// ListenAddr is the explicit-proxy (CONNECT / absolute-form / SOCKS5)
	// listener, for example "127.0.0.1:41000".
	ListenAddr string
	// HTTPListen, HTTPSListen, and MetricsListen are iron-proxy's other
	// listeners. They are always on: leaving them unset means the upstream
	// defaults (:80, :443, :9090), which collide with the worker's own
	// metrics server and with every other per-sandbox proxy on the host, so
	// Render requires explicit per-sandbox loopback addresses for all three.
	HTTPListen    string
	HTTPSListen   string
	MetricsListen string
	CACertPath    string
	CAKeyPath     string
	// AllowDomains is the allowlist; empty means "*".
	AllowDomains []string
	// AllowCIDRs extends the allowlist with IP ranges (tests use this to reach
	// a loopback upstream; production leaves it empty).
	AllowCIDRs []string
	// UpstreamDenyCIDRs overrides DefaultUpstreamDenyCIDRs when non-nil.
	UpstreamDenyCIDRs []string
	Secrets           []SecretBinding
	// MaxRequestBodyBytes bounds buffered request bodies. LLM prompts are
	// routinely larger than iron-proxy's 1 MiB default.
	MaxRequestBodyBytes int64
	// UpstreamResponseHeaderTimeout is a Go duration string; model providers
	// can take minutes before the first response byte.
	UpstreamResponseHeaderTimeout string
	LogLevel                      string
}

const (
	defaultMaxRequestBodyBytes           = 64 << 20
	defaultUpstreamResponseHeaderTimeout = "10m"
)

// Config mirrors the subset of iron-proxy's YAML schema this package emits.
// Field order matches iron-proxy.example.yaml so a rendered file reads like
// the upstream reference.
type Config struct {
	DNS        DNSConfig     `yaml:"dns"`
	Proxy      ProxyConfig   `yaml:"proxy"`
	Metrics    MetricsConfig `yaml:"metrics"`
	TLS        TLSConfig     `yaml:"tls"`
	Transforms []Transform   `yaml:"transforms"`
	Log        LogConfig     `yaml:"log"`
}

// MetricsConfig binds iron-proxy's Prometheus listener. The upstream schema
// has no "enabled" switch (verified against 0.49.0), so the only way to keep
// it off the shared :9090 is to give it a per-sandbox loopback address.
type MetricsConfig struct {
	Listen string `yaml:"listen"`
}

type DNSConfig struct {
	Enabled bool `yaml:"enabled"`
}

type ProxyConfig struct {
	HTTPListen                    string   `yaml:"http_listen"`
	HTTPSListen                   string   `yaml:"https_listen"`
	TunnelListen                  string   `yaml:"tunnel_listen"`
	MaxRequestBodyBytes           int64    `yaml:"max_request_body_bytes"`
	UpstreamResponseHeaderTimeout string   `yaml:"upstream_response_header_timeout"`
	UpstreamDenyCIDRs             []string `yaml:"upstream_deny_cidrs"`
}

type TLSConfig struct {
	Mode   string `yaml:"mode"`
	CACert string `yaml:"ca_cert"`
	CAKey  string `yaml:"ca_key"`
}

// Transform is one ordered pipeline stage: {name, config}.
type Transform struct {
	Name   string `yaml:"name"`
	Config any    `yaml:"config"`
}

type AllowlistConfig struct {
	Domains []string `yaml:"domains,omitempty"`
	CIDRs   []string `yaml:"cidrs,omitempty"`
}

type SecretsConfig struct {
	Secrets []SecretEntry `yaml:"secrets"`
}

type SecretEntry struct {
	Source  SecretSource  `yaml:"source"`
	Replace SecretReplace `yaml:"replace"`
	Rules   []SecretRule  `yaml:"rules"`
}

type SecretSource struct {
	Type string `yaml:"type"`
	Var  string `yaml:"var"`
}

type SecretReplace struct {
	ProxyValue   string   `yaml:"proxy_value"`
	MatchHeaders []string `yaml:"match_headers"`
	MatchQuery   bool     `yaml:"match_query,omitempty"`
	MatchPath    bool     `yaml:"match_path,omitempty"`
	Require      bool     `yaml:"require"`
}

type SecretRule struct {
	Host string `yaml:"host,omitempty"`
	CIDR string `yaml:"cidr,omitempty"`
}

type LogConfig struct {
	Level string `yaml:"level"`
}

var ErrInvalidSpec = errors.New("invalid iron-proxy spec")

// Render validates spec and returns the config. It fails closed on anything
// the proxy could not enforce: a missing listener or CA, an empty binding
// host, a blank env var, or a placeholder that collides with another.
func Render(spec Spec) (Config, error) {
	if strings.TrimSpace(spec.ListenAddr) == "" {
		return Config{}, fmt.Errorf("%w: listen address is required", ErrInvalidSpec)
	}
	if _, _, err := net.SplitHostPort(spec.ListenAddr); err != nil {
		return Config{}, fmt.Errorf("%w: listen address %q: %v", ErrInvalidSpec, spec.ListenAddr, err)
	}
	for name, address := range map[string]string{"http": spec.HTTPListen, "https": spec.HTTPSListen, "metrics": spec.MetricsListen} {
		if strings.TrimSpace(address) == "" {
			return Config{}, fmt.Errorf("%w: %s listen address is required (upstream defaults collide on a shared host)", ErrInvalidSpec, name)
		}
		if _, _, err := net.SplitHostPort(address); err != nil {
			return Config{}, fmt.Errorf("%w: %s listen address %q: %v", ErrInvalidSpec, name, address, err)
		}
	}
	if strings.TrimSpace(spec.CACertPath) == "" || strings.TrimSpace(spec.CAKeyPath) == "" {
		return Config{}, fmt.Errorf("%w: CA certificate and key paths are required", ErrInvalidSpec)
	}
	deny := spec.UpstreamDenyCIDRs
	if deny == nil {
		deny = DefaultUpstreamDenyCIDRs
	}
	for _, cidr := range deny {
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return Config{}, fmt.Errorf("%w: upstream deny cidr %q: %v", ErrInvalidSpec, cidr, err)
		}
	}
	for _, cidr := range spec.AllowCIDRs {
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return Config{}, fmt.Errorf("%w: allow cidr %q: %v", ErrInvalidSpec, cidr, err)
		}
	}
	domains := cleanList(spec.AllowDomains)
	if len(domains) == 0 && len(spec.AllowCIDRs) == 0 {
		domains = []string{"*"}
	}
	maxBody := spec.MaxRequestBodyBytes
	if maxBody <= 0 {
		maxBody = defaultMaxRequestBodyBytes
	}
	headerTimeout := strings.TrimSpace(spec.UpstreamResponseHeaderTimeout)
	if headerTimeout == "" {
		headerTimeout = defaultUpstreamResponseHeaderTimeout
	}
	level := strings.TrimSpace(spec.LogLevel)
	if level == "" {
		level = "info"
	}

	config := Config{
		DNS: DNSConfig{Enabled: false},
		Proxy: ProxyConfig{
			HTTPListen:                    spec.HTTPListen,
			HTTPSListen:                   spec.HTTPSListen,
			TunnelListen:                  spec.ListenAddr,
			MaxRequestBodyBytes:           maxBody,
			UpstreamResponseHeaderTimeout: headerTimeout,
			UpstreamDenyCIDRs:             append([]string(nil), deny...),
		},
		Metrics: MetricsConfig{Listen: spec.MetricsListen},
		TLS:     TLSConfig{Mode: "mitm", CACert: spec.CACertPath, CAKey: spec.CAKeyPath},
		Transforms: []Transform{{
			Name:   "allowlist",
			Config: AllowlistConfig{Domains: domains, CIDRs: append([]string(nil), spec.AllowCIDRs...)},
		}},
		Log: LogConfig{Level: level},
	}

	entries, err := renderSecrets(spec.Secrets)
	if err != nil {
		return Config{}, err
	}
	if len(entries) > 0 {
		config.Transforms = append(config.Transforms, Transform{Name: "secrets", Config: SecretsConfig{Secrets: entries}})
	}
	return config, nil
}

func renderSecrets(bindings []SecretBinding) ([]SecretEntry, error) {
	entries := make([]SecretEntry, 0, len(bindings))
	placeholders := make(map[string]string, len(bindings))
	for _, binding := range bindings {
		envVar := strings.TrimSpace(binding.EnvVar)
		if envVar == "" {
			return nil, fmt.Errorf("%w: secret binding env var is required", ErrInvalidSpec)
		}
		proxyValue := strings.TrimSpace(binding.ProxyValue)
		if proxyValue == "" {
			proxyValue = envVar
		}
		if other, taken := placeholders[proxyValue]; taken && other != envVar {
			return nil, fmt.Errorf("%w: placeholder %q bound to both %s and %s", ErrInvalidSpec, proxyValue, other, envVar)
		}
		placeholders[proxyValue] = envVar
		hosts := cleanList(binding.Hosts)
		if len(hosts) == 0 {
			return nil, fmt.Errorf("%w: secret %s has no host binding", ErrInvalidSpec, envVar)
		}
		headers := cleanList(binding.MatchHeaders)
		if len(headers) == 0 && !binding.MatchQuery && !binding.MatchPath {
			return nil, fmt.Errorf("%w: secret %s has no match location", ErrInvalidSpec, envVar)
		}
		if headers == nil {
			// An absent list means "scan every header" to iron-proxy; keep the
			// binding explicit by emitting an empty list when only query/path
			// scanning was requested.
			headers = []string{}
		}
		rules := make([]SecretRule, 0, len(hosts))
		for _, host := range hosts {
			if _, _, err := net.ParseCIDR(host); err == nil {
				rules = append(rules, SecretRule{CIDR: host})
				continue
			}
			rules = append(rules, SecretRule{Host: host})
		}
		entries = append(entries, SecretEntry{
			Source: SecretSource{Type: "env", Var: envVar},
			Replace: SecretReplace{
				ProxyValue: proxyValue, MatchHeaders: headers,
				MatchQuery: binding.MatchQuery, MatchPath: binding.MatchPath, Require: binding.Require,
			},
			Rules: rules,
		})
	}
	return entries, nil
}

// Marshal renders config as YAML.
func Marshal(config Config) ([]byte, error) {
	return yaml.Marshal(config)
}

// RenderYAML is Render followed by Marshal.
func RenderYAML(spec Spec) ([]byte, error) {
	config, err := Render(spec)
	if err != nil {
		return nil, err
	}
	return Marshal(config)
}

func cleanList(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, duplicate := seen[value]; duplicate {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	if len(result) == 0 {
		return nil
	}
	sort.Strings(result)
	return result
}
