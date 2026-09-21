package services

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/previewgateway"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Repo gateway: a durable `smithers gateway` control plane running inside a
// per-user+repo sandbox provider micro-VM, reached over sandbox provider HTTPS ingress
// (external 443 -> in-VM 7331). This is the fourth sandbox provider archetype next
// to agent-run VMs, one-shot workflow VMs, and workspace terminal VMs.
//
// Token model (constrained by stock smithers): the gateway validates ONLY the
// exact operator token it was started with — a fixed in-memory map, no DB
// tokens, no RPC mint. Per-request ephemeral tokens (the SSH terminal model)
// would require restarting the gateway, killing live runs. The operator token
// is therefore minted once at provision time, injected into the VM systemd
// environment, and stored encrypted at rest (same AES-256-GCM codec that
// protects repository secrets) plus a SHA-256 hash for audit. The advertised
// expires_at is a client re-resolve cadence: callers must re-fetch after it
// passes because the VM (and with it the token) can be rotated at any time.
// Because the VM alone validates the token, permission revocation is enforced
// by the reaper's access-revocation sweep (sweepRevokedGateways), which tears
// down gateways whose user lost write access to the repository.
const (
	repoGatewayPort        = int32(7331)
	repoGatewayServiceName = "smithers-gateway"
	repoGatewayWorkspace   = "/workspace/repo"
	repoGatewayTokenPrefix = "smithers_gateway_"
	// repoGatewayTokenAdvertisedTTL bounds how long a caller may cache the
	// returned token before re-resolving. The token itself stays valid for
	// the lifetime of the gateway process; the TTL exists so clients pick up
	// VM rotation promptly.
	repoGatewayTokenAdvertisedTTL = time.Hour
	// repoGatewayBunVersion is exact so a stale golden snapshot cannot keep an
	// older Bun than the immutable product host was tested against.
	repoGatewayBunVersion   = "1.4.0"
	repoGatewayCloneTimeout = 3 * time.Minute
	// repoGatewayMemSizeMB sizes the gateway VM. The 512 MiB placement default
	// OOM-killed the gateway process live when the stock create-workflow's
	// verify step ran bunx + bun test next to it (2026-08-10 prod proof). 2
	// GiB leaves the CPU-bound pool math untouched (7 one-vCPU slots × 2 GiB
	// = 14 GiB of the worker's 25.6 GiB).
	repoGatewayMemSizeMB          = 2048
	repoGatewayResumeTimeout      = 2 * time.Minute
	repoGatewayCleanupTimeout     = 30 * time.Second
	defaultRepoGatewayIdleTimeout = int64(1800)
	// repoGatewayRuntimeInstallTimeout bounds the bun + jj runtime install:
	// two network downloads on a cold VM.
	repoGatewayRuntimeInstallTimeout = 3 * time.Minute
	// repoGatewayHealthProbe* bound the resume-time liveness probe: after the
	// sandbox provider reports the VM running, the gateway process itself must
	// answer /health through the preview ingress (the relay's own upstream)
	// before the resolve path may answer status:"running". A resumed VM's
	// systemd unit takes seconds to bind, so the probe retries briefly; a VM
	// that never answers is wedged and must be discarded + reprovisioned
	// rather than 502-ing every relay call forever.
	repoGatewayHealthProbeAttempts = 15
	repoGatewayHealthProbeInterval = 4 * time.Second
	repoGatewayHealthProbeTimeout  = 5 * time.Second
	// repoGatewayWidowedIdleMax is how long a gateway row whose VM is stopped
	// may sit past the idle-suspend contract before the reaper discards it, so
	// the next resolve provisions a fresh gateway (current pin, current agent
	// seat) instead of resuming a stale snapshot forever.
	repoGatewayWidowedIdleMax = 24 * time.Hour
	// repoGatewayProvisionResponseBudget bounds how long POST
	// /api/repos/{owner}/{repo}/gateway holds the connection before answering
	// 409 "still provisioning". A FRESH provision is a multi-minute job
	// (runtime install, repository clone, and gateway startup), and no
	// real client holds a connection that long: production measured a
	// Cloudflare-fronted provision answered 504 after 1m9s while a direct one
	// took 1m15s to return 200. Answer inside every client's patience instead,
	// and let the caller poll the 409 (the documented client taxonomy).
	repoGatewayProvisionResponseBudget = 12 * time.Second
	// repoGatewayProvisionBackgroundBudget bounds the detached provisioning
	// work itself. It must stay comfortably under repoGatewayStaleProvisionAge
	// so a wedged provision is reaped rather than holding the active slot.
	repoGatewayProvisionBackgroundBudget = 20 * time.Minute
)

// repoGatewayRuntimeInstallScript installs tools that are not available as OS
// packages. The controller boot contract installs the declared OS packages.
// The exact Bun pin upgrades stale golden snapshots as well as installing on
// bare images.
var repoGatewayRuntimeInstallScript = strings.Join([]string{`set -euo pipefail
export HOME=/root
install -d /workspace`,
	repoGatewayBunInstallScript(
		"/usr/local/bin/bun",
		"/root/.bun/bin/bun",
		repoGatewayBunDownloadScript,
	),
	repoGatewayJJInstallScript,
	`/usr/local/bin/bun --version
/usr/local/bin/jj --version`,
}, "\n")

// Release digests come from Bun's bun-v1.4.0 SHASUMS256.txt and the jj
// v0.44.0 release (the same jj pin as cmd/runner/Dockerfile). Verify bytes
// before extraction, and use a private staging directory on every invocation.
const repoGatewayBunDownloadScript = `(
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  case "$(uname -m)" in
    x86_64) asset=bun-linux-x64; digest=2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452 ;;
    aarch64|arm64) asset=bun-linux-aarch64; digest=4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e ;;
    *) echo "unsupported gateway architecture" >&2; exit 1 ;;
  esac
  curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/oven-sh/bun/releases/download/bun-v${bun_version}/${asset}.zip" -o "$stage/bun.zip"
  printf '%s  %s\n' "$digest" "$stage/bun.zip" | sha256sum -c -
  unzip -q "$stage/bun.zip" -d "$stage"
  install -d "$(dirname "$staged_bun_path")"
  install -m 755 "$stage/$asset/bun" "$staged_bun_path"
)`

const repoGatewayJJInstallScript = `(
  jj_version=0.44.0
  # Release binaries report "jj <version>-<commit>", so match the prefix.
  if [ -x /usr/local/bin/jj ]; then case "$(/usr/local/bin/jj --version)" in "jj $jj_version"|"jj $jj_version-"*) exit 0 ;; esac; fi
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  case "$(uname -m)" in
    x86_64) arch=x86_64; digest=0a07bab4641a55fd2bc2fd1563ba3a3f9a577584086ad74086a1c5b69b3ffce9 ;;
    aarch64|arm64) arch=aarch64; digest=60d42fa2a9abaa445eff10cd2087458562aaad5a54b90309e5a3787ecc985ff2 ;;
    *) echo "unsupported gateway architecture" >&2; exit 1 ;;
  esac
  curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/jj-vcs/jj/releases/download/v${jj_version}/jj-v${jj_version}-${arch}-unknown-linux-musl.tar.gz" -o "$stage/jj.tar.gz"
  printf '%s  %s\n' "$digest" "$stage/jj.tar.gz" | sha256sum -c -
  tar -xzf "$stage/jj.tar.gz" -C "$stage"
  install -m 755 "$stage/jj" /usr/local/bin/jj
  case "$(/usr/local/bin/jj --version)" in "jj $jj_version"|"jj $jj_version-"*) ;; *) echo "unexpected jj version: $(/usr/local/bin/jj --version)" >&2; exit 1 ;; esac
)`

// repoGatewayBunInstallScript installs the exact supported Bun version when
// the VM has no Bun or carries a stale copy from a golden snapshot.
func repoGatewayBunInstallScript(bunPath, stagedBunPath, installerCommand string) string {
	return strings.Join([]string{
		"bun_version=" + shellQuote(repoGatewayBunVersion),
		"bun_path=" + shellQuote(bunPath),
		"staged_bun_path=" + shellQuote(stagedBunPath),
		`installed_bun_version=""`,
		`if [ -x "$bun_path" ]; then`,
		`  installed_bun_version="$("$bun_path" --version || true)"`,
		`fi`,
		`if [ "$installed_bun_version" != "$bun_version" ]; then`,
		// The base image exports BUN_INSTALL=/workspace/.bun for its own bun;
		// without this pin the bun installer honors it and stages the fresh
		// binary there, and the install below stats a path that never exists
		// (the 2026-08-04 production gateway provisioning failure). The
		// installer drops the binary at $BUN_INSTALL/bin/bun, so the pin is
		// the staged path's grandparent.
		`  export BUN_INSTALL="$(dirname "$(dirname "$staged_bun_path")")"`,
		"  " + installerCommand,
		`  install -m 755 "$staged_bun_path" "$bun_path"`,
		`fi`,
		`test "$("$bun_path" --version)" = "$bun_version"`,
	}, "\n")
}

// RepoGatewayQuerier is the DB contract needed by RepoGatewayService.
type RepoGatewayQuerier interface {
	CreateRepoGateway(ctx context.Context, arg db.CreateRepoGatewayParams) (db.RepoGateway, error)
	GetActiveRepoGatewayForUserRepo(ctx context.Context, arg db.GetActiveRepoGatewayForUserRepoParams) (db.RepoGateway, error)
	UpdateRepoGatewayExecutionInfo(ctx context.Context, arg db.UpdateRepoGatewayExecutionInfoParams) (db.RepoGateway, error)
	UpdateRepoGatewayStatus(ctx context.Context, arg db.UpdateRepoGatewayStatusParams) (db.RepoGateway, error)
	TouchRepoGatewayActivity(ctx context.Context, id string) error
	SoftDeleteRepoGateway(ctx context.Context, id string) (db.RepoGateway, error)
	// ListStaleRepoGateways backs the reaper: non-terminal rows older than the
	// given age whose provision is presumed crashed.
	ListStaleRepoGateways(ctx context.Context, ageSeconds int64) ([]db.RepoGateway, error)
	// ListActiveRepoGateways backs the widowed-gateway sweep: 'running' and
	// 'suspended' rows re-validated against the sandbox provider.
	ListActiveRepoGateways(ctx context.Context) ([]db.RepoGateway, error)

	// Short-lived repo clone token store (same flow as agent/workspace VMs).
	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
}

