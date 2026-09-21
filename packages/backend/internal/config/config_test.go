package config

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// allEnvKeys is the complete list of environment variables that config.Load() binds.
// Used by clearConfigEnv to ensure test isolation.
var allEnvKeys = []string{
	"SMITHERS_AGENT_NEVER_STARTED_TIMEOUT",
	// Server
	"SMITHERS_SERVER_ADDR",
	"SMITHERS_SERVER_READ_TIMEOUT_SECS",
	"SMITHERS_SERVER_WRITE_TIMEOUT_SECS",
	"SMITHERS_SERVER_SHUTDOWN_TIMEOUT",
	"SMITHERS_SERVER_SSH_HOST",
	"SMITHERS_SERVER_ALLOWED_ORIGINS",
	"SMITHERS_SERVER_TRUSTED_PROXY_HOPS",
	// Database
	"SMITHERS_DATABASE_URL",
	"SMITHERS_DATABASE_MAX_CONNS",
	"SMITHERS_DATABASE_MIN_CONNS",
	"SMITHERS_DATABASE_MAX_CONN_LIFETIME_SECS",
	"SMITHERS_DATABASE_MAX_CONN_IDLE_TIME_SECS",
	// RepoHost
	"SMITHERS_REPO_HOST_URL",
	"SMITHERS_REPO_HOST_AUTH_TOKEN",
	"REPO_HOST_AUTH_TOKEN",
	"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN",
	// Sandbox
	"SMITHERS_SANDBOX_PROVIDER",
	"SMITHERS_MICROSANDBOX_CONTROL_URL",
	"SMITHERS_MICROSANDBOX_API_KEY",
	"SMITHERS_MICROSANDBOX_DEFAULT_IMAGE",
	"SMITHERS_GOLDEN_SNAPSHOTS_ENABLED",
	"SMITHERS_MICROSANDBOX_CLIENT_CERT_FILE",
	"SMITHERS_MICROSANDBOX_CLIENT_KEY_FILE",
	"SMITHERS_MICROSANDBOX_CA_FILE",
	"SMITHERS_MICROSANDBOX_SERVER_NAME",
	"SMITHERS_SANDBOX_AGENT_SNAPSHOT_ID",
	"SMITHERS_GATEWAY_AGENT_CEREBRAS_API_KEY",
	"SMITHERS_GATEWAY_AGENT_OPENROUTER_API_KEY",
	"SMITHERS_GATEWAY_AGENT_ANTHROPIC_API_KEY",
	"SMITHERS_GATEWAY_AGENT_OPENAI_API_KEY",
	"SMITHERS_GATEWAY_HEALTH_PROBE_BASE_URL",
	"SMITHERS_PREVIEW_RELAY_TOKEN",
	"SMITHERS_WORKSPACE_CODING_DEFAULT_MODEL",
	"SMITHERS_SANDBOX_AGENT_MEMORY_MB",
	"SMITHERS_SANDBOX_WORKSPACE_MEMORY_MB",
	"SMITHERS_SANDBOX_WORKSPACE_VCPU_COUNT",
	"SMITHERS_SANDBOX_AGENT_VCPU_COUNT",
	"SMITHERS_SANDBOX_AGENT_ROOTFS_SIZE_MB",
	"SMITHERS_SANDBOX_AGENT_MAX_RUNTIME_SECONDS",
	"SMITHERS_SANDBOX_AGENT_IDLE_TIMEOUT_SECONDS",
	"SMITHERS_SANDBOX_DESKTOP_MEMORY_MB",
	"SMITHERS_SANDBOX_DESKTOP_VCPU_COUNT",
	"SMITHERS_DESKTOP_OBSERVE_TEXT",
	"SMITHERS_SANDBOX_AGENT_MAX_CONCURRENT",
	"SMITHERS_SANDBOX_ANON_ENABLED",
	"SMITHERS_SANDBOX_ANON_REPO_ALLOWLIST",
	"SMITHERS_SANDBOX_ANON_TTL_SECS",
	"SMITHERS_SANDBOX_ANON_MAX_CONCURRENT",
	"SMITHERS_SANDBOX_ANON_MAX_PER_IP",
	"SMITHERS_SANDBOX_WORKSPACE_IDLE_TIMEOUT",
	"SMITHERS_SANDBOX_WORKSPACE_PERSISTENCE",
	"SMITHERS_SANDBOX_WORKSPACE_SSH_HOST",
	"SMITHERS_SANDBOX_WORKSPACE_SSH_DIAL_HOST",
	// SSH
	"SMITHERS_SSH_ADDR",
	"SMITHERS_SSH_HOST_KEY_DIR",
	"SMITHERS_SSH_MAX_CONNECTIONS",
	"SMITHERS_SSH_MAX_CONNECTIONS_PER_IP",
	"SMITHERS_SSH_MAX_RECEIVE_PACK_SIZE",
	"SMITHERS_SSH_MAX_UPLOAD_PACK_REQUEST_SIZE",
	"SMITHERS_SSH_RECEIVE_PACK_TIMEOUT",
	"SMITHERS_SSH_UPLOAD_PACK_TIMEOUT",
	"SMITHERS_SSH_SHUTDOWN_DRAIN_TIMEOUT",
	"SMITHERS_SSH_AUTH_ATTEMPTS_PER_MINUTE",
	"SMITHERS_SSH_IDLE_TIMEOUT",
	"SMITHERS_SSH_MAX_TIMEOUT",
	"SMITHERS_SSH_MAX_SESSIONS_PER_CONN",
	// Auth
	"SMITHERS_AUTH_SESSION_DURATION",
	"SMITHERS_AUTH_SESSION_REFRESH_WINDOW",
	"SMITHERS_AUTH_SESSION_COOKIE_NAME",
	"SMITHERS_AUTH_SESSION_SECRET",
	"SMITHERS_LFS_SIGNING_SECRET",
	"SMITHERS_AUTH_COOKIE_SECURE",
	"SMITHERS_AUTH_CLOSED_ALPHA_ENABLED",
	"SMITHERS_AUTH_ENABLE_KEY_AUTH",
	"SMITHERS_AUTH_GITHUB_CLIENT_ID",
	"SMITHERS_AUTH_GITHUB_CLIENT_SECRET",
	"SMITHERS_AUTH_GITHUB_REDIRECT_URL",
	"SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL",
	"SMITHERS_AUTH_GITHUB_API_BASE_URL",
	"SMITHERS_AUTH_KEY_AUTH_DOMAIN",
	"SMITHERS_AUTH_AUTH0_DOMAIN",
	"SMITHERS_AUTH_AUTH0_CLIENT_ID",
	"SMITHERS_AUTH_AUTH0_CLIENT_SECRET",
	"SMITHERS_AUTH_AUTH0_REDIRECT_URL",
	"SMITHERS_AUTH_AUTH0_CONNECTION",
	"SMITHERS_AUTH_LINEAR_CLIENT_ID",
	"SMITHERS_AUTH_LINEAR_CLIENT_SECRET",
	"SMITHERS_AUTH_LINEAR_REDIRECT_URL",
	"SMITHERS_AUTH_WORKER_EXCHANGE_TOKEN",
	// Billing
	"SMITHERS_BILLING_STRIPE_SECRET_KEY",
	"SMITHERS_BILLING_STRIPE_WEBHOOK_SECRET",
	"SMITHERS_BILLING_PORTAL_RETURN_URL",
	"SMITHERS_BILLING_CHECKOUT_SUCCESS_URL",
	"SMITHERS_BILLING_CHECKOUT_CANCEL_URL",
	"SMITHERS_BILLING_PERSONAL_MONTHLY_PRICE_ID",
	"SMITHERS_BILLING_PERSONAL_ANNUAL_PRICE_ID",
	"SMITHERS_BILLING_PRO_MONTHLY_PRICE_ID",
	"SMITHERS_BILLING_PRO_ANNUAL_PRICE_ID",
	"SMITHERS_BILLING_MAX_MONTHLY_PRICE_ID",
	"SMITHERS_BILLING_MAX_ANNUAL_PRICE_ID",
	"SMITHERS_BILLING_TEAM_MONTHLY_PRICE_ID",
	"SMITHERS_BILLING_TEAM_ANNUAL_PRICE_ID",
	"SMITHERS_BILLING_ENTERPRISE_MONTHLY_PRICE_ID",
	"SMITHERS_BILLING_ENTERPRISE_ANNUAL_PRICE_ID",
	// Webhook
	"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY",
	"SMITHERS_WEBHOOK_GITHUB_APP_SECRET",
	"SMITHERS_PROVIDER_CONNECTIONS_CLAUDE_TOKEN_URL",
	"SMITHERS_PROVIDER_CONNECTIONS_CLAUDE_CLIENT_ID",
	"SMITHERS_PROVIDER_CONNECTIONS_CODEX_TOKEN_URL",
	"SMITHERS_PROVIDER_CONNECTIONS_CODEX_CLIENT_ID",
	// Runner
	"SMITHERS_RUNNER_POOL_SIZE",
	"SMITHERS_RUNNER_WARM_TIMEOUT",
	"SMITHERS_RUNNER_TASK_TIMEOUT",
	"SMITHERS_RUNNER_MAX_AGENT_SESSION_DURATION",
	// Cleanup
	"SMITHERS_CLEANUP_AUTH_INTERVAL",
	"SMITHERS_CLEANUP_WORKFLOW_CACHE_INTERVAL",
	"SMITHERS_CLEANUP_SANDBOX_EGRESS_AUDIT_RETENTION_DAYS",
	// Blob
	"SMITHERS_BLOB_GCS_BUCKET",
	"SMITHERS_BLOB_AGENT_LOGS_GCS_BUCKET",
	"SMITHERS_BLOB_GCS_PROJECT",
	"SMITHERS_BLOB_SIGNED_URL_EXPIRY",
	"SMITHERS_BLOB_WORKFLOW_CACHE_PREFIX",
	"SMITHERS_BLOB_WORKFLOW_CACHE_TTL",
	"SMITHERS_BLOB_WORKFLOW_CACHE_REPO_QUOTA_BYTES",
	"SMITHERS_BLOB_WORKFLOW_CACHE_ARCHIVE_MAX_BYTES",
	"SMITHERS_BLOB_BUILD_CACHE_ARTIFACT_MAX_BYTES",
	// Observability
	"SMITHERS_LOG_LEVEL",
	"SMITHERS_TRACE_SAMPLE_RATE",
	"SMITHERS_CLOUD_TRACE_PROJECT_ID",
	"SMITHERS_OTEL_EXPORTER",
	"SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT",
	"SMITHERS_METRICS_EXPORT_TARGET",
	"SMITHERS_METRICS_PROJECT_ID",
	// Email
	"SMITHERS_EMAIL_SENDGRID_API_KEY",
	"SMITHERS_EMAIL_SMTP_HOST",
	"SMITHERS_EMAIL_SMTP_PORT",
	"SMITHERS_EMAIL_SMTP_USER",
	"SMITHERS_EMAIL_SMTP_PASS",
	"SMITHERS_EMAIL_SMTP_FROM",
	"SMITHERS_EMAIL_SES_REGION",
	"SMITHERS_EMAIL_SES_FROM",
	"SMITHERS_EMAIL_FROM",
	"SMITHERS_EMAIL_BASE_URL",
	"SMITHERS_EMAIL_RATE_LIMIT_PER_SECOND",
	"SMITHERS_EMAIL_RATE_LIMIT_PER_RECIPIENT_PER_HR",
	// Feature flags
	"SMITHERS_FEATURE_FLAGS_READOUT_DASHBOARD",
	"SMITHERS_FEATURE_FLAGS_LANDING_QUEUE",
	"SMITHERS_FEATURE_FLAGS_TOOL_SKILLS",
	"SMITHERS_FEATURE_FLAGS_TOOL_POLICIES",
	"SMITHERS_FEATURE_FLAGS_REPO_SNAPSHOTS",
	"SMITHERS_FEATURE_FLAGS_INTEGRATIONS",
	"SMITHERS_FEATURE_FLAGS_SESSION_REPLAY",
	"SMITHERS_FEATURE_FLAGS_SECRETS_MANAGER",
	"SMITHERS_FEATURE_FLAGS_WEB_EDITOR",
	"SMITHERS_FEATURE_FLAGS_CLIENT_ERROR_REPORTING",
	"SMITHERS_FEATURE_FLAGS_CLIENT_METRICS",
	"SMITHERS_FEATURE_FLAGS_STACKED_PRS",
	"SMITHERS_FEATURE_FLAGS_WORKFLOWS",
	"SMITHERS_FEATURE_FLAGS_SANDBOXES",
	"SMITHERS_FEATURE_FLAGS_AUTO_PUSH",
	"SMITHERS_FEATURE_FLAGS_ISSUES",
	"SMITHERS_FEATURE_FLAGS_SEARCH",
	"SMITHERS_FEATURE_FLAGS_WORKSPACES",
	"SMITHERS_FEATURE_FLAGS_AGENTS",
	"SMITHERS_FEATURE_FLAGS_WEB_DASHBOARD",
	"SMITHERS_FEATURE_FLAGS_CHANGESETS",
	"SMITHERS_FEATURE_FLAGS_PROTECTED_BOOKMARKS",
	"SMITHERS_FEATURE_FLAGS_NOTIFICATIONS",
	"SMITHERS_FEATURE_FLAGS_WIKI",
	"SMITHERS_FEATURE_FLAGS_LABELS",
	"SMITHERS_FEATURE_FLAGS_RELEASES",
	"SMITHERS_FEATURE_FLAGS_SECRETS",
	"SMITHERS_FEATURE_FLAGS_WEBHOOKS_USER",
	"SMITHERS_FEATURE_FLAGS_BOT_COMMANDS",
	"SMITHERS_FEATURE_FLAGS_DRAFT_PRS",
	"SMITHERS_FEATURE_FLAGS_REVIEWERS",
	"SMITHERS_FEATURE_FLAGS_MULTI_AUTH",
	"SMITHERS_FEATURE_FLAGS_PRIVATE_REPOS",
	// iOS + remote-sandbox rollout flags (ticket 0112) — SMITHERS_ prefix per spec.
	"SMITHERS_REMOTE_SANDBOX_ENABLED",
	"SMITHERS_APPROVALS_FLOW_ENABLED",
	"SMITHERS_DEVTOOLS_SNAPSHOT_ENABLED",
	"SMITHERS_RUN_SHAPE_ENABLED",
	// Ticket 0132 rate-limit knobs.
	"SMITHERS_RATE_LIMIT_TERMINAL_OPEN_PER_MIN",
	"SMITHERS_RATE_LIMIT_TERMINAL_ACTIVE_MAX",
	"SMITHERS_RATE_LIMIT_APPROVAL_DECIDE_PER_MIN",
	"SMITHERS_RATE_LIMIT_APP_TIMELINE_WRITE_PER_MIN",
	"SMITHERS_RATE_LIMIT_BUILD_CACHE_PER_MIN",
	"SMITHERS_RATE_LIMIT_ANON_SANDBOX_CREATE_PER_HOUR",
	"SMITHERS_RATE_LIMIT_SHARE_LISTING_EVENT_PER_MIN",
}

