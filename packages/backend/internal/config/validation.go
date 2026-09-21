package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

// ValidateServerStartup performs fail-fast checks for API startup-critical settings.
func ValidateServerStartup(cfg *Config) error {
	if cfg == nil {
		return fmt.Errorf("config must not be nil")
	}

	var errs []string

	validateCommonStartup(cfg, &errs)

	if strings.TrimSpace(cfg.Auth.SessionSecret) == "" {
		errs = append(errs, "auth.session_secret must not be empty")
	}
	if strings.TrimSpace(cfg.Auth.LFSSigningSecret) == "" {
		errs = append(errs, "auth.lfs_signing_secret must not be empty")
	}
	if strings.TrimSpace(cfg.Webhook.SecretEncryptionKey) == "" {
		errs = append(errs, "webhook.secret_encryption_key must not be empty")
	}
	if strings.TrimSpace(cfg.RepoHost.PushHookCallbackToken) == "" {
		errs = append(errs, "repo_host.push_hook_callback_token must not be empty")
	} else if cfg.RepoHost.PushHookCallbackToken != strings.TrimSpace(cfg.RepoHost.PushHookCallbackToken) {
		errs = append(errs, "repo_host.push_hook_callback_token must not contain surrounding whitespace")
	}
	if cfg.FeatureFlags.Workflows ||
		cfg.FeatureFlags.Sandboxes ||
		cfg.FeatureFlags.Workspaces ||
		cfg.FeatureFlags.Agents ||
		cfg.FeatureFlags.RemoteSandboxEnabled {
		if strings.TrimSpace(cfg.Sandbox.MicrosandboxControlURL) == "" {
			errs = append(errs, "sandbox.microsandbox_control_url is required when sandbox-backed features are enabled")
		}
	}
	if err := normalizeAgentAvailability(cfg); err != nil {
		errs = append(errs, err.Error())
	}

	if len(errs) > 0 {
		return fmt.Errorf("config validation failed: %s", strings.Join(errs, "; "))
	}
	return nil
}

// ValidateRunnerStartup checks the runner configuration object. Runtime HTTP
// authentication is validated by the controller client that consumes the
// shared runner credential; Git clones use a task-scoped token minted by API.
func ValidateRunnerStartup(cfg *Config) error {
	if cfg == nil {
		return fmt.Errorf("config must not be nil")
	}
	return nil
}

// ValidateSSHStartup performs fail-fast checks for SSH server startup-critical settings.
func ValidateSSHStartup(cfg *Config) error {
	if cfg == nil {
		return fmt.Errorf("config must not be nil")
	}

	var errs []string
	validateCommonStartup(cfg, &errs)
	if strings.TrimSpace(cfg.Auth.LFSSigningSecret) == "" {
		errs = append(errs, "auth.lfs_signing_secret must not be empty")
	}
	apiBaseURL := strings.TrimSpace(os.Getenv("SMITHERS_API_BASE_URL"))
	baseURL := ResolvePublicAPIOrigin(apiBaseURL, cfg.Email.BaseURL)
	baseURLSetting := "email.base_url"
	if apiBaseURL != "" {
		baseURLSetting = "SMITHERS_API_BASE_URL"
	}
	if baseURL == "" {
		errs = append(errs, "SMITHERS_API_BASE_URL or email.base_url is required for Git LFS SSH authentication")
	} else if err := validateURL(baseURL, true); err != nil {
		errs = append(errs, fmt.Sprintf("%s is invalid: %v", baseURLSetting, err))
	} else if parsed, err := url.Parse(baseURL); err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		errs = append(errs, fmt.Sprintf("%s is invalid: credentials, query, and fragment are not allowed", baseURLSetting))
	}

	if len(errs) > 0 {
		return fmt.Errorf("config validation failed: %s", strings.Join(errs, "; "))
	}
	return nil
}