type RepoGatewayRelayQuerier interface {
	GetRepoGatewayByID(ctx context.Context, id string) (db.RepoGateway, error)
}

// RepoGatewayRelayTarget is the authenticated, internal routing result used by
// the API relay. The public client never receives the controller/service URL.
type RepoGatewayRelayTarget struct {
	GatewayID string
	Domain    string
	// UserID and RepositoryID identify whose authorization the relay rides on,
	// so a revocation of either can end every connection the relay carries.
	UserID       int64
	RepositoryID int64
	WorkspaceID  string
	SandboxID    string
}

// AuthorizeRelay verifies the static operator token before any HTTP or
// WebSocket bytes are proxied to a repository gateway.
func (s *RepoGatewayService) AuthorizeRelay(ctx context.Context, gatewayID, token string) (RepoGatewayRelayTarget, error) {
	if s.q == nil || strings.TrimSpace(gatewayID) == "" || strings.TrimSpace(token) == "" {
		return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
	}
	relayQ, ok := s.q.(RepoGatewayRelayQuerier)
	if !ok {
		return RepoGatewayRelayTarget{}, pkgerrors.Internal("repo gateway relay store unavailable")
	}
	gateway, err := relayQ.GetRepoGatewayByID(ctx, gatewayID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
		}
		return RepoGatewayRelayTarget{}, pkgerrors.Internal("load repo gateway: " + err.Error())
	}
	digest := sha256.Sum256([]byte(token))
	want, decodeErr := hex.DecodeString(gateway.AuthTokenHash)
	if decodeErr != nil || len(want) != len(digest) || subtle.ConstantTimeCompare(want, digest[:]) != 1 {
		return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
	}
	if gateway.Status != "running" || strings.TrimSpace(gateway.VmID) == "" {
		return RepoGatewayRelayTarget{}, pkgerrors.Conflict("repo gateway is not running")
	}
	if gateway.WorkspaceID.Valid {
		workspace, err := s.loadGatewayWorkspace(ctx, gateway.WorkspaceID.String(), gateway.RepositoryID, gateway.UserID)
		if err != nil {
			return RepoGatewayRelayTarget{}, err
		}
		if workspace.VmID != gateway.VmID || workspace.Status != "running" {
			return RepoGatewayRelayTarget{}, pkgerrors.Conflict("bound workspace is not running at the recorded VM")
		}
		_ = s.workspaces.q.TouchWorkspaceActivity(ctx, workspace.ID)
	}
	_ = s.q.TouchRepoGatewayActivity(ctx, gateway.ID)
	return RepoGatewayRelayTarget{GatewayID: gateway.ID, Domain: gatewayIngressDomain(gateway), UserID: gateway.UserID, RepositoryID: gateway.RepositoryID, WorkspaceID: gatewayWorkspaceID(gateway), SandboxID: gateway.VmID}, nil
}

// RepoGatewayVMClient is the minimal sandbox provider surface for gateway VMs.
type RepoGatewayVMClient interface {
	CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	InspectSandbox(ctx context.Context, vmID string) (sandbox.Sandbox, error)
	StartSandbox(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error)
	DeleteSandbox(ctx context.Context, vmID string) error
	CreateService(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error)
	Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
	PublishIngress(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error)
	RevokeIngress(ctx context.Context, domain string) error
}

// repoGatewayDomain returns the Plue-routed preview hostname for a sandbox.
func repoGatewayDomain(vmID string) string {
	label := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(vmID)), "_", "-")
	return "smithers-gw-" + label + ".preview.jjhub.tech"
}

// WithRepoGatewayGoldenSnapshots wires the golden-snapshot provider so
// gateway VMs boot from the pre-baked toolchain image: the runtime-install
// step then degrades to a fast verify instead of downloading bun/jj cold.
func WithRepoGatewayGoldenSnapshots(golden *GoldenSnapshotService) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) { s.goldenSnapshots = golden }
}

// RepoGatewayAccessQuerier is the DB surface for the access-revocation sweep:
// list live gateway rows, load their repository, and re-resolve the user's
// current permission. *db.Queries implements it.
type RepoGatewayAccessQuerier interface {
	RepoPermQuerier
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	ListActiveRepoGateways(ctx context.Context) ([]db.RepoGateway, error)
}

// WithRepoGatewayAccessRevocation wires the periodic authorization sweep run
// by the reaper: every live gateway's user is re-checked against current
// repository permissions and gateways whose user lost write access are torn
// down. The gateway VM validates ONLY its static operator token (Smithers is
// not in the request path), so collaborator/team/org/repo permission
// revocation cannot reach an already-resolved token any other way — without
// this sweep a revoked writer keeps driving the gateway and its cloned checkout
// for the lifetime of the VM.
func WithRepoGatewayAccessRevocation(q RepoGatewayAccessQuerier) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) { s.accessQuerier = q }
}

// RepoGatewayConcurrencyCounter reports a user's current active-sandbox count
// (workspaces + gateways) so provisioning a NEW gateway can be capped without
// 429ing a reuse/resume of an existing one. *db.Queries implements it via
// CountActiveSandboxesForUser.
type RepoGatewayConcurrencyCounter interface {
	CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error)
}

// RepoGatewayConnectionInput identifies the repo + user asking for a gateway.
type RepoGatewayConnectionInput struct {
	RepositoryID        int64
	UserID              int64
	RepoOwner           string
	RepoName            string
	RepoDefaultBookmark string
	WorkspaceID         string
	RequiredCapability  string
}

// RepoGatewayConnectionInfo is returned to the API caller. Token is plaintext
// in-memory for this response only.
type RepoGatewayConnectionInfo struct {
	BaseURL     string    `json:"base_url"`
	Token       string    `json:"token"`
	ExpiresAt   time.Time `json:"expires_at"`
	GatewayID   string    `json:"gateway_id"`
	VMID        string    `json:"vm_id"`
	Status      string    `json:"status"`
	WorkspaceID string    `json:"workspace_id,omitempty"`
}

// RepoGatewayService provisions and resumes per-user+repo gateway VMs.
type RepoGatewayService struct {
	billing         BillingPolicy
	revocations     revocation.Publisher
	q               RepoGatewayQuerier
	sandbox         RepoGatewayVMClient
	workspaces      *WorkspaceService
	sandboxMetrics  SandboxMetricsRecorder
	productHostPath string
	// goldenSnapshots supplies the pre-baked toolchain snapshot gateway VMs
	// boot from (nil / empty id → bare base image).
	goldenSnapshots    *GoldenSnapshotService
	secretCodec        webhook.SecretCodec
	gitBaseURL         string
	idleTimeoutSeconds int64
	persistence        sandbox.PersistenceMode
	persistencePrio    int32
	// concurrencyCounter + concurrencyMax cap how many active sandboxes (VMs) a
	// user may hold; the cap is enforced ONLY on the provision path (a reuse of
	// an existing gateway consumes no new capacity and must never be blocked).
	concurrencyCounter RepoGatewayConcurrencyCounter
	concurrencyMax     int
	// accessQuerier backs the reaper's access-revocation sweep (nil disables it).
	accessQuerier RepoGatewayAccessQuerier
	// agentSeatAPIKey is the AI-provider credential injected into every new
	// gateway VM's systemd env as CEREBRAS_API_KEY. Empty disables the seat:
	// gateways are provisioned with the stock generated agents.ts and agent
	// nodes honestly fail for lack of a provider (pre-wave-12b behavior).
	agentSeatAPIKey string
	// agentProviderEnv contains platform-owned provider credentials copied into
	// every new gateway VM's systemd environment. Empty values are omitted.
	agentProviderEnv map[string]string
	// healthProbeBaseURL enables the resume-time liveness probe when non-empty
	// (see repoGatewayHealthProbe*). Empty disables it for local dev, which has
	// no preview gateway.
	healthProbeBaseURL string
	healthProbeClient  *http.Client
	// previewRelayToken is presented to the preview gateway on every probe
	// and repository-job call (previewgateway.RelayTokenHeader): the gateway
	// refuses smithers-gw-* domains without it.
	previewRelayToken string
	// sleep is overridable in tests so probe retries don't cost wall-clock.
	sleep func(context.Context, time.Duration) error
	// provisionResponseBudget / provisionBackgroundBudget are overridable in
	// tests so the detached-provision path costs no wall-clock.
	provisionResponseBudget   time.Duration
	provisionBackgroundBudget time.Duration
	// resolveMu + resolveInflight singleflight the reuse/resume of an existing
	// gateway row, so a client polling the 409 does not start a fresh
	// multi-minute resume on every poll.
	resolveMu       sync.Mutex
	resolveInflight map[string]*repoGatewayResolve
}

// repoGatewayResolve is one in-flight reuse-or-replace of an existing gateway
// row. It carries the result to every caller that attached to it; `done` is
// closed once info/err are written, which is the happens-before edge they read
// through.
type repoGatewayResolve struct {
	done chan struct{}
	info RepoGatewayConnectionInfo
	err  error
}

// RepoGatewayServiceOption configures optional dependencies.
type RepoGatewayServiceOption func(*RepoGatewayService)

// WithRepoGatewaySandboxClient sets the sandbox provider VM client.
func WithRepoGatewaySandboxClient(client RepoGatewayVMClient) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		s.sandbox = client
	}
}

// WithRepoGatewaySandboxMetrics wires VM lifecycle metrics.
func WithRepoGatewaySandboxMetrics(metrics SandboxMetricsRecorder) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		s.sandboxMetrics = metrics
	}
}

// WithRepoGatewaySecretCodec sets the codec used to encrypt the gateway
// operator token at rest. Production wiring passes the same codec used for
// repository/webhook secrets.
func WithRepoGatewaySecretCodec(codec webhook.SecretCodec) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		if codec != nil {
			s.secretCodec = codec
		}
	}
}

// WithRepoGatewayGitBaseURL sets the public base URL used to clone repos into
// gateway VMs.
func WithRepoGatewayGitBaseURL(url string) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		s.gitBaseURL = strings.TrimSpace(url)
	}
}