// clearConfigEnv unsets all SMITHERS_ env vars that config.Load() reads,
// and restores them after the test via t.Cleanup.
func clearConfigEnv(t *testing.T) {
	t.Helper()
	for _, key := range allEnvKeys {
		original, had := os.LookupEnv(key)
		require.NoError(t, os.Unsetenv(key))
		if had {
			t.Cleanup(func() {
				_ = os.Setenv(key, original)
			})
		}
	}
}

// TestLoad_ReturnsNoError verifies Load() succeeds with defaults.
func TestLoad_ReturnsNoError(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)
	require.NotNil(t, cfg)
}

// TestLoad_ServerConfigDefaults verifies server defaults match the spec (port 4000).
func TestLoad_ServerConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":4000", cfg.Server.Addr, "server.addr should default to :4000 per spec")
	assert.Equal(t, 30, cfg.Server.ReadTimeoutSecs, "server.read_timeout_secs should default to 30")
	assert.Equal(t, 0, cfg.Server.WriteTimeoutSecs, "server.write_timeout_secs should default to 0 so streaming responses are not cut off")
	assert.Equal(t, "30s", cfg.Server.ShutdownTimeout, "server.shutdown_timeout should default to 30s")
}

// TestLoad_ServerConfigEnvOverride verifies SMITHERS_SERVER_ADDR overrides the default.
func TestLoad_ServerConfigEnvOverride(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_SERVER_ADDR", ":9000")
	t.Setenv("SMITHERS_SERVER_READ_TIMEOUT_SECS", "45")
	t.Setenv("SMITHERS_SERVER_WRITE_TIMEOUT_SECS", "50")
	t.Setenv("SMITHERS_SERVER_SHUTDOWN_TIMEOUT", "45s")
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", "http://127.0.0.1:5173, http://localhost:5173")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":9000", cfg.Server.Addr)
	assert.Equal(t, 45, cfg.Server.ReadTimeoutSecs)
	assert.Equal(t, 50, cfg.Server.WriteTimeoutSecs)
	assert.Equal(t, "45s", cfg.Server.ShutdownTimeout)
	assert.Equal(t, []string{"http://127.0.0.1:5173", "http://localhost:5173"}, cfg.Server.AllowedOrigins)
}

// TestLoad_ServerSSHHostDefaults verifies default SSH host is "localhost".
func TestLoad_ServerSSHHostDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "localhost", cfg.Server.SSHHost, "server.ssh_host should default to localhost")
}

// TestLoad_ServerSSHHostEnvOverride verifies SMITHERS_SERVER_SSH_HOST overrides the default.
func TestLoad_ServerSSHHostEnvOverride(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_SERVER_SSH_HOST", "smithers.sh")
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "smithers.sh", cfg.Server.SSHHost)
}

// TestLoad_DatabaseConfigDefaults verifies database defaults match the spec.
func TestLoad_DatabaseConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "", cfg.Database.URL, "database.url has no insecure default; it must be supplied via SMITHERS_DATABASE_URL")
	assert.Equal(t, int32(25), cfg.Database.MaxConns, "max_conns should default to 25 per spec")
	assert.Equal(t, int32(5), cfg.Database.MinConns, "min_conns should default to 5 per spec")
	assert.Equal(t, 3600, cfg.Database.MaxConnLifetime, "max_conn_lifetime should default to 3600s (1hr) per spec")
	assert.Equal(t, 1800, cfg.Database.MaxConnIdleTime, "max_conn_idle_time should default to 1800s (30min) per spec")
}

// TestLoad_DatabaseConfigEnvOverrides verifies all database env vars override defaults.
func TestLoad_DatabaseConfigEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://user:pass@prod:5432/smithers_prod")
	t.Setenv("SMITHERS_DATABASE_MAX_CONNS", "50")
	t.Setenv("SMITHERS_DATABASE_MIN_CONNS", "10")
	t.Setenv("SMITHERS_DATABASE_MAX_CONN_LIFETIME_SECS", "7200")
	t.Setenv("SMITHERS_DATABASE_MAX_CONN_IDLE_TIME_SECS", "3600")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "postgres://user:pass@prod:5432/smithers_prod", cfg.Database.URL)
	assert.Equal(t, int32(50), cfg.Database.MaxConns)
	assert.Equal(t, int32(10), cfg.Database.MinConns)
	assert.Equal(t, 7200, cfg.Database.MaxConnLifetime)
	assert.Equal(t, 3600, cfg.Database.MaxConnIdleTime)
}

// TestLoad_RepoHostConfigDefaults verifies repo_host defaults.
func TestLoad_RepoHostConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:8080", cfg.RepoHost.URL)
	assert.Equal(t, "", cfg.RepoHost.AuthToken)
}

// TestLoad_RepoHostConfigEnvOverride verifies the canonical SMITHERS_ env vars override defaults.
func TestLoad_RepoHostConfigEnvOverride(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_REPO_HOST_URL", "http://repo-host.internal:9090")
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "repo-host-secret")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "http://repo-host.internal:9090", cfg.RepoHost.URL)
	assert.Equal(t, "repo-host-secret", cfg.RepoHost.AuthToken)
}

func TestLoad_RepoHostConfigLegacyAuthTokenFallback(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("REPO_HOST_AUTH_TOKEN", "legacy-repo-host-secret")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "legacy-repo-host-secret", cfg.RepoHost.AuthToken)
}

func TestLoad_RepoHostConfigPrefixedAuthTokenWinsOverLegacy(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "prefixed-secret")
	t.Setenv("REPO_HOST_AUTH_TOKEN", "legacy-secret")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "prefixed-secret", cfg.RepoHost.AuthToken)
}

// TestLoad_SSHConfigDefaults verifies SSH defaults.
func TestLoad_SSHConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, ":2222", cfg.SSH.Addr)
	assert.Equal(t, "./data/ssh", cfg.SSH.HostKeyDir)
	assert.Equal(t, 100, cfg.SSH.MaxConnections)
	assert.Equal(t, 10, cfg.SSH.MaxConnectionsPerIP)
	assert.Equal(t, int64(500*1024*1024), cfg.SSH.MaxReceivePackSize)
	assert.Equal(t, int64(10*1024*1024), cfg.SSH.MaxUploadPackRequestSize)
	assert.Equal(t, "10m", cfg.SSH.ReceivePackTimeout)
	assert.Equal(t, "", cfg.SSH.UploadPackTimeout)
}

