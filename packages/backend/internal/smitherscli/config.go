package smitherscli

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"gopkg.in/yaml.v3"
)

// No deployment is privileged. The CLI requires the same explicit origin the
// application runtime uses, from config or SMITHERS_API_ORIGIN, and an
// explicit observe_url before it sends an admin token to an Observe console.
const defaultAPIURL = ""

// cliGOOS mirrors runtime.GOOS but is a package variable so platform-specific
// base-directory selection can be exercised on any host during tests.
var cliGOOS = runtime.GOOS

// Filesystem/serialization seams so tests can exercise the otherwise
// defensive error branches (yaml.Marshal never fails for these structs and
// os.MkdirAll succeeds on an existing directory).
var (
	configMarshal  = yaml.Marshal
	configMkdirAll = os.MkdirAll
)

type GitProtocol string

const (
	GitProtocolSSH   GitProtocol = "ssh"
	GitProtocolHTTPS GitProtocol = "https"
)

type Config struct {
	ObserveURL  string      `json:"observe_url" yaml:"observe_url"`
	APIURL      string      `json:"api_origin" yaml:"api_origin"`
	GitProtocol GitProtocol `json:"git_protocol" yaml:"git_protocol"`
}

type RawConfig struct {
	Config `yaml:",inline"`
	Token  string `json:"token,omitempty" yaml:"token,omitempty"`
}

func normalizeAPIURL(apiURL string) string {
	trimmed := strings.TrimSpace(apiURL)
	trimmed = strings.TrimRight(trimmed, "/")
	if strings.HasSuffix(strings.ToLower(trimmed), "/api") {
		trimmed = trimmed[:len(trimmed)-4]
	}
	return trimmed
}

func configBaseDir() string {
	if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		return xdg
	}
	home, _ := os.UserHomeDir()
	if cliGOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support")
	}
	return filepath.Join(home, ".config")
}

func cacheBaseDir() string {
	if xdg := strings.TrimSpace(os.Getenv("XDG_CACHE_HOME")); xdg != "" {
		return xdg
	}
	home, _ := os.UserHomeDir()
	if cliGOOS == "darwin" {
		return filepath.Join(home, "Library", "Caches")
	}
	return filepath.Join(home, ".cache")
}

func stateBaseDir() string {
	if xdg := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); xdg != "" {
		return xdg
	}
	home, _ := os.UserHomeDir()
	if cliGOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support")
	}
	return filepath.Join(home, ".local", "state")
}

func ConfigPath() string {
	return filepath.Join(configBaseDir(), "smithers", "config.toon")
}

func CacheDir() string {
	return filepath.Join(cacheBaseDir(), "smithers")
}

func StateDir() string {
	return filepath.Join(stateBaseDir(), "smithers")
}

func defaultRawConfig() RawConfig {
	return RawConfig{Config: Config{APIURL: defaultAPIURL, GitProtocol: GitProtocolSSH}}
}

// LoadRawConfig reads the config file. A missing file yields the defaults. A
// file that exists but does not parse is an error: treating it as defaults
// would hide the user's settings and let the next save erase them.
func LoadRawConfig() (RawConfig, error) {
	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultRawConfig(), nil
		}
		return defaultRawConfig(), fmt.Errorf("config file %s could not be read: %w", path, err)
	}

	var parsed map[string]any
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return defaultRawConfig(), fmt.Errorf("config file %s is invalid: %w", path, err)
	}

	raw := defaultRawConfig()
	if value, ok := parsed["api_origin"].(string); ok {
		raw.APIURL = normalizeAPIURL(value)
	} else if value, ok := parsed["api_url"].(string); ok {
		raw.APIURL = normalizeAPIURL(value)
	}
	if value, ok := parsed["observe_url"].(string); ok && strings.TrimSpace(value) != "" {
		raw.ObserveURL = strings.TrimRight(strings.TrimSpace(value), "/")
	}
	if value, ok := parsed["token"].(string); ok {
		raw.Token = value
	}
	if value, ok := parsed["git_protocol"].(string); ok && value == string(GitProtocolHTTPS) {
		raw.GitProtocol = GitProtocolHTTPS
	}
	return raw, nil
}

// LoadConfig returns the config file merged with environment overrides.
func LoadConfig() (Config, error) {
	raw, err := LoadRawConfig()
	cfg := raw.Config
	if apiOrigin := strings.TrimSpace(os.Getenv("SMITHERS_API_ORIGIN")); apiOrigin != "" {
		cfg.APIURL = normalizeAPIURL(apiOrigin)
	}
	return cfg, err
}

// SaveConfig merges update into the config file. It refuses to write over a
// file it cannot parse.
func SaveConfig(update map[string]string) error {
	existing, err := LoadRawConfig()
	if err != nil {
		return err
	}
	merged := RawConfig{
		Config: Config{
			APIURL:      existing.APIURL,
			ObserveURL:  existing.ObserveURL,
			GitProtocol: existing.GitProtocol,
		},
	}
	if value, ok := update["api_origin"]; ok {
		merged.APIURL = normalizeAPIURL(value)
	} else if value, ok := update["api_url"]; ok {
		merged.APIURL = normalizeAPIURL(value)
	}
	if value, ok := update["observe_url"]; ok {
		if err := validateObserveURL(value); err != nil {
			return err
		}
		merged.ObserveURL = strings.TrimRight(strings.TrimSpace(value), "/")
	}
	if value, ok := update["git_protocol"]; ok {
		merged.GitProtocol = GitProtocol(value)
	}

	data, err := configMarshal(merged)
	if err != nil {
		return err
	}
	path := ConfigPath()
	if err := configMkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func ClearLegacyToken() (bool, error) {
	existing, err := LoadRawConfig()
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(existing.Token) == "" {
		return false, nil
	}
	existing.Token = ""
	data, err := configMarshal(existing)
	if err != nil {
		return false, err
	}
	path := ConfigPath()
	if err := configMkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	return true, os.WriteFile(path, data, 0o644)
}

func hostFromURL(apiURL string) string {
	trimmed := strings.TrimSpace(strings.ToLower(apiURL))
	if strings.Contains(trimmed, "://") {
		withoutScheme := trimmed[strings.Index(trimmed, "://")+3:]
		if slash := strings.IndexByte(withoutScheme, '/'); slash != -1 {
			withoutScheme = withoutScheme[:slash]
		}
		if at := strings.LastIndexByte(withoutScheme, '@'); at != -1 {
			withoutScheme = withoutScheme[at+1:]
		}
		if colon := strings.LastIndexByte(withoutScheme, ':'); colon != -1 && !strings.Contains(withoutScheme[colon+1:], "]") {
			withoutScheme = withoutScheme[:colon]
		}
		if strings.HasPrefix(withoutScheme, "api.") {
			return strings.TrimPrefix(withoutScheme, "api.")
		}
		return withoutScheme
	}
	if strings.HasPrefix(trimmed, "api.") {
		return strings.TrimPrefix(trimmed, "api.")
	}
	return trimmed
}