// WithRepoGatewayConcurrencyCap wires the per-user active-sandbox cap enforced
// on the gateway PROVISION path only. max <= 0 or a nil counter disables it.
func WithRepoGatewayConcurrencyCap(counter RepoGatewayConcurrencyCounter, max int) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		if counter != nil && max > 0 {
			s.concurrencyCounter = counter
			s.concurrencyMax = max
		}
	}
}

// WithRepoGatewayIdleTimeout overrides the sandbox provider idle-suspend timeout.
func WithRepoGatewayIdleTimeout(seconds int64) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		if seconds > 0 {
			s.idleTimeoutSeconds = seconds
		}
	}
}

// WithRepoGatewayAgentSeat configures the platform Cerebras credential in the
// gateway service environment. It never enters the immutable host artifact.
func WithRepoGatewayAgentSeat(apiKey string) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		// An operator-seeded "placeholder-pending-..." value is non-empty, so
		// without this filter it arms the seat with a credential that 401s on
		// every model call — worse than an honestly disarmed seat, which fails
		// agent nodes with a message instead of hanging.
		if !IsUsableProviderCredential(apiKey) {
			s.agentSeatAPIKey = ""
			return
		}
		s.agentSeatAPIKey = strings.TrimSpace(apiKey)
	}
}

// WithRepoGatewayProviderEnv wires platform-owned AI provider credentials into
// every new gateway VM's systemd environment. The map is copied so callers can
// safely reuse their configuration map after construction.
func WithRepoGatewayProviderEnv(providerEnv map[string]string) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		if len(providerEnv) == 0 {
			return
		}
		// Placeholders are filtered here too: a gateway VM selects its
		// provider by env-var presence, so a placeholder key would win over a
		// real one.
		s.agentProviderEnv = UsableProviderCredentials(providerEnv)
	}
}

// WithRepoGatewayHealthProbe enables the resume-time liveness probe against
// {baseURL}/__preview/{gateway-domain}/health (the relay's own upstream path).
// An empty baseURL disables the probe. A nil client gets a bounded default.
func WithRepoGatewayHealthProbe(baseURL string, client *http.Client) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		s.healthProbeBaseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
		if client != nil {
			s.healthProbeClient = client
		}
	}
}

// WithPreviewRelayToken sets the credential the preview gateway demands for
// smithers-gw-* domains. Empty leaves every probe unauthenticated, which the
// gateway refuses with 401 (fail closed, and loud).
func WithPreviewRelayToken(token string) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) { s.previewRelayToken = strings.TrimSpace(token) }
}

// setPreviewRelayToken stamps the relay credential on one preview gateway request.
func (s *RepoGatewayService) setPreviewRelayToken(req *http.Request) {
	if s.previewRelayToken != "" {
		req.Header.Set(previewgateway.RelayTokenHeader, s.previewRelayToken)
	}
}

// NewRepoGatewayService returns a new RepoGatewayService.
func NewRepoGatewayService(q RepoGatewayQuerier, opts ...RepoGatewayServiceOption) *RepoGatewayService {
	svc := &RepoGatewayService{
		q:                  q,
		productHostPath:    repoGatewayProductHostPath,
		secretCodec:        webhook.NoopSecretCodec{},
		idleTimeoutSeconds: defaultRepoGatewayIdleTimeout,
		persistence:        sandbox.PersistencePersistent,
		persistencePrio:    5,
		healthProbeClient:  &http.Client{Timeout: repoGatewayHealthProbeTimeout},

		provisionResponseBudget:   repoGatewayProvisionResponseBudget,
		provisionBackgroundBudget: repoGatewayProvisionBackgroundBudget,
		sleep: func(ctx context.Context, d time.Duration) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(d):
				return nil
			}
		},
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

// GetRepoGatewayConnectionInfo returns connection details for the repo's
// gateway, provisioning or resuming the backing sandbox provider VM as needed.
func (s *RepoGatewayService) GetRepoGatewayConnectionInfo(ctx context.Context, input RepoGatewayConnectionInput) (RepoGatewayConnectionInfo, error) {
	// A named capability is checked against the host's own advertised list by
	// requireWorkspaceGatewayCapability, which needs the workspace it belongs
	// to. The capability itself is the caller's: one workspace host serves
	// repository jobs and a dispatched agent turn from the same process.
	if input.RequiredCapability != "" && input.WorkspaceID == "" {
		return RepoGatewayConnectionInfo{}, pkgerrors.BadRequest(input.RequiredCapability + " requires an owning workspace")
	}
	if s.q == nil {
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("repo gateway store unavailable")
	}
	if s.sandbox == nil {
		// Honest degradation: this deployment has no sandbox provider credentials,
		// so no gateway can exist. 409 (not 500) so clients can render a
		// "workflows not available on this deployment" state.
		return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("gateway provisioning is not configured on this deployment")
	}

	if input.WorkspaceID != "" {
		info, err := s.getWorkspaceGateway(ctx, input)
		if err == nil && input.RequiredCapability != "" {
			err = s.requireWorkspaceGatewayCapability(ctx, info, input.RequiredCapability)
		}
		return info, err
	}

	existing, err := s.q.GetActiveRepoGatewayForUserRepo(ctx, db.GetActiveRepoGatewayForUserRepoParams{
		RepositoryID: input.RepositoryID,
		UserID:       input.UserID,
	})
	switch {
	case err == nil:
		return s.resolveExistingGateway(ctx, existing, input)
	case errors.Is(err, pgx.ErrNoRows):
		return s.provisionGateway(ctx, input)
	default:
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("load repo gateway: " + err.Error())
	}
}

// resolveExistingGateway reuses an existing gateway row — resuming its VM and
// re-declaring the gateway service when the provider idle-suspended it — under
// the SAME response budget the provision path has had since the wave-11 wedge.
//
// The reuse path was the one half of this route left holding the caller's
// connection for as long as the work took: InspectSandbox, then a StartSandbox
// bounded at repoGatewayResumeTimeout and retried once (four minutes), then the
// service re-declare and its retry, the runtime compatibility check, and
// finally the health probe's attempt loop. Production measured the product's
// "Preparing your <repo> workspace…" standing past 120s with no run card and no
// error, and POST /api/workflow/provision timing out at 20s, on exactly this
// path (repro apps/ui/canary-repros/honesty/22.6 and flow-sweep/A.18).
//
// So run it on a context detached from request cancellation and answer 409
// "still resuming" once the response budget elapses — the documented client
// taxonomy the provision path already uses, which callers poll rather than
// stampede. The work is singleflighted per gateway row: without that, a client
// polling every two seconds would start a fresh four-minute resume per poll and
// the gateway could never converge.
func (s *RepoGatewayService) resolveExistingGateway(ctx context.Context, existing db.RepoGateway, input RepoGatewayConnectionInput) (RepoGatewayConnectionInfo, error) {
	resolve, started := s.beginGatewayResolve(existing.ID)
	if started {
		backgroundBudget := s.provisionBackgroundBudget
		if backgroundBudget <= 0 {
			backgroundBudget = repoGatewayProvisionBackgroundBudget
		}
		resolveCtx, cancelResolve := context.WithTimeout(context.WithoutCancel(ctx), backgroundBudget)
		go func() {
			defer cancelResolve()
			info, reuseErr := s.reuseGateway(resolveCtx, existing, input)
			if errors.Is(reuseErr, errRepoGatewayUnrecoverable) {
				// The row cannot serve: its token is unrecoverable, its VM is
				// gone or stale-fenced, or it failed to resume. Tear it down
				// and provision a fresh one — here, on the detached context,
				// so the replacement converges even though the caller has
				// already been answered 409.
				s.discardGatewayAfterReuse(resolveCtx, existing)
				info, reuseErr = s.provisionGateway(resolveCtx, input)
			}
			resolve.info, resolve.err = info, reuseErr
			// Drop the entry BEFORE publishing, so a caller arriving after this
			// point starts a fresh resolve rather than adopting a finished one.
			s.endGatewayResolve(existing.ID)
			close(resolve.done)
		}()
	}

	responseBudget := s.provisionResponseBudget
	if responseBudget <= 0 {
		responseBudget = repoGatewayProvisionResponseBudget
	}
	timer := time.NewTimer(responseBudget)
	defer timer.Stop()
	select {
	case <-resolve.done:
		return resolve.info, resolve.err
	case <-timer.C:
		return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("repo gateway is still resuming")
	case <-ctx.Done():
		// The caller went away. The resume keeps running on the detached
		// context — a client hang-up must never abandon a half-resumed VM.
		return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("repo gateway is still resuming")
	}
}

// beginGatewayResolve joins the in-flight resolve for a gateway row, or starts
// one. The second return reports whether this caller owns the work.
func (s *RepoGatewayService) beginGatewayResolve(gatewayID string) (*repoGatewayResolve, bool) {
	s.resolveMu.Lock()
	defer s.resolveMu.Unlock()
	if existing, ok := s.resolveInflight[gatewayID]; ok {
		return existing, false
	}
	if s.resolveInflight == nil {
		s.resolveInflight = make(map[string]*repoGatewayResolve)
	}
	resolve := &repoGatewayResolve{done: make(chan struct{})}
	s.resolveInflight[gatewayID] = resolve
	return resolve, true
}

func (s *RepoGatewayService) endGatewayResolve(gatewayID string) {
	s.resolveMu.Lock()
	defer s.resolveMu.Unlock()
	delete(s.resolveInflight, gatewayID)
}

// errRepoGatewayUnrecoverable marks an existing gateway row that cannot be
// reused — its operator token cannot be decrypted (codec/key rotation or row
// corruption), its sandbox provider VM no longer exists (404), the placement
// is stale-fenced at the worker (409 stale_generation — the worker will never
// drive that generation again), or the VM persistently fails to resume from
// its snapshot. In each case the caller discards the row and provisions fresh.
var errRepoGatewayUnrecoverable = errors.New("repo gateway unrecoverable")