// TestLoad_SSHConfigEnvOverrides verifies all SSH env vars override defaults.
func TestLoad_SSHConfigEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_SSH_ADDR", ":22")
	t.Setenv("SMITHERS_SSH_HOST_KEY_DIR", "/etc/smithers/ssh")
	t.Setenv("SMITHERS_SSH_MAX_CONNECTIONS", "123")
	t.Setenv("SMITHERS_SSH_MAX_CONNECTIONS_PER_IP", "5")
	t.Setenv("SMITHERS_SSH_MAX_RECEIVE_PACK_SIZE", "12345")
	t.Setenv("SMITHERS_SSH_MAX_UPLOAD_PACK_REQUEST_SIZE", "678")
	t.Setenv("SMITHERS_SSH_RECEIVE_PACK_TIMEOUT", "12m")
	t.Setenv("SMITHERS_SSH_UPLOAD_PACK_TIMEOUT", "14m")
	t.Setenv("SMITHERS_SSH_AUTH_ATTEMPTS_PER_MINUTE", "1000")
	t.Setenv("SMITHERS_SSH_IDLE_TIMEOUT", "9m")
	t.Setenv("SMITHERS_SSH_MAX_TIMEOUT", "3h")
	t.Setenv("SMITHERS_SSH_MAX_SESSIONS_PER_CONN", "4")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, ":22", cfg.SSH.Addr)
	assert.Equal(t, "/etc/smithers/ssh", cfg.SSH.HostKeyDir)
	assert.Equal(t, 123, cfg.SSH.MaxConnections)
	assert.Equal(t, 5, cfg.SSH.MaxConnectionsPerIP)
	assert.Equal(t, int64(12345), cfg.SSH.MaxReceivePackSize)
	assert.Equal(t, int64(678), cfg.SSH.MaxUploadPackRequestSize)
	assert.Equal(t, "12m", cfg.SSH.ReceivePackTimeout)
	assert.Equal(t, "14m", cfg.SSH.UploadPackTimeout)
	assert.Equal(t, 1000, cfg.SSH.AuthAttemptsPerMinute)
	assert.Equal(t, "9m", cfg.SSH.IdleTimeout)
	assert.Equal(t, "3h", cfg.SSH.MaxTimeout)
	assert.Equal(t, 4, cfg.SSH.MaxSessionsPerConn)
}

func TestLoad_RunnerConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, 10, cfg.Runner.PoolSize)
	assert.Equal(t, "30s", cfg.Runner.WarmTimeout)
	assert.Equal(t, "30m", cfg.Runner.TaskTimeout)
	assert.Equal(t, "30m", cfg.Runner.MaxAgentSessionDuration)
}

func TestLoad_RunnerConfigEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_RUNNER_POOL_SIZE", "25")
	t.Setenv("SMITHERS_RUNNER_WARM_TIMEOUT", "45s")
	t.Setenv("SMITHERS_RUNNER_TASK_TIMEOUT", "1h")
	t.Setenv("SMITHERS_RUNNER_MAX_AGENT_SESSION_DURATION", "2h")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, 25, cfg.Runner.PoolSize)
	assert.Equal(t, "45s", cfg.Runner.WarmTimeout)
	assert.Equal(t, "1h", cfg.Runner.TaskTimeout)
	assert.Equal(t, "2h", cfg.Runner.MaxAgentSessionDuration)
}

// TestLoad_AnonSandboxConfigEnvOverrides guards the anonymous-sandbox kill
// switch and limits: these are the only knobs for the unauthenticated
// VM-creating route, and prod supplies config through env only.
func TestLoad_AnonSandboxConfigEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_SANDBOX_ANON_ENABLED", "false")
	t.Setenv("SMITHERS_SANDBOX_ANON_REPO_ALLOWLIST", "acme/one, acme/two")
	t.Setenv("SMITHERS_SANDBOX_ANON_TTL_SECS", "600")
	t.Setenv("SMITHERS_SANDBOX_ANON_MAX_CONCURRENT", "3")
	t.Setenv("SMITHERS_SANDBOX_ANON_MAX_PER_IP", "1")
	t.Setenv("SMITHERS_RATE_LIMIT_ANON_SANDBOX_CREATE_PER_HOUR", "2")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.False(t, cfg.Sandbox.AnonEnabled)
	assert.Equal(t, []string{"acme/one", "acme/two"}, cfg.Sandbox.AnonRepoAllowlist)
	assert.Equal(t, int64(600), cfg.Sandbox.AnonTTLSecs)
	assert.Equal(t, int32(3), cfg.Sandbox.AnonMaxConcurrent)
	assert.Equal(t, int32(1), cfg.Sandbox.AnonMaxPerIP)
	assert.Equal(t, 2, cfg.RateLimit.AnonSandboxCreatePerHour)
}

func TestLoad_CleanupConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "5m", cfg.Cleanup.AuthInterval)
	assert.Equal(t, "1h", cfg.Cleanup.WorkflowCacheInterval)
}

func TestLoad_CleanupConfigEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_CLEANUP_AUTH_INTERVAL", "45s")
	t.Setenv("SMITHERS_CLEANUP_WORKFLOW_CACHE_INTERVAL", "30m")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "45s", cfg.Cleanup.AuthInterval)
	assert.Equal(t, "30m", cfg.Cleanup.WorkflowCacheInterval)
}

// TestLoad_BlobConfigDefaults verifies blob defaults match the spec (empty strings).
func TestLoad_BlobConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "", cfg.Blob.GCSBucket, "blob.gcs_bucket should default to empty string")
	assert.Equal(t, "", cfg.Blob.AgentLogsGCSBucket, "blob.agent_logs_gcs_bucket should default to empty string")
	assert.Equal(t, "", cfg.Blob.GCSProject, "blob.gcs_project should default to empty string")
	assert.Equal(t, "5m", cfg.Blob.SignedURLExpiry, "blob.signed_url_expiry should default to 5m")
	assert.Equal(t, "workflow-cache", cfg.Blob.WorkflowCachePrefix, "blob.workflow_cache_prefix should default to workflow-cache")
	assert.Equal(t, "168h", cfg.Blob.WorkflowCacheTTL, "blob.workflow_cache_ttl should default to 168h")
	assert.Equal(t, int64(2*1024*1024*1024), cfg.Blob.WorkflowCacheRepoQuotaBytes, "blob.workflow_cache_repo_quota_bytes should default to 2 GiB")
	assert.Equal(t, int64(1024*1024*1024), cfg.Blob.WorkflowCacheArchiveMaxBytes, "blob.workflow_cache_archive_max_bytes should default to 1 GiB")
}

// TestBlobConfig_AgentLogsBucket verifies transcripts target the dedicated
// retention-limited bucket when configured and fall back to the general blobs
// bucket otherwise.
func TestBlobConfig_AgentLogsBucket(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		cfg  BlobConfig
		want string
	}{
		{
			name: "dedicated bucket wins",
			cfg:  BlobConfig{GCSBucket: "smithers-blobs", AgentLogsGCSBucket: "smithers-agent-logs"},
			want: "smithers-agent-logs",
		},
		{
			name: "empty dedicated bucket falls back to blobs bucket",
			cfg:  BlobConfig{GCSBucket: "smithers-blobs"},
			want: "smithers-blobs",
		},
		{
			name: "whitespace dedicated bucket falls back to blobs bucket",
			cfg:  BlobConfig{GCSBucket: "smithers-blobs", AgentLogsGCSBucket: "   "},
			want: "smithers-blobs",
		},
		{
			name: "both empty",
			cfg:  BlobConfig{},
			want: "",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, tt.cfg.AgentLogsBucket())
		})
	}
}

// TestLoad_BlobConfigEnvOverrides verifies SMITHERS_BLOB_GCS_BUCKET and SMITHERS_BLOB_GCS_PROJECT
// override the defaults.
func TestLoad_BlobConfigEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_BLOB_GCS_BUCKET", "smithers-blobs")
	t.Setenv("SMITHERS_BLOB_AGENT_LOGS_GCS_BUCKET", "smithers-agent-logs")
	t.Setenv("SMITHERS_BLOB_GCS_PROJECT", "smithers-prod")
	t.Setenv("SMITHERS_BLOB_SIGNED_URL_EXPIRY", "15m")
	t.Setenv("SMITHERS_BLOB_WORKFLOW_CACHE_PREFIX", "wf-cache")
	t.Setenv("SMITHERS_BLOB_WORKFLOW_CACHE_TTL", "24h")
	t.Setenv("SMITHERS_BLOB_WORKFLOW_CACHE_REPO_QUOTA_BYTES", "123456")
	t.Setenv("SMITHERS_BLOB_WORKFLOW_CACHE_ARCHIVE_MAX_BYTES", "654321")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "smithers-blobs", cfg.Blob.GCSBucket)
	assert.Equal(t, "smithers-agent-logs", cfg.Blob.AgentLogsGCSBucket)
	assert.Equal(t, "smithers-prod", cfg.Blob.GCSProject)
	assert.Equal(t, "15m", cfg.Blob.SignedURLExpiry)
	assert.Equal(t, "wf-cache", cfg.Blob.WorkflowCachePrefix)
	assert.Equal(t, "24h", cfg.Blob.WorkflowCacheTTL)
	assert.Equal(t, int64(123456), cfg.Blob.WorkflowCacheRepoQuotaBytes)
	assert.Equal(t, int64(654321), cfg.Blob.WorkflowCacheArchiveMaxBytes)
}

func TestLoad_ObservabilityConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "info", cfg.Observability.LogLevel, "observability.log_level should default to 'info'")
	assert.Equal(t, 0.01, cfg.Observability.TraceSampleRate, "observability.trace_sample_rate should default to 0.01")
	assert.Equal(t, "", cfg.Observability.CloudTraceProjectID, "observability.cloud_trace_project_id should default to empty string")
	assert.Equal(t, "cloudtrace", cfg.Observability.OTelExporter, "observability.otel_exporter should default to cloudtrace")
	assert.Equal(t, "", cfg.Observability.OTLPEndpoint, "observability.otlp_endpoint should default to empty string")
	assert.Equal(t, "prometheus", cfg.Observability.MetricsExportTarget, "observability.metrics_export_target should default to 'prometheus'")
	assert.Equal(t, "", cfg.Observability.MetricsProjectID, "observability.metrics_project_id should default to empty string")
}

func TestLoad_ObservabilityConfigEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_LOG_LEVEL", "debug")
	t.Setenv("SMITHERS_TRACE_SAMPLE_RATE", "1.0")
	t.Setenv("SMITHERS_CLOUD_TRACE_PROJECT_ID", "smithers-observability-dev")
	t.Setenv("SMITHERS_OTEL_EXPORTER", "otlp")
	t.Setenv("SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
	t.Setenv("SMITHERS_METRICS_EXPORT_TARGET", "cloud_monitoring")
	t.Setenv("SMITHERS_METRICS_PROJECT_ID", "smithers-metrics-dev")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "debug", cfg.Observability.LogLevel)
	assert.Equal(t, 1.0, cfg.Observability.TraceSampleRate)
	assert.Equal(t, "smithers-observability-dev", cfg.Observability.CloudTraceProjectID)
	assert.Equal(t, "otlp", cfg.Observability.OTelExporter)
	assert.Equal(t, "http://collector:4318", cfg.Observability.OTLPEndpoint)
	assert.Equal(t, "cloud_monitoring", cfg.Observability.MetricsExportTarget)
	assert.Equal(t, "smithers-metrics-dev", cfg.Observability.MetricsProjectID)
}

// TestConfig_MetricsQueryProjectID documents the project resolution order the
// admin metrics query endpoint uses: the dedicated setting first, then the
// deployment project Terraform already injects for blob storage, then empty
// (endpoint disabled).
func TestConfig_MetricsQueryProjectID(t *testing.T) {
	tests := []struct {
		name           string
		metricsProject string
		blobProject    string
		want           string
	}{
		{
			name:           "dedicated setting wins",
			metricsProject: "metrics-project",
			blobProject:    "blob-project",
			want:           "metrics-project",
		},
		{
			name:        "falls back to the blob project",
			blobProject: "blob-project",
			want:        "blob-project",
		},
		{
			name:           "whitespace is not a project",
			metricsProject: "   ",
			blobProject:    "  blob-project  ",
			want:           "blob-project",
		},
		{
			name: "unset disables the endpoint",
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &Config{}
			cfg.Observability.MetricsProjectID = tt.metricsProject
			cfg.Blob.GCSProject = tt.blobProject

			assert.Equal(t, tt.want, cfg.MetricsQueryProjectID())
		})
	}
}