func validateCommonStartup(cfg *Config, errs *[]string) {
	if strings.TrimSpace(cfg.Database.URL) == "" {
		*errs = append(*errs, "database.url is required")
	}
	if strings.TrimSpace(cfg.RepoHost.URL) == "" {
		*errs = append(*errs, "repo_host.url is required")
	}
	if strings.TrimSpace(cfg.RepoHost.AuthToken) == "" {
		*errs = append(*errs, "repo_host.auth_token is required")
	}

	if cfg.Database.MaxConns <= 0 {
		*errs = append(*errs, "database.max_conns must be > 0")
	}
	if cfg.Database.MinConns <= 0 {
		*errs = append(*errs, "database.min_conns must be > 0")
	}
	if cfg.Database.MaxConns > 0 && cfg.Database.MinConns > 0 && cfg.Database.MaxConns < cfg.Database.MinConns {
		*errs = append(*errs, "database.max_conns must be >= database.min_conns")
	}

	if cfg.Database.MaxConnLifetime <= 0 {
		*errs = append(*errs, "database.max_conn_lifetime_secs must be > 0")
	}
	if cfg.Database.MaxConnIdleTime <= 0 {
		*errs = append(*errs, "database.max_conn_idle_time_secs must be > 0")
	}
	if cfg.Server.ReadTimeoutSecs <= 0 {
		*errs = append(*errs, "server.read_timeout_secs must be > 0")
	}
	if cfg.Server.WriteTimeoutSecs < 0 {
		*errs = append(*errs, "server.write_timeout_secs must be >= 0")
	}
	if timeout, err := time.ParseDuration(strings.TrimSpace(cfg.Server.ShutdownTimeout)); err != nil {
		*errs = append(*errs, fmt.Sprintf("server.shutdown_timeout is invalid: %v", err))
	} else if timeout <= 0 {
		*errs = append(*errs, "server.shutdown_timeout must be > 0")
	}

	if err := validateURL(cfg.Database.URL, false); err != nil {
		*errs = append(*errs, fmt.Sprintf("database.url is invalid: %v", err))
	}
	if err := validateURL(cfg.RepoHost.URL, true); err != nil {
		*errs = append(*errs, fmt.Sprintf("repo_host.url is invalid: %v", err))
	}
	if strings.TrimSpace(cfg.Sandbox.MicrosandboxControlURL) != "" {
		if err := validateURL(cfg.Sandbox.MicrosandboxControlURL, true); err != nil {
			*errs = append(*errs, fmt.Sprintf("sandbox.microsandbox_control_url is invalid: %v", err))
		}
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Sandbox.Provider)) {
	case "", "microsandbox":
	default:
		*errs = append(*errs, "sandbox.provider must be microsandbox when set")
	}
	switch strings.TrimSpace(cfg.Sandbox.WorkspacePersistence) {
	case "", "ephemeral", "persistent":
	default:
		*errs = append(*errs, "sandbox.workspace_persistence must be one of ephemeral, persistent")
	}
	if cfg.Sandbox.WorkspaceMemoryMB <= 0 || cfg.Sandbox.WorkspaceMemoryMB > 65536 {
		*errs = append(*errs, "sandbox.workspace_memory_mb must be between 1 and 65536")
	}
	if cfg.Sandbox.WorkspaceVCPUCount <= 0 || cfg.Sandbox.WorkspaceVCPUCount > 16 {
		*errs = append(*errs, "sandbox.workspace_vcpu_count must be between 1 and 16")
	}
	if cfg.Sandbox.WorkspaceIdleTimeout < 0 {
		*errs = append(*errs, "sandbox.workspace_idle_timeout must be >= 0")
	}
	if cfg.Sandbox.AgentMaxConcurrent < 0 {
		*errs = append(*errs, "sandbox.agent_max_concurrent must be >= 0")
	}
	if cfg.Sandbox.AgentIdleTimeoutSecs <= 0 {
		*errs = append(*errs, "sandbox.agent_idle_timeout_seconds must be > 0")
	}
}

func validateURL(raw string, requireHTTP bool) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		// url.Parse errors quote the raw input, which for a DSN carries the
		// password. Return only the underlying reason so startup logs never
		// persist credentials.
		var parseErr *url.Error
		if errors.As(err, &parseErr) {
			return fmt.Errorf("cannot parse URL: %v", parseErr.Err)
		}
		return fmt.Errorf("cannot parse URL: %v", err)
	}
	if u.Scheme == "" {
		return fmt.Errorf("missing scheme")
	}
	if requireHTTP && u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("scheme must be http or https")
	}
	if u.Host == "" {
		return fmt.Errorf("missing host")
	}
	return nil
}