// errRepoGatewayProbeIndeterminate marks a liveness probe that never reached
// the preview ingress at all — infrastructure said nothing about THIS gateway,
// so the row must be kept rather than discarded. Without the distinction a
// single ingress/netpol outage would tear down every gateway in the pool.
var errRepoGatewayProbeIndeterminate = errors.New("repo gateway liveness probe indeterminate")

// vmPlacementStale reports the sandbox provider's 409 stale_generation fencing
// answer: the worker holds (or holds no) state for a DIFFERENT placement
// generation, so the recorded one can never be inspected, resumed, or deleted
// through the controller again. Unlike a transport blip this is a definitive
// per-placement verdict, and unlike a 404 the inspect call does not map it to
// "gone" — without this classifier a stale-fenced gateway row answers
// status:"running" while every reuse 500s, the same wedge as a dead VM.
func vmPlacementStale(err error) bool {
	var statusErr *sandbox.StatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.StatusCode == http.StatusConflict &&
		(statusErr.Code == "stale_generation" || statusErr.ErrorCode == "stale_generation")
}

// repoGatewayResumeTimedOut reports an attempt-level timeout without treating
// cancellation of the caller's request as evidence that the VM is broken. The
// former leaves a gateway unusable and can be healed by reprovisioning; the
// latter must never trigger destructive cleanup after the client goes away.
func repoGatewayResumeTimedOut(parent context.Context, err error) bool {
	return errors.Is(err, context.DeadlineExceeded) && parent.Err() == nil
}

func (s *RepoGatewayService) reuseGateway(ctx context.Context, gateway db.RepoGateway, inputs ...RepoGatewayConnectionInput) (RepoGatewayConnectionInfo, error) {
	var input RepoGatewayConnectionInput
	if len(inputs) > 0 {
		input = inputs[0]
	}
	if gateway.WorkspaceID.Valid {
		return s.reuseWorkspaceGateway(ctx, gateway)
	}
	switch gateway.Status {
	case "starting":
		return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("repo gateway provisioning is still in progress")
	case "running", "suspended":
	default:
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("repo gateway has unexpected active status: " + gateway.Status)
	}

	token, err := s.secretCodec.DecryptString(gateway.AuthTokenCiphertext)
	if err != nil || strings.TrimSpace(token) == "" {
		slog.Warn("repo gateway token unrecoverable; reprovisioning",
			"gateway_id", gateway.ID, "vm_id", gateway.VmID, "decrypt_failed", err != nil)
		return RepoGatewayConnectionInfo{}, errRepoGatewayUnrecoverable
	}

	vm, err := s.sandbox.InspectSandbox(ctx, gateway.VmID)
	if err != nil {
		if vmAlreadyGone(err) || vmPlacementStale(err) {
			// The VM was reclaimed out-of-band (404) or its placement is
			// stale-fenced at the worker (409 stale_generation). Without this
			// the active row stays status='running' and every future gateway
			// resolve 500s forever; treat it as unrecoverable so the caller
			// discards + reprovisions.
			slog.Warn("repo gateway vm is gone; reprovisioning",
				"gateway_id", gateway.ID, "vm_id", gateway.VmID, "error", err)
			return RepoGatewayConnectionInfo{}, errRepoGatewayUnrecoverable
		}
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("get sandbox: " + err.Error())
	}

	// gatewayCtx starts as the request context and switches to a bounded context
	// detached from request cancellation after a resume succeeds. Once the
	// provider has powered the VM back on, this service owns finishing the
	// secret-bearing re-declaration (or tombstoning the row); letting a client
	// disconnect interrupt that transition can leave a running, non-serving VM
	// permanently recorded as reusable.
	gatewayCtx := ctx
	resumed := false

	// redeclareFailed records that the resumed VM never got its gateway process
	// back (see the re-declare below); it decides the fate of the row when no
	// liveness probe is configured to decide it downstream.
	redeclareFailed := false
	if vm.State != sandbox.StateRunning {
		if err := authorizeSandboxStartForUser(ctx, s.billing, gateway.UserID); err != nil {
			return RepoGatewayConnectionInfo{}, err
		}
		// Do NOT wait for the ready signal on resume — same one-shot
		// RemainAfterExit trap as workspace VMs: it never re-fires, so waiting
		// blocks until the 2-minute deadline. A resumed VM is "ready" the moment
		// the sandbox provider reports it running — which is NOT the same as
		// serving: this line used to read "the gateway systemd unit restarts on
		// resume on its own", and that assumption is exactly what wedged wave 11.
		// The re-declare below is what actually brings the process back.
		waitForReady := false
		resumeRequest := sandbox.StartRequest{
			IdleTimeoutSeconds: &s.idleTimeoutSeconds,
			WaitForReady:       &waitForReady,
		}
		resume := func() error {
			resumeCtx, cancel := context.WithTimeout(ctx, repoGatewayResumeTimeout)
			defer cancel()
			_, err := s.sandbox.StartSandbox(resumeCtx, gateway.VmID, resumeRequest)
			return err
		}
		err := resume()
		// A full pool is transient and leaves the guest suspended and intact
		// (the controller refuses the reservation before any worker RPC), so
		// never retry it — the pool does not drain in a millisecond — and never
		// let it reach the unrecoverable arms below, which discard the VM along
		// with its persistent workspace and every run parked on it.
		if !isNoCapacityError(err) && !vmAlreadyGone(err) && isHardResumeFailure(err) {
			// Match workspace recovery: one immediate retry absorbs a transient
			// provider 5xx. A second hard failure (notably "Failed to spawn
			// UFFD handler") means this persistent snapshot cannot resume and
			// must be replaced or every future gateway resolve will 500 forever.
			slog.Warn("repo gateway vm resume failed; retrying once",
				"gateway_id", gateway.ID, "vm_id", gateway.VmID, "error", err)
			err = resume()
		}
		if err != nil {
			if isNoCapacityError(err) {
				slog.Warn("repo gateway vm resume refused: the pool is full",
					"gateway_id", gateway.ID, "vm_id", gateway.VmID)
				return RepoGatewayConnectionInfo{}, pkgerrors.NoCapacity(workspaceNoCapacityMessage)
			}
			if vmAlreadyGone(err) || vmPlacementStale(err) {
				slog.Warn("repo gateway vm is gone on resume; reprovisioning",
					"gateway_id", gateway.ID, "vm_id", gateway.VmID)
				return RepoGatewayConnectionInfo{}, errRepoGatewayUnrecoverable
			}
			if repoGatewayResumeTimedOut(ctx, err) {
				// A bounded StartSandbox call that never answered is equivalent
				// to the workspace resume timeout: keeping this row makes every
				// future resolve wait two minutes and return 500. The outer
				// connection path has full provisioning input, so replace it
				// immediately.
				slog.Warn("repo gateway vm resume timed out; reprovisioning",
					"gateway_id", gateway.ID, "vm_id", gateway.VmID)
				return RepoGatewayConnectionInfo{}, errRepoGatewayUnrecoverable
			}
			if isHardResumeFailure(err) {
				slog.Warn("repo gateway vm cannot resume; reprovisioning",
					"gateway_id", gateway.ID, "vm_id", gateway.VmID, "error", err)
				return RepoGatewayConnectionInfo{}, errRepoGatewayUnrecoverable
			}
			return RepoGatewayConnectionInfo{}, pkgerrors.Internal("resume microsandbox gateway vm: " + err.Error())
		}
		slog.Info("sandbox resumed", "vm_id", gateway.VmID, "type", "gateway")
		resumed = true
		resumedCtx, cancelGatewayCtx := context.WithTimeout(context.WithoutCancel(ctx), repoGatewayResumeTimeout)
		defer cancelGatewayCtx()
		gatewayCtx = resumedCtx

		// Resume replay omits secret-bearing services; re-declare the immutable
		// product host with the same repository identity and operator credential.
		// The re-declare gets exactly ONE chance per VM lifetime: this whole
		// block is gated on the VM not running, so once the resume succeeds no
		// later resolve re-enters it and nothing else ever starts the process.
		// A single transport blip would therefore cost the entire gateway — the
		// liveness probe finds nothing listening, and the caller discards the VM
		// with its persistent workspace and every parked run on it, which is the
		// exact harm this path exists to stop. Retry once, the same way the
		// resume above absorbs a transient provider failure, then fall through.
		if err := s.startGatewayService(gatewayCtx, gateway.VmID, s.productGatewayEnv(token, gateway.ID, input)); err != nil {
			slog.Warn("repo gateway service re-declare on resume failed; retrying once",
				"gateway_id", gateway.ID, "vm_id", gateway.VmID, "error", err)
			if err := s.startGatewayService(gatewayCtx, gateway.VmID, s.productGatewayEnv(token, gateway.ID, input)); err != nil {
				slog.Warn("repo gateway service re-declare on resume failed; liveness probe decides",
					"gateway_id", gateway.ID, "vm_id", gateway.VmID, "error", err)
				redeclareFailed = true
			}
		}
		if redeclareFailed && s.healthProbeBaseURL == "" {
			// "The liveness probe decides" is only true where a probe exists.
			// With it disabled, falling through answers status:"running" for a
			// VM that is powered on with NOTHING listening — the wave-11 lie,
			// and a permanent one: the resume block above is gated on the VM
			// not running, so no later resolve re-enters it and nothing else
			// ever starts the process. The re-declare already had its retry and
			// the caller is still here, so this is a definitive failed resume:
			// tombstone the defect row and reprovision instead of handing back
			// a gateway whose relay calls can only 502. The bounded post-resume
			// context remains responsible for this decision even if the caller
			// disconnected while the provider was re-declaring the service.
			slog.Warn("repo gateway service could not be re-declared on resume and no liveness probe is configured; reprovisioning",
				"gateway_id", gateway.ID, "vm_id", gateway.VmID)
			return RepoGatewayConnectionInfo{}, errRepoGatewayUnrecoverable
		}
	}

	// Old 0.33 gateways cannot speak the product's 1.0 protocol. Replace only
	// an explicitly incompatible guest; transport errors preserve its state.
	compatible, hostErr := s.gatewayHasProductHost(gatewayCtx, gateway.VmID)
	if hostErr != nil {
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("check product gateway host: " + hostErr.Error())
	}
	if !compatible {
		slog.Warn("repo gateway predates the product host; reprovisioning", "gateway_id", gateway.ID, "vm_id", gateway.VmID)
		return RepoGatewayConnectionInfo{}, errRepoGatewayUnrecoverable
	}

	// Liveness: the sandbox provider reporting the VM running is NOT evidence
	// the gateway process is serving — a VM can boot while its systemd unit
	// crash-loops, and the row then answers status:"running" while every relay
	// call 502s forever (the wave-11 wedge). Probe /health through the preview
	// ingress (the relay's own upstream path), bounded; a VM that never
	// answers is wedged and takes the discard + reprovision path.
	if err := s.probeGatewayHealth(gatewayCtx, gateway.VmID); err != nil {
		if !resumed && ctx.Err() != nil {
			// The caller went away — never destructive on client cancellation.
			return RepoGatewayConnectionInfo{}, pkgerrors.Internal("probe gateway health: " + err.Error())
		}
		if errors.Is(err, errRepoGatewayProbeIndeterminate) {
			// The preview ingress itself was never reached, so the probe
			// learned NOTHING about this gateway. Discarding here would turn
			// one ingress outage into a fleet-wide teardown: every reuse in
			// the pool would fail the same way and delete a healthy VM (and
			// its persistent workspace) on the way. Fail the request instead;
			// the gateway is still there when the ingress comes back.
			slog.Warn("repo gateway liveness probe indeterminate; keeping gateway",
				"gateway_id", gateway.ID, "vm_id", gateway.VmID, "error", err)
			return RepoGatewayConnectionInfo{}, pkgerrors.Internal("probe gateway health: " + err.Error())
		}
		slog.Warn("repo gateway failed liveness probe; reprovisioning",
			"gateway_id", gateway.ID, "vm_id", gateway.VmID, "error", err)
		return RepoGatewayConnectionInfo{}, errRepoGatewayUnrecoverable
	}

	if gateway.Status == "suspended" {
		if updated, updateErr := s.q.UpdateRepoGatewayStatus(gatewayCtx, db.UpdateRepoGatewayStatusParams{
			ID:     gateway.ID,
			Status: "running",
		}); updateErr == nil {
			// The gauge counts rows in status 'running'. Add +1 only on a
			// committed suspended->running transition, since 'suspended' is the
			// only prior state that carried a matching -1. A row still marked
			// 'running' whose VM sandbox provider idle-suspended out from under us was
			// never decremented (the control plane can't observe that), so
			// resuming it must NOT increment — or the gauge drifts up every
			// idle/resume cycle. (Today nothing writes 'suspended', so this never
			// fires, which is correct: nothing decrements for an idle suspend.)
			if gateway.Status == "suspended" && s.sandboxMetrics != nil {
				s.sandboxMetrics.AddSandboxActiveVMs("gateway", 1)
			}
			gateway = updated
		}
	}
	s.meterGatewayUsage(gatewayCtx, gateway)
	_ = s.q.TouchRepoGatewayActivity(gatewayCtx, gateway.ID)

	return RepoGatewayConnectionInfo{
		BaseURL:   gateway.BaseUrl,
		Token:     token,
		ExpiresAt: time.Now().UTC().Add(repoGatewayTokenAdvertisedTTL),
		GatewayID: gateway.ID,
		VMID:      gateway.VmID,
		Status:    "running",
	}, nil
}