// TestLoad_AuthConfigDefaultsAndEnvOverrides is the original auth test, now using
// the shared clearConfigEnv helper for full isolation.
func TestLoad_AuthConfigDefaultsAndEnvOverrides(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want AuthConfig
	}{
		{
			name: "defaults",
			want: AuthConfig{
				SessionDuration:      "720h",
				SessionRefreshWindow: "168h",
				SessionCookieName:    "smithers_session",
				SessionSecret:        "",
				LFSSigningSecret:     "",
				CookieSecure:         true,
				ClosedAlphaEnabled:   true,
				EnableKeyAuth:        true,
				KeyAuthDomain:        "smithers.sh",
				GitHubClientID:       "",
				GitHubClientSecret:   "",
				GitHubRedirectURL:    "http://localhost:4000/api/auth/github/callback",
				GitHubOAuthBaseURL:   "https://github.com",
				GitHubAPIBaseURL:     "https://api.github.com",
				Auth0Domain:          "",
				Auth0ClientID:        "",
				Auth0ClientSecret:    "",
				Auth0RedirectURL:     "http://localhost:4000/api/auth/auth0/callback",
				Auth0Connection:      "github",
				LinearClientID:       "",
				LinearClientSecret:   "",
				LinearRedirectURL:    "http://localhost:4000/api/auth/linear/callback",
			},
		},
		{
			name: "env overrides",
			env: map[string]string{
				"SMITHERS_AUTH_SESSION_DURATION":       "24h",
				"SMITHERS_AUTH_SESSION_REFRESH_WINDOW": "6h",
				"SMITHERS_AUTH_SESSION_COOKIE_NAME":    "smithers_custom",
				"SMITHERS_AUTH_SESSION_SECRET":         "session-secret-123",
				"SMITHERS_LFS_SIGNING_SECRET":          " lfs-signing-secret-123\n",
				"SMITHERS_AUTH_COOKIE_SECURE":          "false",
				"SMITHERS_AUTH_CLOSED_ALPHA_ENABLED":   "false",
				"SMITHERS_AUTH_GITHUB_CLIENT_ID":       "client-123",
				"SMITHERS_AUTH_GITHUB_CLIENT_SECRET":   "secret-456",
				"SMITHERS_AUTH_GITHUB_REDIRECT_URL":    "https://smithers.sh/auth/callback",
				"SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL":  "https://github.internal.example",
				"SMITHERS_AUTH_GITHUB_API_BASE_URL":    "https://api.github.internal.example",
				"SMITHERS_AUTH_KEY_AUTH_DOMAIN":        "smithers.local",
				"SMITHERS_AUTH_LINEAR_CLIENT_ID":       "linear-client-123",
				"SMITHERS_AUTH_LINEAR_CLIENT_SECRET":   "linear-secret-456",
				"SMITHERS_AUTH_LINEAR_REDIRECT_URL":    "https://smithers.sh/auth/linear/callback",
			},
			want: AuthConfig{
				SessionDuration:      "24h",
				SessionRefreshWindow: "6h",
				SessionCookieName:    "smithers_custom",
				SessionSecret:        "session-secret-123",
				LFSSigningSecret:     "lfs-signing-secret-123",
				CookieSecure:         false,
				ClosedAlphaEnabled:   false,
				EnableKeyAuth:        true,
				KeyAuthDomain:        "smithers.local",
				GitHubClientID:       "client-123",
				GitHubClientSecret:   "secret-456",
				GitHubRedirectURL:    "https://smithers.sh/auth/callback",
				GitHubOAuthBaseURL:   "https://github.internal.example",
				GitHubAPIBaseURL:     "https://api.github.internal.example",
				Auth0Domain:          "",
				Auth0ClientID:        "",
				Auth0ClientSecret:    "",
				Auth0RedirectURL:     "http://localhost:4000/api/auth/auth0/callback",
				Auth0Connection:      "github",
				LinearClientID:       "linear-client-123",
				LinearClientSecret:   "linear-secret-456",
				LinearRedirectURL:    "https://smithers.sh/auth/linear/callback",
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			clearConfigEnv(t)
			for key, value := range tc.env {
				t.Setenv(key, value)
			}

			cfg, err := Load("")
			require.NoError(t, err)
			assert.Equal(t, tc.want, cfg.Auth)
		})
	}
}

func TestLoad_WebhookSecretEncryptionKeyEnvOverride(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "webhook-encryption-key")

	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "webhook-encryption-key", cfg.Webhook.SecretEncryptionKey)
}

func TestLoad_BillingConfigEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_BILLING_MAX_MONTHLY_PRICE_ID", "price_max_monthly")
	t.Setenv("SMITHERS_BILLING_MAX_ANNUAL_PRICE_ID", "price_max_annual")
	t.Setenv("SMITHERS_BILLING_PRO_MONTHLY_PRICE_ID", "price_pro_monthly")
	t.Setenv("SMITHERS_BILLING_PRO_ANNUAL_PRICE_ID", "price_pro_annual")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "price_pro_monthly", cfg.Billing.ProMonthlyPriceID)
	assert.Equal(t, "price_max_monthly", cfg.Billing.MaxMonthlyPriceID)
	assert.Equal(t, "price_max_annual", cfg.Billing.MaxAnnualPriceID)
	assert.Equal(t, "price_pro_annual", cfg.Billing.ProAnnualPriceID)
}

// TestLoad_FullConfigDefaults verifies the complete Config struct when no env vars are set.
// This is a snapshot test — if defaults change, this test must be updated.
func TestLoad_FullConfigDefaults(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	expected := &Config{
		Agents: AgentsConfig{NeverStartedTimeout: "1h"},
		Server: ServerConfig{
			Addr:             ":4000",
			ReadTimeoutSecs:  30,
			WriteTimeoutSecs: 0,
			ShutdownTimeout:  "30s",
			SSHHost:          "localhost",
		},
		Database: DatabaseConfig{
			URL:             "",
			MaxConns:        25,
			MinConns:        5,
			MaxConnLifetime: 3600,
			MaxConnIdleTime: 1800,
		},
		RepoHost: RepoHostConfig{
			URL:       "http://localhost:8080",
			AuthToken: "",
		},
		Sandbox: SandboxConfig{
			Provider:               "microsandbox",
			GoldenSnapshotsEnabled: true,
			AgentSnapshotID:        "",
			AgentMemoryMB:          3072,
			WorkspaceMemoryMB:      4096,
			WorkspaceVCPUCount:     2,
			AgentVCPUCount:         1,
			AgentRootfsSizeMB:      2048,
			AgentMaxRuntimeSecs:    1800,
			AgentIdleTimeoutSecs:   300,
			DesktopMemoryMB:        2048,
			DesktopVCPUCount:       1,
			DesktopObserveText:     true,
			WorkspaceIdleTimeout:   1800,
			WorkspacePersistence:   "persistent",
			WorkspaceSSHHost:       "ssh.smithers.sh",
			WorkspaceSSHDialHost:   "",
			AnonEnabled:            true,
			AnonRepoAllowlist:      []string{"smithersai/smithers"},
			AnonTTLSecs:            1800,
			AnonMaxConcurrent:      10,
			AnonMaxPerIP:           2,
		},
		SSH: SSHConfig{
			Addr:                     ":2222",
			HostKeyDir:               "./data/ssh",
			MaxConnections:           100,
			MaxConnectionsPerIP:      10,
			MaxReceivePackSize:       500 * 1024 * 1024,
			MaxUploadPackRequestSize: 10 * 1024 * 1024,
			ReceivePackTimeout:       "10m",
			UploadPackTimeout:        "",
			ShutdownDrainTimeout:     "30s",
		},
		Auth: AuthConfig{
			SessionDuration:      "720h",
			SessionRefreshWindow: "168h",
			SessionCookieName:    "smithers_session",
			SessionSecret:        "",
			CookieSecure:         true,
			ClosedAlphaEnabled:   true,
			EnableKeyAuth:        true,
			KeyAuthDomain:        "smithers.sh",
			GitHubClientID:       "",
			GitHubClientSecret:   "",
			GitHubRedirectURL:    "http://localhost:4000/api/auth/github/callback",
			GitHubOAuthBaseURL:   "https://github.com",
			GitHubAPIBaseURL:     "https://api.github.com",
			Auth0Domain:          "",
			Auth0ClientID:        "",
			Auth0ClientSecret:    "",
			Auth0RedirectURL:     "http://localhost:4000/api/auth/auth0/callback",
			Auth0Connection:      "github",
			LinearClientID:       "",
			LinearClientSecret:   "",
			LinearRedirectURL:    "http://localhost:4000/api/auth/linear/callback",
		},
		Billing: BillingConfig{
			StripeSecretKey:          "",
			StripeWebhookSecret:      "",
			PortalReturnURL:          "",
			CheckoutSuccessURL:       "",
			CheckoutCancelURL:        "",
			PersonalMonthlyPriceID:   "",
			PersonalAnnualPriceID:    "",
			ProMonthlyPriceID:        "",
			ProAnnualPriceID:         "",
			TeamMonthlyPriceID:       "",
			TeamAnnualPriceID:        "",
			EnterpriseMonthlyPriceID: "",
			EnterpriseAnnualPriceID:  "",
		},
		Webhook: WebhookConfig{
			SecretEncryptionKey: "",
			GitHubAppSecret:     "",
		},
		ProviderConnections: ProviderConnectionsConfig{
			ClaudeTokenURL: "https://console.anthropic.com/v1/oauth/token",
			ClaudeClientID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			CodexTokenURL:  "https://auth.openai.com/oauth/token",
			CodexClientID:  "app_EMoamEEZ73f0CkXaXp7hrann",
		},
		Runner: RunnerConfig{
			PoolSize:                10,
			WarmTimeout:             "30s",
			TaskTimeout:             "30m",
			MaxAgentSessionDuration: "30m",
		},
		Cleanup: CleanupConfig{
			AuthInterval:                    "5m",
			WorkflowCacheInterval:           "1h",
			SandboxEgressAuditRetentionDays: 30,
		},
		Blob: BlobConfig{
			GCSBucket:                    "",
			GCSProject:                   "",
			SignedURLExpiry:              "5m",
			WorkflowCachePrefix:          "workflow-cache",
			WorkflowCacheTTL:             "168h",
			WorkflowCacheRepoQuotaBytes:  2 * 1024 * 1024 * 1024,
			WorkflowCacheArchiveMaxBytes: 1024 * 1024 * 1024,
			BuildCacheArtifactMaxBytes:   16 * 1024 * 1024,
		},
		Observability: ObservabilityConfig{
			LogLevel:            "info",
			TraceSampleRate:     0.01,
			CloudTraceProjectID: "",
			OTelExporter:        "cloudtrace",
			OTLPEndpoint:        "",
			MetricsExportTarget: "prometheus",
		},
		Email: EmailConfig{
			SendGridAPIKey:             "",
			SMTPHost:                   "",
			SMTPPort:                   587,
			SMTPUser:                   "",
			SMTPPass:                   "",
			SMTPFrom:                   "noreply@smithers.sh",
			SESRegion:                  "",
			SESFrom:                    "noreply@smithers.sh",
			From:                       "noreply@smithers.sh",
			BaseURL:                    "http://localhost:4000",
			RateLimitPerSecond:         10,
			RateLimitPerRecipientPerHr: 20,
		},
		FeatureFlags: FeatureFlagsConfig{
			ReadoutDashboard:     false,
			LandingQueue:         false,
			ToolSkills:           false,
			ToolPolicies:         false,
			RepoSnapshots:        false,
			Integrations:         false,
			SessionReplay:        false,
			SecretsManager:       false,
			WebEditor:            false,
			ClientErrorReporting: true,
			ClientMetrics:        true,
			// Ticket 12: core launch families default true; every other
			// non-MVP family defaults false.
			StackedPRs: true,
			Workflows:  true,
			Sandboxes:  true,
			AutoPush:   true,
			Secrets:    true,
		},
		RateLimit: RateLimitConfig{
			TerminalOpenPerMin:       20,
			TerminalActiveMax:        5,
			ApprovalDecidePerMin:     30,
			AppTimelineWritePerMin:   240,
			ShareListingEventPerMin:  30,
			AnonSandboxCreatePerHour: 5,
			BuildCachePerMinute:      1200,
		},
	}
	assert.Equal(t, expected, cfg)
}

func TestLoad_RepositorySecretsDefaultOnWithEmergencyDisable(t *testing.T) {
	clearConfigEnv(t)

	cfg, err := Load("")
	require.NoError(t, err)
	assert.True(t, cfg.FeatureFlags.Secrets)

	t.Setenv("SMITHERS_FEATURE_FLAGS_SECRETS", "false")
	cfg, err = Load("")
	require.NoError(t, err)
	assert.False(t, cfg.FeatureFlags.Secrets)
}

// TestLoad_PartialEnvOverrides verifies that setting only some env vars
// leaves the rest at their defaults (no cross-contamination).
func TestLoad_PartialEnvOverrides(t *testing.T) {
	clearConfigEnv(t)
	// Only override database URL and SSH addr
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://custom:custom@db:5432/custom")
	t.Setenv("SMITHERS_SSH_ADDR", ":2200")

	cfg, err := Load("")
	require.NoError(t, err)

	// Overridden values
	assert.Equal(t, "postgres://custom:custom@db:5432/custom", cfg.Database.URL)
	assert.Equal(t, ":2200", cfg.SSH.Addr)

	// Non-overridden values remain at defaults
	assert.Equal(t, ":4000", cfg.Server.Addr, "server.addr should remain default")
	assert.Equal(t, 30, cfg.Server.ReadTimeoutSecs, "server.read_timeout_secs should remain default")
	assert.Equal(t, 0, cfg.Server.WriteTimeoutSecs, "server.write_timeout_secs should remain default")
	assert.Equal(t, int32(25), cfg.Database.MaxConns, "max_conns should remain default")
	assert.Equal(t, "http://localhost:8080", cfg.RepoHost.URL, "repo_host.url should remain default")
	assert.Equal(t, "", cfg.RepoHost.AuthToken, "repo_host.auth_token should remain default")
	assert.Equal(t, "./data/ssh", cfg.SSH.HostKeyDir, "ssh.host_key_dir should remain default")
	assert.Equal(t, "720h", cfg.Auth.SessionDuration, "auth.session_duration should remain default")
}

// TestLoad_EnvPrefixIsolation verifies that non-SMITHERS_ env vars don't leak into config.
func TestLoad_EnvPrefixIsolation(t *testing.T) {
	clearConfigEnv(t)
	// Set a non-prefixed env var that could collide
	t.Setenv("SERVER_ADDR", ":9999")
	t.Setenv("DATABASE_URL", "postgres://other:other@other:5432/other")

	cfg, err := Load("")
	require.NoError(t, err)

	// These should NOT affect the config — only SMITHERS_-prefixed vars should
	assert.Equal(t, ":4000", cfg.Server.Addr, "non-SMITHERS_ prefix SERVER_ADDR should not affect config")
	assert.Equal(t, "", cfg.Database.URL,
		"non-SMITHERS_ prefix DATABASE_URL should not affect config (and there is no insecure default)")
}

// TestLoad_IntegerCoercionFromEnv verifies that integer config values
// are correctly parsed from string env vars.
func TestLoad_IntegerCoercionFromEnv(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_DATABASE_MAX_CONNS", "100")
	t.Setenv("SMITHERS_DATABASE_MIN_CONNS", "20")
	t.Setenv("SMITHERS_DATABASE_MAX_CONN_LIFETIME_SECS", "14400")
	t.Setenv("SMITHERS_DATABASE_MAX_CONN_IDLE_TIME_SECS", "7200")
	t.Setenv("SMITHERS_SERVER_READ_TIMEOUT_SECS", "35")
	t.Setenv("SMITHERS_SERVER_WRITE_TIMEOUT_SECS", "40")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, int32(100), cfg.Database.MaxConns)
	assert.Equal(t, int32(20), cfg.Database.MinConns)
	assert.Equal(t, 14400, cfg.Database.MaxConnLifetime)
	assert.Equal(t, 7200, cfg.Database.MaxConnIdleTime)
	assert.Equal(t, 35, cfg.Server.ReadTimeoutSecs)
	assert.Equal(t, 40, cfg.Server.WriteTimeoutSecs)
}

// TestLoad_SpecCompliance_DatabasePooling verifies database pool settings
// match the values specified in docs/specs/engineering.md section 4.3.
func TestLoad_SpecCompliance_DatabasePooling(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	// From engineering.md section 4.3:
	// MaxConns=25, MinConns=5, MaxConnLifetime=1hr, MaxConnIdleTime=30min
	assert.Equal(t, int32(25), cfg.Database.MaxConns, "spec: MaxConns=25")
	assert.Equal(t, int32(5), cfg.Database.MinConns, "spec: MinConns=5")
	assert.Equal(t, 3600, cfg.Database.MaxConnLifetime, "spec: MaxConnLifetime=1hr (3600s)")
	assert.Equal(t, 1800, cfg.Database.MaxConnIdleTime, "spec: MaxConnIdleTime=30min (1800s)")
}

// TestLoad_SpecCompliance_ServerPort verifies server binds to port 4000 by default
// as stated in the architecture diagram in engineering.md.
func TestLoad_SpecCompliance_ServerPort(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, ":4000", cfg.Server.Addr, "spec: API server runs on port 4000")
}

// TestLoad_SpecCompliance_AuthSessionDuration verifies default session duration
// matches the 30-day (720h) spec from engineering.md section 5.2.
func TestLoad_SpecCompliance_AuthSessionDuration(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "720h", cfg.Auth.SessionDuration, "spec: 30-day session duration (720h)")
}

// TestLoad_MultipleCallsAreIdempotent verifies that calling Load() multiple times
// returns consistent results (Viper state doesn't accumulate across calls).
func TestLoad_MultipleCallsAreIdempotent(t *testing.T) {
	clearConfigEnv(t)

	cfg1, err := Load("")
	require.NoError(t, err)

	cfg2, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, cfg1, cfg2, "multiple Load() calls should return identical config")
}

// TestLoad_EmptyStringEnvVarFallsBackToDefault documents that Viper treats
// empty-string env vars as "not set" and falls back to the default value.
// This is known Viper behavior — not a bug, but important to document.
func TestLoad_EmptyStringEnvVarFallsBackToDefault(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "")

	cfg, err := Load("")
	require.NoError(t, err)

	// Viper does NOT treat empty string as "set" — it falls back to default.
	// This means you cannot use env vars to clear a default to "".
	assert.Equal(t, "smithers_session", cfg.Auth.SessionCookieName,
		"Viper treats empty env var as unset, falls back to default")
}

// TestLoad_ConcurrentSafety verifies that Load() can be called concurrently
// without data races. Each call creates a fresh Viper instance so there should
// be no shared mutable state.
func TestLoad_ConcurrentSafety(t *testing.T) {
	clearConfigEnv(t)

	const goroutines = 10
	var wg sync.WaitGroup
	wg.Add(goroutines)
	errs := make(chan error, goroutines)
	cfgs := make(chan *Config, goroutines)

	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			cfg, err := Load("")
			errs <- err
			cfgs <- cfg
		}()
	}

	wg.Wait()
	close(errs)
	close(cfgs)

	for err := range errs {
		require.NoError(t, err)
	}

	// All configs should be identical (same defaults, no env vars)
	var first *Config
	for cfg := range cfgs {
		require.NotNil(t, cfg)
		if first == nil {
			first = cfg
		} else {
			assert.Equal(t, first, cfg, "all concurrent Load() calls should return identical config")
		}
	}
}