// discardGatewayAfterReuse performs the destructive half of a failed resume
// with a bounded context that survives the request ending. A successful
// StartSandbox must never be allowed to leave its row active when the caller
// disconnects before service re-declaration finishes.
func (s *RepoGatewayService) discardGatewayAfterReuse(ctx context.Context, gateway db.RepoGateway) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoGatewayCleanupTimeout)
	defer cancel()
	s.discardGateway(cleanupCtx, gateway)
}

// probeGatewayHealth GETs the gateway's /health through the preview ingress —
// the exact upstream path the relay proxies to — so a positive answer means
// relay calls will reach a live gateway process, not merely a booted VM. A
// freshly resumed VM needs seconds for systemd to bind the port, so the probe
// retries on ANY failure (refused, 502, timeout) up to the bounded attempt
// count. Disabled when healthProbeBaseURL is empty (local dev).
//
// A failure is only EVIDENCE about the gateway when the preview ingress itself
// answered: it is the component that knows whether the VM's port accepts. If
// the ingress was never reached at all (its Service is down, DNS fails, the
// netpol drops the packet), the verdict is indeterminate and the error wraps
// errRepoGatewayProbeIndeterminate — see the caller.
func (s *RepoGatewayService) probeGatewayHealth(ctx context.Context, vmID string) error {
	return s.probeGatewayHealthChecked(ctx, vmID, nil)
}

func (s *RepoGatewayService) probeGatewayHealthChecked(ctx context.Context, vmID string, validate func(io.Reader) error) error {
	if s.healthProbeBaseURL == "" {
		return nil
	}
	probeURL := s.healthProbeBaseURL + "/__preview/" + repoGatewayDomain(vmID) + "/health"
	var lastErr error
	ingressAnswered := false
	for attempt := 0; attempt < repoGatewayHealthProbeAttempts; attempt++ {
		if attempt > 0 {
			if sleepErr := s.sleep(ctx, repoGatewayHealthProbeInterval); sleepErr != nil {
				return sleepErr
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURL, nil)
		if err != nil {
			return err
		}
		s.setPreviewRelayToken(req)
		resp, err := s.healthProbeClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		ingressAnswered = true
		if resp.StatusCode == http.StatusOK && validate != nil {
			validationErr := validate(io.LimitReader(resp.Body, 8192))
			_ = resp.Body.Close()
			// A responding incompatible host is not a startup delay. Keep the
			// workspace and report the missing capability without 15 retries.
			return validationErr
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return nil
		}
		lastErr = fmt.Errorf("gateway health probe answered %d", resp.StatusCode)
	}
	if !ingressAnswered {
		if lastErr == nil {
			lastErr = errors.New("gateway health probe exhausted attempts")
		}
		return fmt.Errorf("%w: %v", errRepoGatewayProbeIndeterminate, lastErr)
	}
	if lastErr == nil {
		lastErr = errors.New("gateway health probe exhausted attempts")
	}
	return lastErr
}

// discardGateway tombstones a gateway row and deletes its VM (best effort).
func (s *RepoGatewayService) discardGateway(ctx context.Context, gateway db.RepoGateway) {
	defer meterSandboxUsage(ctx, s.q, gateway.UserID, "gateway", gateway.ID, false)
	// Announce for both ownership modes, even when guest cleanup fails.
	defer revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
		Kind: revocation.KindGatewayRevoked, GatewayID: gateway.ID,
		UserID: gateway.UserID, RepositoryID: gateway.RepositoryID,
		Reason: "repository gateway torn down",
	})
	if gateway.WorkspaceID.Valid {
		// Fence detached resolves before stopping the process. Reversing this
		// order lets a stale resolve reinstall a service after cleanup finishes.
		if _, err := s.q.SoftDeleteRepoGateway(ctx, gateway.ID); err != nil {
			slog.Warn("failed to tombstone workspace gateway", "gateway_id", gateway.ID, "error", err)
		}
		s.stopWorkspaceGateway(ctx, gateway)
		return
	} else if strings.TrimSpace(gateway.VmID) != "" {
		if err := s.sandbox.RevokeIngress(ctx, repoGatewayDomain(gateway.VmID)); err != nil {
			slog.Warn("failed to unmap gateway ingress domain", "vm_id", gateway.VmID, "error", err)
		}
		if err := s.sandbox.DeleteSandbox(ctx, gateway.VmID); err != nil {
			slog.Warn("failed to delete unrecoverable gateway vm", "vm_id", gateway.VmID, "error", err)
		}
	}
	// Return the +1 this row received when it reached 'running' exactly once,
	// even when DeleteSandbox 404s because sandbox provider already reclaimed the VM (the +1
	// still has to be given back). 'starting'/'pending' rows never got a +1, so
	// discarding a race-loser must not drive the gauge negative.
	if !gateway.WorkspaceID.Valid && gateway.Status == "running" && s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("gateway", -1)
	}
	if _, err := s.q.SoftDeleteRepoGateway(ctx, gateway.ID); err != nil {
		slog.Warn("failed to tombstone unrecoverable gateway row", "gateway_id", gateway.ID, "error", err)
	}
}