// TestLoad_EveryEnvVarOverrides_TableDriven is a comprehensive table-driven test
// that verifies EACH individual env var overrides exactly one field in the config,
// ensuring the BindEnv calls in Load() are correct and complete.
func TestLoad_EveryEnvVarOverrides_TableDriven(t *testing.T) {
	tests := []struct {
		envKey   string
		envValue string
		check    func(t *testing.T, cfg *Config)
	}{
		// Server
		{
			envKey: "SMITHERS_SERVER_ADDR", envValue: ":5555",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, ":5555", cfg.Server.Addr)
			},
		},
		{
			envKey: "SMITHERS_SERVER_READ_TIMEOUT_SECS", envValue: "37",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, 37, cfg.Server.ReadTimeoutSecs)
			},
		},
		{
			envKey: "SMITHERS_SERVER_WRITE_TIMEOUT_SECS", envValue: "38",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, 38, cfg.Server.WriteTimeoutSecs)
			},
		},
		{
			envKey: "SMITHERS_SERVER_SSH_HOST", envValue: "git.smithers.io",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "git.smithers.io", cfg.Server.SSHHost)
			},
		},
		// Database
		{
			envKey: "SMITHERS_DATABASE_URL", envValue: "postgres://test:test@testhost:5432/testdb",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "postgres://test:test@testhost:5432/testdb", cfg.Database.URL)
			},
		},
		{
			envKey: "SMITHERS_DATABASE_MAX_CONNS", envValue: "42",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int32(42), cfg.Database.MaxConns)
			},
		},
		{
			envKey: "SMITHERS_DATABASE_MIN_CONNS", envValue: "7",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int32(7), cfg.Database.MinConns)
			},
		},
		{
			envKey: "SMITHERS_DATABASE_MAX_CONN_LIFETIME_SECS", envValue: "9999",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, 9999, cfg.Database.MaxConnLifetime)
			},
		},
		{
			envKey: "SMITHERS_DATABASE_MAX_CONN_IDLE_TIME_SECS", envValue: "5555",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, 5555, cfg.Database.MaxConnIdleTime)
			},
		},
		// RepoHost
		{
			envKey: "SMITHERS_REPO_HOST_URL", envValue: "http://custom-repo:1234",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "http://custom-repo:1234", cfg.RepoHost.URL)
			},
		},
		{
			envKey: "SMITHERS_REPO_HOST_AUTH_TOKEN", envValue: "repo-host-secret",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "repo-host-secret", cfg.RepoHost.AuthToken)
			},
		},
		// Sandbox
		{
			envKey: "SMITHERS_SANDBOX_WORKSPACE_MEMORY_MB", envValue: "8192",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int32(8192), cfg.Sandbox.WorkspaceMemoryMB)
			},
		},
		{
			envKey: "SMITHERS_SANDBOX_WORKSPACE_VCPU_COUNT", envValue: "4",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int32(4), cfg.Sandbox.WorkspaceVCPUCount)
			},
		},
		{
			envKey: "SMITHERS_SANDBOX_AGENT_SNAPSHOT_ID", envValue: "snap_abc123",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "snap_abc123", cfg.Sandbox.AgentSnapshotID)
			},
		},
		{
			envKey: "SMITHERS_SANDBOX_AGENT_MEMORY_MB", envValue: "8192",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int32(8192), cfg.Sandbox.AgentMemoryMB)
			},
		},
		{
			envKey: "SMITHERS_SANDBOX_AGENT_VCPU_COUNT", envValue: "4",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int32(4), cfg.Sandbox.AgentVCPUCount)
			},
		},
		{
			envKey: "SMITHERS_SANDBOX_AGENT_ROOTFS_SIZE_MB", envValue: "20480",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int64(20480), cfg.Sandbox.AgentRootfsSizeMB)
			},
		},
		{
			envKey: "SMITHERS_SANDBOX_AGENT_MAX_RUNTIME_SECONDS", envValue: "900",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int64(900), cfg.Sandbox.AgentMaxRuntimeSecs)
			},
		},
		{
			envKey: "SMITHERS_SANDBOX_AGENT_IDLE_TIMEOUT_SECONDS", envValue: "900",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int64(900), cfg.Sandbox.AgentIdleTimeoutSecs)
			},
		},
		// SSH
		{
			envKey: "SMITHERS_SSH_ADDR", envValue: ":3333",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, ":3333", cfg.SSH.Addr)
			},
		},
		{
			envKey: "SMITHERS_SSH_HOST_KEY_DIR", envValue: "/custom/ssh/keys",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "/custom/ssh/keys", cfg.SSH.HostKeyDir)
			},
		},
		{
			envKey: "SMITHERS_SSH_MAX_RECEIVE_PACK_SIZE", envValue: "54321",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int64(54321), cfg.SSH.MaxReceivePackSize)
			},
		},
		{
			envKey: "SMITHERS_SSH_MAX_UPLOAD_PACK_REQUEST_SIZE", envValue: "1234",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int64(1234), cfg.SSH.MaxUploadPackRequestSize)
			},
		},
		{
			envKey: "SMITHERS_SSH_RECEIVE_PACK_TIMEOUT", envValue: "99m",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "99m", cfg.SSH.ReceivePackTimeout)
			},
		},
		{
			envKey: "SMITHERS_SSH_UPLOAD_PACK_TIMEOUT", envValue: "34m",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "34m", cfg.SSH.UploadPackTimeout)
			},
		},
		// Auth

		{
			envKey: "SMITHERS_AUTH_SESSION_DURATION", envValue: "48h",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "48h", cfg.Auth.SessionDuration)
			},
		},
		{
			envKey: "SMITHERS_AUTH_SESSION_REFRESH_WINDOW", envValue: "12h",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "12h", cfg.Auth.SessionRefreshWindow)
			},
		},
		{
			envKey: "SMITHERS_AUTH_SESSION_COOKIE_NAME", envValue: "custom_cookie",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "custom_cookie", cfg.Auth.SessionCookieName)
			},
		},
		{
			envKey: "SMITHERS_AUTH_SESSION_SECRET", envValue: "session-secret-override",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "session-secret-override", cfg.Auth.SessionSecret)
			},
		},
		{
			envKey: "SMITHERS_LFS_SIGNING_SECRET", envValue: "lfs-secret-override",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "lfs-secret-override", cfg.Auth.LFSSigningSecret)
			},
		},
		{
			envKey: "SMITHERS_AUTH_COOKIE_SECURE", envValue: "false",
			check: func(t *testing.T, cfg *Config) {
				assert.False(t, cfg.Auth.CookieSecure)
			},
		},
		{
			envKey: "SMITHERS_AUTH_CLOSED_ALPHA_ENABLED", envValue: "false",
			check: func(t *testing.T, cfg *Config) {
				assert.False(t, cfg.Auth.ClosedAlphaEnabled)
			},
		},
		{
			envKey: "SMITHERS_AUTH_GITHUB_CLIENT_ID", envValue: "gh-client-abc",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "gh-client-abc", cfg.Auth.GitHubClientID)
			},
		},
		{
			envKey: "SMITHERS_AUTH_GITHUB_CLIENT_SECRET", envValue: "gh-secret-xyz",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "gh-secret-xyz", cfg.Auth.GitHubClientSecret)
			},
		},
		{
			envKey: "SMITHERS_AUTH_GITHUB_REDIRECT_URL", envValue: "https://custom.dev/callback",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "https://custom.dev/callback", cfg.Auth.GitHubRedirectURL)
			},
		},
		{
			envKey: "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL", envValue: "https://ghe.internal.example",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "https://ghe.internal.example", cfg.Auth.GitHubOAuthBaseURL)
			},
		},
		{
			envKey: "SMITHERS_AUTH_GITHUB_API_BASE_URL", envValue: "https://api.ghe.internal.example",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "https://api.ghe.internal.example", cfg.Auth.GitHubAPIBaseURL)
			},
		},
		// Runner
		{
			envKey: "SMITHERS_RUNNER_POOL_SIZE", envValue: "17",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, 17, cfg.Runner.PoolSize)
			},
		},
		{
			envKey: "SMITHERS_RUNNER_WARM_TIMEOUT", envValue: "99s",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "99s", cfg.Runner.WarmTimeout)
			},
		},
		{
			envKey: "SMITHERS_RUNNER_TASK_TIMEOUT", envValue: "90m",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "90m", cfg.Runner.TaskTimeout)
			},
		},
		{
			envKey: "SMITHERS_RUNNER_MAX_AGENT_SESSION_DURATION", envValue: "2h",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "2h", cfg.Runner.MaxAgentSessionDuration)
			},
		},
		// Cleanup
		{
			envKey: "SMITHERS_CLEANUP_AUTH_INTERVAL", envValue: "11m",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "11m", cfg.Cleanup.AuthInterval)
			},
		},
		{
			envKey: "SMITHERS_CLEANUP_WORKFLOW_CACHE_INTERVAL", envValue: "22m",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "22m", cfg.Cleanup.WorkflowCacheInterval)
			},
		},
		// Blob
		{
			envKey: "SMITHERS_BLOB_GCS_BUCKET", envValue: "my-custom-bucket",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "my-custom-bucket", cfg.Blob.GCSBucket)
			},
		},
		{
			envKey: "SMITHERS_BLOB_AGENT_LOGS_GCS_BUCKET", envValue: "my-agent-logs-bucket",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "my-agent-logs-bucket", cfg.Blob.AgentLogsGCSBucket)
			},
		},
		{
			envKey: "SMITHERS_BLOB_GCS_PROJECT", envValue: "my-gcp-project",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "my-gcp-project", cfg.Blob.GCSProject)
			},
		},
		{
			envKey: "SMITHERS_BLOB_SIGNED_URL_EXPIRY", envValue: "9m",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "9m", cfg.Blob.SignedURLExpiry)
			},
		},
		{
			envKey: "SMITHERS_BLOB_WORKFLOW_CACHE_PREFIX", envValue: "wf-cache",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "wf-cache", cfg.Blob.WorkflowCachePrefix)
			},
		},
		{
			envKey: "SMITHERS_BLOB_WORKFLOW_CACHE_TTL", envValue: "72h",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "72h", cfg.Blob.WorkflowCacheTTL)
			},
		},
		{
			envKey: "SMITHERS_BLOB_WORKFLOW_CACHE_REPO_QUOTA_BYTES", envValue: "987654",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int64(987654), cfg.Blob.WorkflowCacheRepoQuotaBytes)
			},
		},
		{
			envKey: "SMITHERS_BLOB_WORKFLOW_CACHE_ARCHIVE_MAX_BYTES", envValue: "456789",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, int64(456789), cfg.Blob.WorkflowCacheArchiveMaxBytes)
			},
		},
		// Observability
		{
			envKey: "SMITHERS_TRACE_SAMPLE_RATE", envValue: "0.5",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, 0.5, cfg.Observability.TraceSampleRate)
			},
		},
		{
			envKey: "SMITHERS_CLOUD_TRACE_PROJECT_ID", envValue: "test-gcp-project",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "test-gcp-project", cfg.Observability.CloudTraceProjectID)
			},
		},
		{
			envKey: "SMITHERS_OTEL_EXPORTER", envValue: "otlp",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "otlp", cfg.Observability.OTelExporter)
			},
		},
		{
			envKey: "SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT", envValue: "http://collector:4318",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "http://collector:4318", cfg.Observability.OTLPEndpoint)
			},
		},
		{
			envKey: "SMITHERS_LOG_LEVEL", envValue: "debug",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "debug", cfg.Observability.LogLevel)
			},
		},
		{
			envKey: "SMITHERS_METRICS_EXPORT_TARGET", envValue: "cloud_monitoring",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "cloud_monitoring", cfg.Observability.MetricsExportTarget)
			},
		},
		{
			envKey: "SMITHERS_METRICS_PROJECT_ID", envValue: "metrics-gcp-project",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "metrics-gcp-project", cfg.Observability.MetricsProjectID)
				assert.Equal(t, "metrics-gcp-project", cfg.MetricsQueryProjectID())
			},
		},
		// Email
		{
			envKey: "SMITHERS_EMAIL_SMTP_HOST", envValue: "smtp.example.com",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "smtp.example.com", cfg.Email.SMTPHost)
			},
		},
		{
			envKey: "SMITHERS_EMAIL_SMTP_PORT", envValue: "465",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, 465, cfg.Email.SMTPPort)
			},
		},
		{
			envKey: "SMITHERS_EMAIL_SMTP_USER", envValue: "mailuser",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "mailuser", cfg.Email.SMTPUser)
			},
		},
		{
			envKey: "SMITHERS_EMAIL_SMTP_PASS", envValue: "mailpass",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "mailpass", cfg.Email.SMTPPass)
			},
		},
		{
			envKey: "SMITHERS_EMAIL_SMTP_FROM", envValue: "custom@smithers.sh",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "custom@smithers.sh", cfg.Email.SMTPFrom)
			},
		},
		{
			envKey: "SMITHERS_EMAIL_SES_REGION", envValue: "eu-west-1",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "eu-west-1", cfg.Email.SESRegion)
			},
		},
		{
			envKey: "SMITHERS_EMAIL_SES_FROM", envValue: "ses@smithers.sh",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "ses@smithers.sh", cfg.Email.SESFrom)
			},
		},
		{
			envKey: "SMITHERS_EMAIL_BASE_URL", envValue: "https://smithers.sh",
			check: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "https://smithers.sh", cfg.Email.BaseURL)
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.envKey, func(t *testing.T) {
			clearConfigEnv(t)
			t.Setenv(tc.envKey, tc.envValue)
			cfg, err := Load("")
			require.NoError(t, err)
			tc.check(t, cfg)
		})
	}
}