func (s *RepoGatewayService) provisionGateway(ctx context.Context, input RepoGatewayConnectionInput) (RepoGatewayConnectionInfo, error) {
	if input.WorkspaceID != "" {
		return s.provisionWorkspaceGateway(ctx, input)
	}
	if strings.TrimSpace(input.RepoOwner) == "" || strings.TrimSpace(input.RepoName) == "" {
		return RepoGatewayConnectionInfo{}, pkgerrors.BadRequest("repository identity is required for the product gateway")
	}
	if err := s.enforceProvisionConcurrency(ctx, input.UserID); err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	// Insert as 'pending' (outside the active-unique index) so a crashed
	// provision before the VM exists does not shadow the slot; the row becomes
	// visible/active only once we early-persist status='starting' with a vm_id.
	// The pending row doubles as a durable concurrency reservation: it is
	// created BEFORE the cap check and CountActiveSandboxesForUser counts it,
	// so two racing provisions each see the other's reservation instead of
	// both passing a stale pre-insert count and blowing past the cap.
	gateway, err := s.q.CreateRepoGateway(ctx, db.CreateRepoGatewayParams{
		RepositoryID: input.RepositoryID,
		UserID:       input.UserID,
		Status:       "pending",
	})
	if err != nil {
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("create repo gateway: " + err.Error())
	}

	// Per-user concurrency cap — enforced ONLY here on the provision path, never
	// on reuse/resume (which consumes no new capacity). This lives in the service
	// rather than as route middleware so a caller AT the cap can still resume an
	// existing gateway; a fresh provision over the cap is refused with 429.
	if err := s.enforceReservedProvisionConcurrency(ctx, input.UserID); err != nil {
		// Release the reservation: 'failed' rows stop counting immediately.
		s.markGatewayFailed(ctx, gateway.ID)
		return RepoGatewayConnectionInfo{}, err
	}

	token, tokenHash, _ := generateRepoGatewayToken()
	ciphertext, err := s.secretCodec.EncryptString(token)
	if err != nil {
		s.markGatewayFailed(ctx, gateway.ID)
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("encrypt gateway token: " + err.Error())
	}

	env := s.productGatewayEnv(token, gateway.ID, input)

	vm, err := s.createGatewayVM(ctx, gateway.ID)
	if err != nil {
		s.markGatewayFailed(ctx, gateway.ID)
		return RepoGatewayConnectionInfo{}, err
	}

	// The ingress hostname is deterministic in the VM id, so base_url is known
	// the moment the VM exists — before the (slow) domain mapping + runtime
	// install steps.
	domain := repoGatewayDomain(vm.ID)
	baseURL := "https://" + domain

	// EARLY-PERSIST: link the VM (+ base_url + token) to the row as 'starting'
	// IMMEDIATELY, before any of the multi-minute setup steps. A crash after
	// this point leaves a DB-linked, reaper-collectable row instead of an
	// orphaned sandbox and Plue preview mapping with no DB trace. Because
	// GetActiveRepoGatewayForUserRepo treats status='starting' AND vm_id<>'' as
	// active, this is also where the provisioning race is resolved (the unique
	// index rejects the second writer) — moved earlier so the loser bails out
	// BEFORE the expensive install steps rather than after.
	if _, err := s.q.UpdateRepoGatewayExecutionInfo(ctx, db.UpdateRepoGatewayExecutionInfoParams{
		ID:                  gateway.ID,
		VmID:                vm.ID,
		BaseUrl:             baseURL,
		AuthTokenHash:       tokenHash,
		AuthTokenCiphertext: ciphertext,
		Status:              "starting",
	}); err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		// No domain mapping exists yet — only the VM needs tearing down.
		if deleteErr := s.sandbox.DeleteSandbox(cleanupCtx, vm.ID); deleteErr != nil {
			slog.Warn("failed to delete gateway vm after early-persist failure", "vm_id", vm.ID, "error", deleteErr)
		}
		s.markGatewayFailed(cleanupCtx, gateway.ID)
		if isRepoGatewayActiveUniqueViolation(err) {
			// A concurrent request already holds the active slot; reuse it.
			winner, winnerErr := s.q.GetActiveRepoGatewayForUserRepo(ctx, db.GetActiveRepoGatewayForUserRepoParams{
				RepositoryID: input.RepositoryID,
				UserID:       input.UserID,
			})
			if winnerErr != nil {
				return RepoGatewayConnectionInfo{}, pkgerrors.Internal("load winning repo gateway: " + winnerErr.Error())
			}
			info, reuseErr := s.reuseGateway(ctx, winner, input)
			if reuseErr == nil {
				return info, nil
			}
			if !errors.Is(reuseErr, errRepoGatewayUnrecoverable) {
				return RepoGatewayConnectionInfo{}, reuseErr
			}
			// The row that won the slot is itself a defect row — its VM cannot
			// resume, is gone, or its token is unrecoverable. The resolve path
			// discards such a row before reprovisioning; this path used to
			// return the bare internal sentinel instead, which leaks as an
			// opaque 500 AND leaves the dead row occupying the active slot, so
			// the next resolve hands out the same dead VM forever (the wave-11
			// wedge, reached whenever the discard that preceded this provision
			// failed to tombstone). Clean it up here too and answer 409 so the
			// caller retries into a clean provision — reprovisioning inline
			// would recurse through this same race with a second reservation.
			s.discardGatewayAfterReuse(ctx, winner)
			return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("repo gateway is being replaced; retry")
		}
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("persist repo gateway vm info: " + err.Error())
	}

	// The remaining steps (ingress mapping, runtime install, workspace clone,
	// host install, service start) are a MULTI-MINUTE job. They
	// used to run on the request context, which produced two defects at once:
	//
	//  1. No client waits that long. Production measured a Cloudflare-fronted
	//     POST answered 504 after 1m9.763s, and a direct one taking 1m15.662s
	//     to return 200, so the product's "Preparing your <repo> workspace…"
	//     stood past 120s with no run card, no timeout and no error.
	//  2. Worse, the client giving up CANCELLED the provision mid-flight
	//     ("probe gateway health: context canceled" in production) and the
	//     cleanup below tore the half-built VM down, so every retry restarted
	//     from zero and the gateway could never converge.
	//
	// Run the work on a context detached from request cancellation and answer
	// 409 "still provisioning" once the response budget elapses. The row is
	// already durable, holds the active slot and is reaper-collectable, so the
	// caller polls into reuseGateway (409 while 'starting', 200 once 'running')
	// instead of holding a connection open — the documented client taxonomy.
	backgroundBudget := s.provisionBackgroundBudget
	if backgroundBudget <= 0 {
		backgroundBudget = repoGatewayProvisionBackgroundBudget
	}
	provisionCtx, cancelProvision := context.WithTimeout(context.WithoutCancel(ctx), backgroundBudget)

	type provisionResult struct {
		info RepoGatewayConnectionInfo
		err  error
	}
	done := make(chan provisionResult, 1)
	go func() {
		defer cancelProvision()
		info, finishErr := s.finishGatewayProvision(provisionCtx, gateway.ID, vm, domain, baseURL, token, env, input)
		done <- provisionResult{info: info, err: finishErr}
	}()

	responseBudget := s.provisionResponseBudget
	if responseBudget <= 0 {
		responseBudget = repoGatewayProvisionResponseBudget
	}
	timer := time.NewTimer(responseBudget)
	defer timer.Stop()

	select {
	case result := <-done:
		return result.info, result.err
	case <-timer.C:
		slog.Info("repo gateway provisioning continues in the background",
			"gateway_id", gateway.ID, "vm_id", vm.ID)
		return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("repo gateway provisioning is still in progress")
	case <-ctx.Done():
		// The caller went away. The detached provision keeps running: this is
		// exactly the cancellation that used to destroy in-flight gateways.
		slog.Info("repo gateway caller disconnected; provisioning continues",
			"gateway_id", gateway.ID, "vm_id", vm.ID)
		return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("repo gateway provisioning is still in progress")
	}
}

// finishGatewayProvision runs the slow half of a fresh provision. Its ctx is
// detached from the originating request, so a client hang-up can never trigger
// the teardown path below.
func (s *RepoGatewayService) finishGatewayProvision(
	ctx context.Context,
	gatewayID string,
	vm sandbox.CreateResult,
	domain string,
	baseURL string,
	token string,
	env map[string]string,
	input RepoGatewayConnectionInput,
) (RepoGatewayConnectionInfo, error) {
	fail := func(cause error) (RepoGatewayConnectionInfo, error) {
		// The originating HTTP request may already have received 409 while
		// provisioning continues. Preserve its failure before cleanup deletes
		// the guest; nobody may still be listening on the result channel.
		slog.Error("repo gateway provisioning failed", "gateway_id", gatewayID,
			"vm_id", vm.ID, "error", RedactSecretValues(env, cause.Error()))
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoGatewayCleanupTimeout)
		defer cancel()
		// Best effort: the ingress mapping may or may not exist yet.
		if unmapErr := s.sandbox.RevokeIngress(cleanupCtx, repoGatewayDomain(vm.ID)); unmapErr != nil {
			slog.Debug("gateway ingress unmap during cleanup", "vm_id", vm.ID, "error", unmapErr)
		}
		if deleteErr := s.sandbox.DeleteSandbox(cleanupCtx, vm.ID); deleteErr != nil {
			slog.Warn("failed to delete gateway vm during cleanup", "vm_id", vm.ID, "error", deleteErr)
		}
		// markGatewayFailed flips status to 'failed', releasing the active slot
		// and making the row reaper-collectable (its vm_id is already deleted).
		s.markGatewayFailed(cleanupCtx, gatewayID)
		return RepoGatewayConnectionInfo{}, cause
	}

	// Publish the deterministic Plue preview hostname after the sandbox starts.
	if _, err := s.sandbox.PublishIngress(ctx, domain, sandbox.PublishIngressRequest{
		SandboxID: vm.ID,
		Port:      repoGatewayPort,
	}); err != nil {
		return fail(pkgerrors.Internal("map gateway ingress domain: " + err.Error()))
	}

	if err := s.installGatewayRuntime(ctx, vm.ID); err != nil {
		return fail(err)
	}

	if err := s.prepareGatewayWorkspace(ctx, vm.ID, input); err != nil {
		return fail(err)
	}

	if err := s.installProductGatewayHost(ctx, vm.ID); err != nil {
		return fail(err)
	}

	if err := s.startGatewayService(ctx, vm.ID, env); err != nil {
		return fail(err)
	}
	// A provider service declaration is not readiness. Do not return a usable
	// gateway until the same ingress the product will call answers health.
	if err := s.probeGatewayHealth(ctx, vm.ID); err != nil {
		return fail(pkgerrors.Internal("new product gateway failed health check: " + err.Error()))
	}

	// Flip 'starting' -> 'running'. The row already occupies the active-unique
	// slot, so this is a plain status update (no race to resolve here anymore).
	updated, err := s.q.UpdateRepoGatewayStatus(ctx, db.UpdateRepoGatewayStatusParams{
		ID:     gatewayID,
		Status: "running",
	})
	if err != nil {
		return fail(pkgerrors.Internal("mark repo gateway running: " + err.Error()))
	}

	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("gateway", 1)
	}
	s.meterGatewayUsage(ctx, updated)
	_ = s.q.TouchRepoGatewayActivity(ctx, updated.ID)
	slog.Info("sandbox created", "vm_id", vm.ID, "type", "gateway", "base_url", baseURL)

	return RepoGatewayConnectionInfo{
		BaseURL:   baseURL,
		Token:     token,
		ExpiresAt: time.Now().UTC().Add(repoGatewayTokenAdvertisedTTL),
		GatewayID: updated.ID,
		VMID:      vm.ID,
		Status:    "running",
	}, nil
}

func (s *RepoGatewayService) createGatewayVM(ctx context.Context, gatewayIDs ...string) (sandbox.CreateResult, error) {
	gatewayID := ""
	if len(gatewayIDs) > 0 {
		gatewayID = strings.TrimSpace(gatewayIDs[0])
	}
	// The runtime step creates /workspace before any service uses it. Public
	// ingress is published separately after the sandbox is ready.
	waitForReady := true
	memSizeMB := int32(repoGatewayMemSizeMB)
	files := make(map[string]sandbox.SandboxFile)
	if err := s.addProductGatewayHost(files); err != nil {
		return sandbox.CreateResult{}, err
	}
	req := sandbox.CreateRequest{
		Files: files,
		// The golden workspace snapshot (when baked) carries the full
		// toolchain — bun, jj, node, git — so the runtime-install exec step
		// becomes a fast verify instead of cold downloads.
		SnapshotID:         s.goldenSnapshots.Current(ctx),
		Packages:           []string{"git", "curl", "ca-certificates", "unzip", "python3"},
		IdleTimeoutSeconds: &s.idleTimeoutSeconds,
		MemSizeMB:          &memSizeMB,
		Persistence: &sandbox.PersistencePolicy{
			Type:     s.persistence,
			Priority: &s.persistencePrio,
		},
		WaitForReady: &waitForReady,
	}

	startedAt := time.Now()
	attempt := "bare"
	if strings.TrimSpace(req.SnapshotID) != "" {
		attempt = "golden-" + req.SnapshotID
	}
	createCtx := sandboxProvisionContext(ctx, "create", "repo_gateway", gatewayID, attempt)
	vm, err := s.sandbox.CreateSandbox(createCtx, req)
	// Golden snapshots are an accelerator, not a dependency: if the snapshot
	// boot fails, retry once from the bare image with the same boot contract.
	if err != nil && strings.TrimSpace(req.SnapshotID) != "" {
		badSnapshot := req.SnapshotID
		snapshotErr := err
		slog.Warn("golden snapshot gateway vm create failed; retrying from bare image", "snapshot_id", badSnapshot, "error", err)
		// Defense in depth: the sandbox client reaps a partially created VM
		// itself before returning an error, but the interface cannot enforce
		// that contract — if an ID survived the failure, reap it before
		// retrying so the snapshot attempt never leaks a VM.
		if orphan := strings.TrimSpace(vm.ID); orphan != "" {
			delCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			if delErr := s.sandbox.DeleteSandbox(delCtx, orphan); delErr != nil {
				slog.Warn("failed to delete orphaned gateway vm after snapshot create failure", "vm_id", orphan, "error", delErr)
			}
			cancel()
		}
		req.SnapshotID = ""
		bareCtx := sandboxProvisionContext(ctx, "create", "repo_gateway", gatewayID, "bare")
		vm, err = s.sandbox.CreateSandbox(bareCtx, req)
		if err == nil && goldenSnapshotCreateErrorIsSnapshotSpecific(snapshotErr, badSnapshot) {
			s.goldenSnapshots.MarkBad(ctx, badSnapshot)
		}
	}
	duration := time.Since(startedAt)
	if s.sandboxMetrics != nil {
		status := "success"
		if err != nil {
			status = "error"
		}
		s.sandboxMetrics.ObserveSandboxVMCreate("gateway", status, duration.Seconds())
	}
	if err != nil {
		slog.Error("sandbox creation failed", "error", err, "type", "gateway")
		return sandbox.CreateResult{}, pkgerrors.Internal("create microsandbox gateway vm: " + err.Error())
	}
	return vm, nil
}

// prepareGatewayWorkspace creates the workspace dir and clones the repo into
// it. Empty (zero-commit) repos clone cleanly, so brand-new sandbox repos work;
// a non-zero clone exit is a hard failure so a repo WITH workflows is never
// silently served as an empty gateway.
func (s *RepoGatewayService) prepareGatewayWorkspace(ctx context.Context, vmID string, input RepoGatewayConnectionInput) error {
	owner := strings.TrimSpace(input.RepoOwner)
	name := strings.TrimSpace(input.RepoName)
	if owner == "" || name == "" {
		// No repo identity: start the gateway on an empty workspace dir. The
		// gateway registers a synthetic "workspace" workflow and serves
		// /health honestly.
		return s.execGatewayCommand(ctx, vmID, strings.Join([]string{
			"set -euo pipefail",
			"install -d " + shellQuote(repoGatewayWorkspace),
		}, "\n"), "prepare gateway workspace", repoGatewayCloneTimeout)
	}

	cloneToken, err := issueTemporaryRepoCloneToken(ctx, s.q, input.UserID, "sandbox-gateway-clone")
	if err != nil {
		return pkgerrors.Internal("create repo clone token: " + err.Error())
	}
	defer revokeTemporaryRepoCloneToken(ctx, s.q, input.UserID, cloneToken.ID)

	cloneURL, err := buildRepoCloneURL(s.gitBaseURL, owner, name)
	if err != nil {
		return pkgerrors.Internal("build repo clone url: " + err.Error())
	}

	// The bearer credential rides GIT_CONFIG_* env vars (invisible in
	// /proc/<pid>/cmdline), never an `-c http.extraHeader=…` argv flag.
	commandLines := []string{"set -euo pipefail"}
	commandLines = append(commandLines, gitBearerAuthEnvExports(cloneToken.Plaintext)...)
	commandLines = append(commandLines,
		"rm -rf "+shellQuote(repoGatewayWorkspace),
		"install -d /workspace",
		"git clone -- "+shellQuote(cloneURL.String())+" "+shellQuote(repoGatewayWorkspace),
	)
	// Some repository transports still advertise an unborn `master` as remote
	// HEAD even when the repository's actual default bookmark is `main`. Git
	// fetches every ref but leaves the clone on an empty unborn branch, so the
	// gateway sees none of the repository's .smithers workflows. Check out the
	// authoritative default bookmark only when that remote ref exists; a true
	// zero-commit repository remains a valid empty workspace.
	if bookmark := strings.TrimSpace(input.RepoDefaultBookmark); bookmark != "" {
		remoteRef := "origin/" + bookmark
		commandLines = append(commandLines,
			"if ! git -C "+shellQuote(repoGatewayWorkspace)+" rev-parse --verify HEAD >/dev/null 2>&1 && "+
				"git -C "+shellQuote(repoGatewayWorkspace)+" show-ref --verify --quiet "+
				shellQuote("refs/remotes/"+remoteRef)+"; then",
			"  git -C "+shellQuote(repoGatewayWorkspace)+" checkout -b "+shellQuote(bookmark)+
				" --track "+shellQuote(remoteRef),
			"fi",
		)
	}
	command := strings.Join(commandLines, "\n")

	return s.execGatewayCommand(ctx, vmID, command, "clone gateway repository", repoGatewayCloneTimeout)
}

// installGatewayRuntime installs bun and jj at /usr/local/bin. They cannot ride
// Packages (neither exists as an apt package — that config failed every gateway
// VM at post-boot), so they install here right after VM creation, before any
// step that shells out to them.
func (s *RepoGatewayService) installGatewayRuntime(ctx context.Context, vmID string) error {
	return s.execGatewayCommand(ctx, vmID, repoGatewayRuntimeInstallScript, "install gateway runtime", repoGatewayRuntimeInstallTimeout)
}

func (s *RepoGatewayService) execGatewayCommand(ctx context.Context, vmID, command, label string, timeout time.Duration) error {
	timeoutMS := int64(timeout / time.Millisecond)
	resp, err := s.sandbox.Execute(ctx, vmID, sandbox.ExecRequest{
		Command:   command,
		TimeoutMS: &timeoutMS,
	})
	if err != nil {
		return pkgerrors.Internal(label + ": " + err.Error())
	}
	if resp.StatusCode != nil && *resp.StatusCode != 0 {
		detail := strings.TrimSpace(resp.Stderr)
		if out := strings.TrimSpace(resp.Stdout); out != "" {
			if detail != "" {
				detail += "\n"
			}
			detail += out
		}
		if len(detail) > 1000 {
			detail = detail[len(detail)-1000:]
		}
		if detail == "" {
			return pkgerrors.Internal(fmt.Sprintf("%s failed with status %d", label, *resp.StatusCode))
		}
		return pkgerrors.Internal(fmt.Sprintf("%s failed with status %d: %s", label, *resp.StatusCode, detail))
	}
	return nil
}

func (s *RepoGatewayService) buildGatewayEnv(token string) map[string]string {
	env := map[string]string{
		"HOME":             "/root",
		"PATH":             "/usr/local/bin:/root/.bun/bin:/usr/bin:/bin",
		"SMITHERS_API_KEY": token,
		// Same tmpfs guard as the init step: workflow runs shell out to bun,
		// whose temp/cache must stay on the disk-backed /workspace.
		"TMPDIR":         "/workspace/.tmp",
		"XDG_CACHE_HOME": "/workspace/.cache",
	}
	for name, value := range s.agentProviderEnv {
		if strings.TrimSpace(name) == "" || value == "" {
			continue
		}
		env[name] = value
	}
	if s.agentSeatAPIKey != "" {
		// The AI-provider seat. Per-VM systemd env only: never baked into an
		// image, and the relay RPC surface has no exec/env read, so it never
		// leaves the VM or enters the immutable host artifact.
		env["CEREBRAS_API_KEY"] = s.agentSeatAPIKey
	}
	return env
}

func (s *RepoGatewayService) startGatewayService(ctx context.Context, vmID string, env map[string]string) error {
	spec := sandbox.ServiceSpec{
		Name: repoGatewayServiceName,
		Mode: sandbox.ServiceModeService,
		Exec: []string{fmt.Sprintf(
			"/usr/local/bin/bun %s serve --root %s --host 0.0.0.0 --port %d --listen",
			repoGatewayProductHostPath, repoGatewayWorkspace, repoGatewayPort,
		)},
		Env: env,
		RestartPolicy: &sandbox.RestartPolicy{
			Kind: sandbox.RestartPolicyOnFailure,
		},
		Workdir: repoGatewayWorkspace,
	}

	resp, err := s.sandbox.CreateService(ctx, vmID, spec)
	if err != nil {
		if sandboxSystemdInternalError(err) {
			slog.Warn("microsandbox systemd service returned internal error; continuing because the service may have been created",
				"vm_id", vmID, "type", "gateway", "error", err)
			return nil
		}
		return pkgerrors.Internal("create microsandbox systemd service: " + err.Error())
	}
	if !resp.Success {
		message := strings.TrimSpace(resp.Message)
		if message == "" {
			message = "unknown error"
		}
		return pkgerrors.Internal("create microsandbox systemd service: " + message)
	}
	return nil
}