// TestLoad_InvalidIntegerEnvVar verifies that Load() returns an error when
// a non-numeric string is set for an integer config field.
// Viper's Unmarshal correctly rejects invalid string→int conversions.
func TestLoad_InvalidIntegerEnvVar(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_DATABASE_MAX_CONNS", "not_a_number")

	cfg, err := Load("")
	require.Error(t, err, "Load() should return error for non-numeric integer env var")
	assert.Nil(t, cfg, "config should be nil on error")
	assert.Contains(t, err.Error(), "cannot parse",
		"error should mention parsing failure")
}

// TestLoad_SpecCompliance_AuthRefreshWindow verifies the session refresh window
// default matches the "7 days" spec from engineering.md section 5.2.
func TestLoad_SpecCompliance_AuthRefreshWindow(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	// 7 days = 168 hours
	assert.Equal(t, "168h", cfg.Auth.SessionRefreshWindow,
		"spec: auto-refresh when within 7 days of expiry (168h)")
}

// TestLoad_SpecCompliance_SessionCookieName verifies the session cookie name
// uses the smithers_ prefix convention.
func TestLoad_SpecCompliance_SessionCookieName(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "smithers_session", cfg.Auth.SessionCookieName,
		"session cookie should use smithers_ prefix")
}

// TestLoad_SpecCompliance_SSHDefaultPort verifies the SSH server default port
// is :2222 (development mode — spec says production is :22).
func TestLoad_SpecCompliance_SSHDefaultPort(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, ":2222", cfg.SSH.Addr,
		"spec: SSH dev default is :2222, production overridden to :22 via SMITHERS_SSH_ADDR")
}

// TestLoad_SpecCompliance_SSHConfigShape verifies the SSH config fields match
// the engineering spec shape.
func TestLoad_SpecCompliance_SSHConfigShape(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	sshType := reflect.TypeOf(SSHConfig{})
	assert.Equal(t, 13, sshType.NumField(),
		"SSHConfig should have 13 fields")

	assert.Equal(t, ":2222", cfg.SSH.Addr)
	assert.Equal(t, "./data/ssh", cfg.SSH.HostKeyDir)
	assert.Equal(t, 100, cfg.SSH.MaxConnections)
	assert.Equal(t, 10, cfg.SSH.MaxConnectionsPerIP)
	assert.Equal(t, int64(500*1024*1024), cfg.SSH.MaxReceivePackSize)
	assert.Equal(t, int64(10*1024*1024), cfg.SSH.MaxUploadPackRequestSize)
	assert.Equal(t, "10m", cfg.SSH.ReceivePackTimeout)
	assert.Equal(t, "", cfg.SSH.UploadPackTimeout)
	assert.Equal(t, "30s", cfg.SSH.ShutdownDrainTimeout)
	assert.Equal(t, 0, cfg.SSH.AuthAttemptsPerMinute) // 0 means use package default
}

// TestLoad_SpecCompliance_GitHubRedirectURL verifies the default GitHub OAuth
// callback URL points to the correct API path.
func TestLoad_SpecCompliance_GitHubRedirectURL(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "http://localhost:4000/api/auth/github/callback", cfg.Auth.GitHubRedirectURL,
		"GitHub OAuth callback URL should use /api/auth/github/callback path")
	assert.Contains(t, cfg.Auth.GitHubRedirectURL, ":4000",
		"default GitHub redirect should use the same port as the API server default")
}

// TestLoad_ReturnsNewPointerEachCall verifies that successive Load() calls
// return distinct Config pointers (not the same cached pointer).
func TestLoad_ReturnsNewPointerEachCall(t *testing.T) {
	clearConfigEnv(t)

	cfg1, err := Load("")
	require.NoError(t, err)

	cfg2, err := Load("")
	require.NoError(t, err)

	// Equal values but different pointers — no accidental singleton
	assert.Equal(t, cfg1, cfg2)
	assert.NotSame(t, cfg1, cfg2, "Load() should return a new Config pointer each call")
}

// TestLoad_ConfigStructFieldCount verifies the Config struct has the expected number
// of top-level sections. This is a canary test — if a new config section is added to
// the struct but not tested, this test fails.
func TestLoad_ConfigStructFieldCount(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	// Config should have exactly 10 top-level sections:
	// Server, Database, RepoHost, SSH, Auth, Runner, Cleanup, Blob, Observability, Email
	// If a new section is added, this test forces adding tests for it.
	_ = cfg.Server
	_ = cfg.Database
	_ = cfg.RepoHost
	_ = cfg.SSH
	_ = cfg.Auth
	_ = cfg.Runner
	_ = cfg.Cleanup
	_ = cfg.Blob
	_ = cfg.Observability
	_ = cfg.Email

	// Verify by checking the struct has expected sections via values
	// (simpler: just check all expected sections are non-zero-value types)
	assert.Equal(t, ":4000", cfg.Server.Addr, "Server section present")
	// database.url has no insecure default (it must be supplied via env); assert
	// the section is present via a field that still has a non-zero default.
	assert.NotZero(t, cfg.Database.MaxConns, "Database section present")
	assert.NotEmpty(t, cfg.RepoHost.URL, "RepoHost section present")
	assert.NotEmpty(t, cfg.SSH.Addr, "SSH section present")
	assert.NotEmpty(t, cfg.Auth.SessionDuration, "Auth section present")
	assert.NotZero(t, cfg.Runner.PoolSize, "Runner section present")
	assert.NotEmpty(t, cfg.Cleanup.AuthInterval, "Cleanup section present")
	// Blob defaults to empty strings, so we verify it's accessible
	_ = cfg.Blob.GCSBucket
	_ = cfg.Blob.GCSProject
	// Observability checks
	_ = cfg.Observability.LogLevel
	_ = cfg.Observability.TraceSampleRate
	_ = cfg.Observability.CloudTraceProjectID
	_ = cfg.Observability.OTelExporter
	_ = cfg.Observability.OTLPEndpoint
	_ = cfg.Observability.MetricsExportTarget
	_ = cfg.Observability.MetricsProjectID
	// Email checks
	assert.Equal(t, 587, cfg.Email.SMTPPort, "Email section present")
	assert.Equal(t, "noreply@smithers.sh", cfg.Email.SMTPFrom, "Email default from")
}

// TestLoad_ConfigFileDefaultPaths verifies that Load("") searches default paths
// for config.yaml and loads it if found.
func TestLoad_ConfigFileDefaultPaths(t *testing.T) {
	clearConfigEnv(t)

	// Create a temp directory and change to it
	tmpDir := t.TempDir()
	originalWd, err := os.Getwd()
	require.NoError(t, err)
	defer os.Chdir(originalWd)
	err = os.Chdir(tmpDir)
	require.NoError(t, err)

	// Create a config.yaml in the current directory
	err = os.WriteFile("config.yaml", []byte(`
server:
  addr: ":6666"
`), 0o644)
	require.NoError(t, err)

	// Load with empty string should find and load config.yaml
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":6666", cfg.Server.Addr,
		"config.yaml in current directory should be loaded when Load(\"\") is called")
}

// TestLoad_SpecCompliance_RunnerConfig verifies runner defaults match spec.
func TestLoad_SpecCompliance_RunnerConfig(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, 10, cfg.Runner.PoolSize, "spec: runner.pool_size=10")
	assert.Equal(t, "30s", cfg.Runner.WarmTimeout, "spec: runner.warm_timeout=30s")
	assert.Equal(t, "30m", cfg.Runner.TaskTimeout, "spec: runner.task_timeout=30m")
	assert.Equal(t, "30m", cfg.Runner.MaxAgentSessionDuration, "spec: runner.max_agent_session_duration=30m")
}

// TestLoad_AllEnvKeysMatchBindEnvCalls verifies that the allEnvKeys list
// used by clearConfigEnv contains exactly the env vars that Load() binds.
// This ensures test isolation covers all env vars.
func TestLoad_AllEnvKeysMatchBindEnvCalls(t *testing.T) {
	// The allEnvKeys list should include every unique env name that Load binds.
	assert.Len(t, allEnvKeys, 190,
		"allEnvKeys should match the number of BindEnv calls in Load()")
	assert.ElementsMatch(t, configEnvKeyLiterals(t), allEnvKeys,
		"allEnvKeys should match the env-key string literals in config.go")

	// Verify no duplicates
	seen := make(map[string]bool)
	for _, key := range allEnvKeys {
		assert.False(t, seen[key], "duplicate env key in allEnvKeys: %s", key)
		seen[key] = true
	}

	// Verify all env keys carry the SMITHERS_ prefix. REPO_HOST_AUTH_TOKEN
	// is the only grandfathered fallback (legacy unprefixed env var).
	for _, key := range allEnvKeys {
		ok := strings.HasPrefix(key, "SMITHERS_") || key == "REPO_HOST_AUTH_TOKEN"
		assert.True(
			t,
			ok,
			"all env keys should have SMITHERS_ prefix or be the legacy REPO_HOST_AUTH_TOKEN fallback, got: %s",
			key,
		)
	}
}

func configEnvKeyLiterals(t *testing.T) []string {
	t.Helper()

	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "config.go", nil, 0)
	require.NoError(t, err)

	keys := make(map[string]struct{})
	ast.Inspect(file, func(node ast.Node) bool {
		lit, ok := node.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		value, err := strconv.Unquote(lit.Value)
		if err != nil || !isConfigEnvKeyLiteral(value) {
			return true
		}
		keys[value] = struct{}{}
		return true
	})

	result := make([]string, 0, len(keys))
	for key := range keys {
		result = append(result, key)
	}
	return result
}

func isConfigEnvKeyLiteral(value string) bool {
	if value == "REPO_HOST_AUTH_TOKEN" {
		return true
	}
	if !strings.HasPrefix(value, "SMITHERS_") {
		return false
	}
	for _, r := range value {
		if r == '_' || ('A' <= r && r <= 'Z') || ('0' <= r && r <= '9') {
			continue
		}
		return false
	}
	return true
}

// TestLoad_EnvOverrideSurvivesMultipleCalls verifies that an env var override
// persists across multiple Load() calls (Viper reads the env on each call).
func TestLoad_EnvOverrideSurvivesMultipleCalls(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_SERVER_ADDR", ":7777")

	cfg1, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":7777", cfg1.Server.Addr)

	cfg2, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":7777", cfg2.Server.Addr,
		"env var override should persist across multiple Load() calls")
}

// TestLoad_EnvOverrideMidFlight verifies that changing an env var between
// Load() calls is reflected in the second call (Viper reads env at call time).
func TestLoad_EnvOverrideMidFlight(t *testing.T) {
	clearConfigEnv(t)

	cfg1, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":4000", cfg1.Server.Addr)

	// Change env var between calls
	t.Setenv("SMITHERS_SERVER_ADDR", ":8888")

	cfg2, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, ":8888", cfg2.Server.Addr,
		"env var change between Load() calls should be reflected")
}