func (s *RepoGatewayService) markGatewayFailed(ctx context.Context, gatewayID string) {
	defer meterSandboxUsage(ctx, s.q, 0, "gateway", gatewayID, false)
	if _, err := s.q.UpdateRepoGatewayStatus(ctx, db.UpdateRepoGatewayStatusParams{
		ID:     gatewayID,
		Status: "failed",
	}); err != nil {
		slog.Warn("failed to mark repo gateway failed", "gateway_id", gatewayID, "error", err)
	}
}

// enforceProvisionConcurrency checks the plan before inserting the pending row:
// the caller's own reservation must not consume the slot it is authorizing.
func (s *RepoGatewayService) enforceProvisionConcurrency(ctx context.Context, userID int64) error {
	return authorizeSandboxStartForUser(ctx, s.billing, userID)
}

// The hard cap runs after insertion and includes this provision's reservation.
// It retains its existing fail-open behavior; plan checks always fail closed.
func (s *RepoGatewayService) enforceReservedProvisionConcurrency(ctx context.Context, userID int64) error {
	if s.concurrencyCounter == nil || s.concurrencyMax <= 0 {
		return nil
	}
	current, err := s.concurrencyCounter.CountActiveSandboxesForUser(ctx, userID)
	if err != nil {
		slog.Warn("gateway concurrency count failed; allowing provision", "user_id", userID, "error", err)
		return nil
	}
	if current > s.concurrencyMax {
		return pkgerrors.QuotaExceeded("concurrent sandboxes limit reached")
	}
	return nil
}

// repoGatewayStaleProvisionAge bounds how long a non-terminal provision row may
// sit before the reaper treats it as crashed and reclaims it. It sits WELL
// above the worst-case provision wall-clock (VM boot + runtime install + clone +
// host install, each with its own bounded timeout) so an in-flight provision
// is never reaped out from under itself.
const repoGatewayStaleProvisionAge = 30 * time.Minute

// repoGatewayReaperInterval is the sweep cadence.
const repoGatewayReaperInterval = 5 * time.Minute

var repoGatewayReaperIntervalDuration = repoGatewayReaperInterval

// StartReaper runs a best-effort background sweep that reclaims gateway rows
// stuck in a non-terminal state (a provision that crashed after the VM/domain
// were created but before the row reached a clean terminal status), deleting
// their sandbox and Plue preview mapping and soft-deleting the row. It
// mirrors the workspaceCleaner/pairSessionService sweep pattern. Each tick
// also runs the access-revocation sweep (when wired), tearing down live
// gateways whose user lost write access to the repository. Blocks until ctx is
// cancelled; run it in its own goroutine.
func (s *RepoGatewayService) StartReaper(ctx context.Context) {
	if s == nil || s.q == nil || s.sandbox == nil {
		return
	}
	ticker := time.NewTicker(repoGatewayReaperIntervalDuration)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweepStaleGateways(ctx)
			s.sweepRevokedGateways(ctx)
			s.sweepWidowedGateways(ctx)
			s.sweepDiscardedWorkspaceGateways(ctx)
		}
	}
}

// sweepStaleGateways reclaims one batch of stale gateway rows. Exported-for-test
// via a thin wrapper is unnecessary; the query + this method are unit-tested
// directly through the querier + sandbox mocks.
func (s *RepoGatewayService) sweepStaleGateways(ctx context.Context) {
	ageSeconds := int64(repoGatewayStaleProvisionAge / time.Second)
	rows, err := s.q.ListStaleRepoGateways(ctx, ageSeconds)
	if err != nil {
		slog.Warn("repo gateway reaper: list stale rows failed", "error", err)
		return
	}
	for _, row := range rows {
		if row.WorkspaceID.Valid {
			s.discardGateway(ctx, row)
			continue
		}
		if strings.TrimSpace(row.VmID) != "" {
			// Tolerate 404 (fail() or a prior sweep may already have deleted it).
			if err := s.sandbox.RevokeIngress(ctx, repoGatewayDomain(row.VmID)); err != nil && !vmAlreadyGone(err) {
				slog.Warn("repo gateway reaper: unmap domain failed", "gateway_id", row.ID, "vm_id", row.VmID, "error", err)
			}
			if err := s.sandbox.DeleteSandbox(ctx, row.VmID); err != nil && !vmAlreadyGone(err) {
				slog.Warn("repo gateway reaper: delete vm failed", "gateway_id", row.ID, "vm_id", row.VmID, "error", err)
			}
		}
		meterSandboxUsage(ctx, s.q, row.UserID, "gateway", row.ID, false)
		if _, err := s.q.SoftDeleteRepoGateway(ctx, row.ID); err != nil {
			slog.Warn("repo gateway reaper: soft-delete row failed", "gateway_id", row.ID, "error", err)
		}
	}
}

// sweepWidowedGateways discards live rows whose backing VM can no longer
// serve: the VM is gone at the provider (reclaimed out-of-band — the row
// would otherwise answer status:"running" forever while every relay call
// fails), or the VM has sat stopped past repoGatewayWidowedIdleMax — far
// beyond the 30-minute idle-suspend contract — so the next resolve provisions
// a fresh gateway (current engine pin, current agent seat) instead of
// resuming an indefinitely stale snapshot. Deleting the stopped VM also
// releases its retained disk. A provider blip is NOT evidence: rows are kept
// on any uncertain answer and the next tick retries.
func (s *RepoGatewayService) sweepWidowedGateways(ctx context.Context) {
	rows, err := s.q.ListActiveRepoGateways(ctx)
	if err != nil {
		slog.Warn("repo gateway widowed sweep: list active rows failed", "error", err)
		return
	}
	for _, row := range rows {
		if row.WorkspaceID.Valid {
			workspace, loadErr := s.loadGatewayWorkspace(ctx, row.WorkspaceID.String(), row.RepositoryID, row.UserID)
			var apiErr *pkgerrors.APIError
			if errors.As(loadErr, &apiErr) && (apiErr.Status == 404 || apiErr.Status == 403) {
				s.discardGateway(ctx, row)
				continue
			}
			if loadErr != nil {
				continue
			}
			if workspace.VmID != row.VmID {
				s.discardGateway(ctx, row)
				continue
			}
		}

		if strings.TrimSpace(row.VmID) == "" {
			continue
		}
		vm, err := s.sandbox.InspectSandbox(ctx, row.VmID)
		if err != nil {
			if vmAlreadyGone(err) || vmPlacementStale(err) {
				slog.Warn("repo gateway widowed: vm is gone",
					"gateway_id", row.ID, "vm_id", row.VmID, "error", err)
				s.discardGateway(ctx, row)
			} else {
				slog.Warn("repo gateway widowed sweep: inspect failed",
					"gateway_id", row.ID, "vm_id", row.VmID, "error", err)
			}
			continue
		}
		if vm.State == sandbox.StateRunning || vm.State == sandbox.StateStarting {
			continue
		}
		if idleFor := time.Since(row.LastActivityAt); idleFor <= repoGatewayWidowedIdleMax {
			continue
		}
		slog.Info("repo gateway widowed: vm stopped beyond idle contract",
			"gateway_id", row.ID, "vm_id", row.VmID,
			"vm_state", vm.State, "last_activity_at", row.LastActivityAt)
		s.discardGateway(ctx, row)
	}
}

// sweepRevokedGateways tears down live gateways whose user no longer has
// write access to the repository. The provision route checks write permission
// once, but the returned operator token is then validated only by the VM for
// the lifetime of the gateway process — so a collaborator/team/org/repo
// permission change leaves a revoked writer holding a working token against a
// VM that contains the cloned checkout. This sweep bounds that exposure to the
// reaper cadence. Over-revocation is safe:
// a still-authorized user simply re-provisions on the next resolve. On any
// uncertain answer (transient DB failure) the gateway is kept and the next
// sweep retries — except a hard-deleted repository, whose gateway can never
// be re-authorized and is discarded.
func (s *RepoGatewayService) sweepRevokedGateways(ctx context.Context) {
	if s.accessQuerier == nil {
		return
	}
	rows, err := s.accessQuerier.ListActiveRepoGateways(ctx)
	if err != nil {
		slog.Warn("repo gateway revocation sweep: list active rows failed", "error", err)
		return
	}
	for _, row := range rows {
		repository, err := s.accessQuerier.GetRepoByID(ctx, row.RepositoryID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				slog.Warn("repo gateway revoked: repository is gone",
					"gateway_id", row.ID, "vm_id", row.VmID, "repository_id", row.RepositoryID)
				s.discardGateway(ctx, row)
			} else {
				slog.Warn("repo gateway revocation sweep: load repository failed",
					"gateway_id", row.ID, "repository_id", row.RepositoryID, "error", err)
			}
			continue
		}
		canWrite, err := canWriteRepo(ctx, s.accessQuerier, repository, row.UserID)
		if err != nil {
			slog.Warn("repo gateway revocation sweep: permission check failed",
				"gateway_id", row.ID, "user_id", row.UserID, "repository_id", row.RepositoryID, "error", err)
			continue
		}
		if canWrite {
			continue
		}
		slog.Info("repo gateway revoked: user lost write access",
			"gateway_id", row.ID, "vm_id", row.VmID, "user_id", row.UserID, "repository_id", row.RepositoryID)
		s.discardGateway(ctx, row)
	}
}

// generateRepoGatewayToken mints the gateway operator token
// (smithers_gateway_ + 40 hex chars) and its SHA-256 hash.
func generateRepoGatewayToken() (plaintext string, hash string, err error) {
	plaintext = repoGatewayTokenPrefix + randomHex(20)
	sum := sha256.Sum256([]byte(plaintext))
	return plaintext, hex.EncodeToString(sum[:]), nil
}

func isRepoGatewayActiveUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505" && pgErr.ConstraintName == "uq_repo_gateways_active"
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "uq_repo_gateways_active")
}

func WithRepoGatewayBillingPolicy(policy BillingPolicy) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) { s.billing = policy }
}