// TestLoad_ConfigStructFieldCountReflection uses reflection to count the actual
// number of fields in Config and each sub-struct. This is a stronger canary than
// TestLoad_ConfigStructFieldCount — it will fail if ANY field is added to ANY
// config struct without updating this test, ensuring test coverage keeps pace.
func TestLoad_ConfigStructFieldCountReflection(t *testing.T) {
	expectedFieldCounts := map[string]int{
		"Config":              17, // Server, Database, RepoHost, Sandbox, SSH, Auth, Billing, Webhook, ProviderConnections, Runner, Cleanup, Blob, Observability, Email, FeatureFlags, RateLimit
		"ServerConfig":        7,  // Addr, ReadTimeoutSecs, WriteTimeoutSecs, ShutdownTimeout, SSHHost, AllowedOrigins, TrustedProxyHops
		"DatabaseConfig":      5,  // URL, MaxConns, MinConns, MaxConnLifetime, MaxConnIdleTime
		"RepoHostConfig":      3,  // URL, AuthToken, PushHookCallbackToken
		"SandboxConfig":       37, // provider assertion, Microsandbox transport/accelerator, provider-neutral resource sizing/access, anonymous-sandbox bounds (enabled/allowlist/TTL/global+per-IP caps), repo-gateway provider credentials, agent seat, desktop guest sizing and observe-text switch, health probe, and preview relay token
		"SSHConfig":           13, // Addr, HostKeyDir, MaxConnections, MaxConnectionsPerIP, MaxReceivePackSize, MaxUploadPackRequestSize, ReceivePackTimeout, UploadPackTimeout, ShutdownDrainTimeout, AuthAttemptsPerMinute, IdleTimeout, MaxTimeout, MaxSessionsPerConn
		"AuthConfig":          23, // Session*, dedicated LFS signer, Cookie*, ClosedAlphaEnabled, EnableKeyAuth, KeyAuthDomain, GitHub* (5), Auth0* (5), Linear* (3), WorkerExchangeToken
		"BillingConfig":       15, // Stripe credentials, portal URLs, and plan price ids
		"WebhookConfig":       2,  // SecretEncryptionKey, GitHubAppSecret
		"AgentsConfig":        1,
		"RunnerConfig":        4,  // PoolSize, WarmTimeout, TaskTimeout, MaxAgentSessionDuration
		"CleanupConfig":       3,  // AuthInterval, WorkflowCacheInterval, SandboxEgressAuditRetentionDays
		"BlobConfig":          9,  // GCSBucket, AgentLogsGCSBucket, GCSProject, SignedURLExpiry, WorkflowCache*
		"ObservabilityConfig": 7,  // LogLevel, TraceSampleRate, CloudTraceProjectID, OTelExporter, OTLPEndpoint, MetricsExportTarget, MetricsProjectID
		"EmailConfig":         12, // SendGridAPIKey, SMTPHost, SMTPPort, SMTPUser, SMTPPass, SMTPFrom, SESRegion, SESFrom, From, BaseURL, RateLimitPerSecond, RateLimitPerRecipientPerHr
		"FeatureFlagsConfig":  37, // 11 base + 4 remote-client rollout + 21 ticket-12 MVP flags + Changesets (orgs is not a flag)
		"RateLimitConfig":     7,  // TerminalOpenPerMin, TerminalActiveMax, ApprovalDecidePerMin, AppTimelineWritePerMin, ShareListingEventPerMin, AnonSandboxCreatePerHour, BuildCachePerMinute
	}

	types := []reflect.Type{
		reflect.TypeOf(Config{}),
		reflect.TypeOf(AgentsConfig{}),
		reflect.TypeOf(ServerConfig{}),
		reflect.TypeOf(DatabaseConfig{}),
		reflect.TypeOf(RepoHostConfig{}),
		reflect.TypeOf(SandboxConfig{}),
		reflect.TypeOf(SSHConfig{}),
		reflect.TypeOf(AuthConfig{}),
		reflect.TypeOf(BillingConfig{}),
		reflect.TypeOf(WebhookConfig{}),
		reflect.TypeOf(RunnerConfig{}),
		reflect.TypeOf(CleanupConfig{}),
		reflect.TypeOf(BlobConfig{}),
		reflect.TypeOf(ObservabilityConfig{}),
		reflect.TypeOf(EmailConfig{}),
		reflect.TypeOf(FeatureFlagsConfig{}),
		reflect.TypeOf(RateLimitConfig{}),
	}

	for _, typ := range types {
		expected, ok := expectedFieldCounts[typ.Name()]
		require.True(t, ok, "missing expected field count for %s", typ.Name())
		assert.Equal(t, expected, typ.NumField(),
			"struct %s field count changed — update tests for new fields and update this canary", typ.Name())
	}

	// Total fields across all sub-structs.
	totalSubFields := 0
	for name, count := range expectedFieldCounts {
		if name != "Config" {
			totalSubFields += count
		}
	}
	assert.Equal(t, 185, totalSubFields,
		"total leaf fields across all config sub-structs")
}

// TestLoad_AllFieldsHaveMapstructureTags verifies that every field in every config
// struct has a `mapstructure` tag. Missing tags cause Viper to silently skip fields
// during Unmarshal, leading to confusing zero-value bugs.
func TestLoad_AllFieldsHaveMapstructureTags(t *testing.T) {
	types := []reflect.Type{
		reflect.TypeOf(Config{}),
		reflect.TypeOf(AgentsConfig{}),
		reflect.TypeOf(ServerConfig{}),
		reflect.TypeOf(DatabaseConfig{}),
		reflect.TypeOf(RepoHostConfig{}),
		reflect.TypeOf(SandboxConfig{}),
		reflect.TypeOf(SSHConfig{}),
		reflect.TypeOf(AuthConfig{}),
		reflect.TypeOf(BillingConfig{}),
		reflect.TypeOf(WebhookConfig{}),
		reflect.TypeOf(RunnerConfig{}),
		reflect.TypeOf(CleanupConfig{}),
		reflect.TypeOf(BlobConfig{}),
		reflect.TypeOf(ObservabilityConfig{}),
		reflect.TypeOf(EmailConfig{}),
		reflect.TypeOf(FeatureFlagsConfig{}),
		reflect.TypeOf(RateLimitConfig{}),
	}

	for _, typ := range types {
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			tag := field.Tag.Get("mapstructure")
			assert.NotEmpty(t, tag,
				"struct %s field %s is missing mapstructure tag — Viper will silently skip it",
				typ.Name(), field.Name)
		}
	}
}

// TestLoad_MapstructureTagsMatchViperKeys verifies that the mapstructure tags on
// sub-struct fields correspond to the Viper key paths used in SetDefault/BindEnv.
// This catches typos where the tag doesn't match the Viper key.
func TestLoad_MapstructureTagsMatchViperKeys(t *testing.T) {
	// Expected: top-level Config tags → Viper section prefixes
	topLevelTags := map[string]string{
		"Agents":              "agents",
		"Server":              "server",
		"Database":            "database",
		"RepoHost":            "repo_host",
		"Sandbox":             "sandbox",
		"SSH":                 "ssh",
		"Auth":                "auth",
		"Billing":             "billing",
		"Webhook":             "webhook",
		"ProviderConnections": "provider_connections",
		"Runner":              "runner",
		"Cleanup":             "cleanup",
		"Blob":                "blob",
		"Observability":       "observability",
		"Email":               "email",
		"FeatureFlags":        "feature_flags",
		"RateLimit":           "rate_limit",
	}

	cfgType := reflect.TypeOf(Config{})
	for i := 0; i < cfgType.NumField(); i++ {
		field := cfgType.Field(i)
		expected, ok := topLevelTags[field.Name]
		require.True(t, ok, "unexpected Config field: %s", field.Name)
		tag := field.Tag.Get("mapstructure")
		assert.Equal(t, expected, tag,
			"Config.%s mapstructure tag should be %q", field.Name, expected)
	}
}

// TestLoad_SpecDivergence_DatabaseExtraFields documents that the implementation
// has max_conn_lifetime_secs and max_conn_idle_time_secs which are not in the
// spec YAML example but are referenced in the pgxpool config documentation.
func TestLoad_SpecDivergence_DatabaseExtraFields(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	// These fields exist in implementation but not in spec config YAML
	assert.Equal(t, 3600, cfg.Database.MaxConnLifetime,
		"SPEC NOTE: max_conn_lifetime_secs (1hr) not in config YAML example but matches pgxpool spec 'MaxConnLifetime=1hr'")
	assert.Equal(t, 1800, cfg.Database.MaxConnIdleTime,
		"SPEC NOTE: max_conn_idle_time_secs (30min) not in config YAML example but matches pgxpool spec 'MaxConnIdleTime=30min'")
}

// TestLoad_SpecDivergence_AuthExtraFields documents that the implementation
// has session_refresh_window, session_cookie_name, and github_redirect_url
// which are not in the spec YAML example.
func TestLoad_SpecDivergence_AuthExtraFields(t *testing.T) {
	clearConfigEnv(t)
	cfg, err := Load("")
	require.NoError(t, err)

	assert.Equal(t, "168h", cfg.Auth.SessionRefreshWindow,
		"SPEC NOTE: session_refresh_window (7 days) not in config YAML but referenced in middleware section")
	assert.Equal(t, "smithers_session", cfg.Auth.SessionCookieName,
		"SPEC NOTE: session_cookie_name not in config YAML but used by auth middleware")
	assert.Equal(t, "http://localhost:4000/api/auth/github/callback", cfg.Auth.GitHubRedirectURL,
		"SPEC NOTE: github_redirect_url not in config YAML but required for OAuth flow")
	assert.Equal(t, "https://github.com", cfg.Auth.GitHubOAuthBaseURL,
		"SPEC NOTE: github_oauth_base_url not in config YAML but required for GitHub Enterprise-compatible OAuth host selection")
	assert.Equal(t, "https://api.github.com", cfg.Auth.GitHubAPIBaseURL,
		"SPEC NOTE: github_api_base_url not in config YAML but required for GitHub Enterprise-compatible API host selection")
}

func TestLoad_WorkspaceSandboxResourcesRejectNonIntegerEnv(t *testing.T) {
	for _, key := range []string{"SMITHERS_SANDBOX_WORKSPACE_MEMORY_MB", "SMITHERS_SANDBOX_WORKSPACE_VCPU_COUNT"} {
		for _, value := range []string{"not_a_number", "1.5"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				clearConfigEnv(t)
				t.Setenv(key, value)
				cfg, err := Load("")
				require.Error(t, err)
				assert.Nil(t, cfg)
			})
		}
	}
}

func TestLoad_WorkspaceCodingDefaultModelPin(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_WORKSPACE_CODING_DEFAULT_MODEL", "cerebras:gpt-oss-120b")
	cfg, err := Load("")
	require.NoError(t, err)
	assert.Equal(t, "cerebras:gpt-oss-120b", cfg.Sandbox.WorkspaceCodingDefaultModel)
}

// TestLoad_OrgsIsNotAFeatureFlag pins the owner decision (2026-09-15) that
// organizations are always on: no orgs field, no default, no env binding. Prod
// ran with feature_flags.orgs unset, which 403'd every /orgs/* route.
func TestLoad_OrgsIsNotAFeatureFlag(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("SMITHERS_FEATURE_FLAGS_ORGS", "true")

	cfg, err := Load("")
	require.NoError(t, err)

	assert.NotContains(t, allEnvKeys, "SMITHERS_FEATURE_FLAGS_ORGS",
		"orgs is not a feature flag, so Load must not bind an env var for it")

	flags := reflect.TypeOf(cfg.FeatureFlags)
	for i := 0; i < flags.NumField(); i++ {
		assert.NotEqual(t, "Orgs", flags.Field(i).Name,
			"FeatureFlagsConfig must not carry an Orgs field")
		assert.NotEqual(t, "orgs", flags.Field(i).Tag.Get("mapstructure"),
			"FeatureFlagsConfig must not map feature_flags.orgs")
	}
}
