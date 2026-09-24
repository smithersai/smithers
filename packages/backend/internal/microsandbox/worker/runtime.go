package worker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2/google"

	upstream "github.com/superradcompany/microsandbox/sdk/go"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type Runtime interface {
	EnsureInstalled(context.Context) error
	Version() (string, error)
	List(context.Context) ([]string, error)
	Create(context.Context, string, int64, sandbox.CreateRequest) (sandbox.CreateResult, error)
	Get(context.Context, string) (sandbox.Sandbox, error)
	Delete(context.Context, string) error
	Start(context.Context, string) (sandbox.StartResult, error)
	Stop(context.Context, string) (sandbox.StopResult, error)
	Suspend(context.Context, string) (sandbox.SuspendResult, error)
	Exec(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error)
	WriteFile(context.Context, string, string, sandbox.WriteFileRequest) error
	StartService(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error)
	Snapshot(context.Context, string, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error)
	DeleteSnapshot(context.Context, string) error
	ExportSnapshot(context.Context, string, string) (msb.SnapshotTransferMetadata, error)
	ImportSnapshot(context.Context, string, string) (msb.SnapshotTransferMetadata, error)
}

type SDKRuntime struct {
	// egress, when set, provides the per-sandbox credential-substituting
	// proxy. A request that asks for one on a runtime without it fails closed
	// with ErrEgressProxyUnavailable before any guest is booted.
	egress      *EgressProxyManager
	maintenance sync.RWMutex
}

// RuntimeOption configures NewSDKRuntime.
type RuntimeOption func(*SDKRuntime)

// WithEgressProxyManager enables egress-proxy sandboxes on this runtime.
func WithEgressProxyManager(manager *EgressProxyManager) RuntimeOption {
	return func(r *SDKRuntime) { r.egress = manager }
}

var ErrQuiesceFailed = errors.New("guest filesystem quiescence failed")

const durableStopTimeout = 60 * time.Second

// ErrSecretDeliveryUnavailable fails a secret-carrying exec closed. The raw
// Microsandbox 0.6.15 SDK exposes only WithExecEnv, which serializes values
// into runtime state and logs while the command runs; there is no
// nonpersisting operation-scoped channel. Per the spec's secrets contract the
// operation must refuse before anything reaches the SDK rather than inject
// plaintext and scrub afterwards.
var ErrSecretDeliveryUnavailable = errors.New("operation-scoped secret delivery is unavailable: Microsandbox 0.6.15 has no nonpersisting channel")

func NewSDKRuntime(options ...RuntimeOption) *SDKRuntime {
	runtime := &SDKRuntime{}
	for _, option := range options {
		if option != nil {
			option(runtime)
		}
	}
	return runtime
}

// egressEnabled reports whether request asks for the per-sandbox proxy.
func egressEnabled(request sandbox.CreateRequest) bool {
	return request.EgressProxy != nil && request.EgressProxy.Enabled
}

const guestRuntimeEnvironmentProfile = `# Managed by Smithers: load runtime-only workspace environment.
for smithers_env in /etc/smithers/egress.env /etc/smithers/workspace-git.env; do
  if [ -r "$smithers_env" ]; then . "$smithers_env"; fi
done
unset smithers_env
`

// applyEgressProxy rewrites request so the proxy at endpoint is the guest's
// only egress path: default-deny firewall with one allow for the proxy port
// on the sandbox host (plus gateway DNS so the alias resolves), the CA written
// to EgressProxyCAGuestPath, and the proxy env merged into every declared
// service. Bootstrap-time shells and clones receive the same env.
func applyEgressProxy(request sandbox.CreateRequest, endpoint EgressProxyEndpoint, caPEM []byte) sandbox.CreateRequest {
	request.Internet = ""
	request.Firewall = &sandbox.FirewallPolicy{
		DefaultEgressAction: "deny",
		EgressAllow: []sandbox.FirewallEgressRule{
			{Host: "host", Port: int32(endpoint.Port), Protocol: "tcp"},
			{Host: "host", Port: 53, Protocol: "udp"},
			{Host: "host", Port: 53, Protocol: "tcp"},
		},
	}
	files := make(map[string]sandbox.SandboxFile, len(request.Files)+3)
	for path, file := range request.Files {
		files[path] = file
	}
	files[sandbox.EgressProxyCAGuestPath] = sandbox.SandboxFile{Content: string(caPEM)}
	// SSH shells are not created through Exec or CreateService, so they do not
	// inherit the proxy environment merged below. Persist only the nonsecret
	// routing/trust bundle; the container profile and NixOS module source it for
	// every login shell. Proxy-bound credential values remain in iron-proxy.
	files[sandbox.EgressProxyEnvGuestPath] = sandbox.SandboxFile{Content: renderGuestEnvironment(endpoint.Env)}
	files[sandbox.EgressProxyProfileGuestPath] = sandbox.SandboxFile{Content: guestRuntimeEnvironmentProfile}
	request.Files = files
	if request.Init != nil {
		systemd := *request.Init
		systemd.Services = append([]sandbox.ServiceSpec(nil), request.Init.Services...)
		for index := range systemd.Services {
			systemd.Services[index].Env = mergeProxyEnv(systemd.Services[index].Env, endpoint.Env)
		}
		request.Init = &systemd
	}
	return request
}

func renderGuestEnvironment(environment map[string]string) string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var profile strings.Builder
	profile.WriteString("# Managed by Smithers: per-sandbox egress routing and trust.\n")
	for _, key := range keys {
		profile.WriteString("export ")
		profile.WriteString(key)
		profile.WriteByte('=')
		profile.WriteString(shellQuote(environment[key]))
		profile.WriteByte('\n')
	}
	return profile.String()
}

// mergeProxyEnv overlays the proxy wiring onto env. The proxy keys win: a
// service that set its own HTTPS_PROXY would otherwise silently bypass the
// credential boundary.
func mergeProxyEnv(env, proxyEnv map[string]string) map[string]string {
	if len(proxyEnv) == 0 {
		return env
	}
	merged := make(map[string]string, len(env)+len(proxyEnv))
	for key, value := range env {
		merged[key] = value
	}
	for key, value := range proxyEnv {
		merged[key] = value
	}
	return merged
}

// ErrSandboxNotRunning refuses an SSH bridge to a guest that is not live.
var ErrSandboxNotRunning = errors.New("sandbox is not running")

// sshBridgeAttachable admits only a live guest. The bridge never boots one:
// starting a guest belongs to the controller's startPlacement, which holds
// the compute reservation and starts the egress proxy first.
func sshBridgeAttachable(status upstream.SandboxStatus) error {
	if status == upstream.SandboxStatusRunning || status == upstream.SandboxStatusDraining {
		return nil
	}
	return fmt.Errorf("%w: status %s", ErrSandboxNotRunning, status)
}

// ServeSSHBridge runs in a short-lived worker child process because the
// Microsandbox Go SDK's stdio bridge intentionally owns process stdin/stdout.
// WithSSHServerUser binds every shell/exec/SFTP request to the user authorized
// by Plue instead of trusting the username proposed by the nested SSH client.
func ServeSSHBridge(ctx context.Context, id, user, authorizedKeysPath string) error {
	authorizedKeysPath = strings.TrimSpace(authorizedKeysPath)
	if authorizedKeysPath == "" {
		return errors.New("Microsandbox SSH authorized keys file is required")
	}
	handle, err := upstream.GetSandbox(ctx, id)
	if err != nil {
		return err
	}
	if err := sshBridgeAttachable(handle.Status()); err != nil {
		return err
	}
	live, err := handle.Connect(ctx)
	if err != nil {
		return err
	}
	server, err := live.SSH().PrepareServer(ctx,
		upstream.WithSSHServerUser(user),
		upstream.WithSSHAuthorizedKeysPath(authorizedKeysPath),
	)
	if err != nil {
		_ = live.Detach(context.WithoutCancel(ctx))
		return err
	}
	// The prepared server owns the bridge state. Release the transient live
	// handle without stopping the detached guest before serving the stream.
	if err := live.Detach(ctx); err != nil {
		_ = server.Close(context.WithoutCancel(ctx))
		return err
	}
	defer func() { _ = server.Close(context.WithoutCancel(ctx)) }()
	return server.ServeConnection(ctx)
}

func (r *SDKRuntime) EnsureInstalled(ctx context.Context) error {
	return upstream.EnsureInstalled(ctx, upstream.WithSkipDownload())
}

func (r *SDKRuntime) Version() (string, error) { return upstream.RuntimeVersion() }

func (r *SDKRuntime) List(ctx context.Context) ([]string, error) {
	var ids []string
	var cursor string
	for {
		options := []upstream.SandboxListOption{
			upstream.WithListLabels(map[string]string{"plue_kind": "sandbox"}),
		}
		if cursor != "" {
			options = append(options, upstream.WithListCursor(cursor))
		}
		page, err := upstream.ListSandboxesWith(ctx, options...)
		if err != nil {
			return nil, err
		}
		for _, handle := range page.Sandboxes {
			ids = append(ids, handle.Name())
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		cursor = *page.NextCursor
	}
	return ids, nil
}

func (r *SDKRuntime) Create(ctx context.Context, id string, generation int64, request sandbox.CreateRequest) (result sandbox.CreateResult, resultErr error) {
	r.maintenance.RLock()
	defer func() {
		r.maintenance.RUnlock()
		if resultErr != nil {
			root, err := DefaultDiskCacheRoot()
			if err == nil {
				if err := r.CleanupDiskCacheTemporary(root); err != nil {
					slog.Warn("Microsandbox failed-pull cleanup failed", "error", err)
				}
			}
		}
	}()
	request = normalizeCreateRequest(request)
	// Reject an unbootable request before the egress proxy receives secret
	// values: no return above the post-create cleanup may leave one running.
	if strings.TrimSpace(request.SnapshotID) == "" && strings.TrimSpace(request.Image) == "" {
		return sandbox.CreateResult{}, errors.New("Microsandbox image is required")
	}
	var proxyEnv map[string]string
	if egressEnabled(request) {
		if r.egress == nil {
			return sandbox.CreateResult{}, ErrEgressProxyUnavailable
		}
		endpoint, err := r.egress.Start(ctx, id, request.EgressProxy)
		if err != nil {
			return sandbox.CreateResult{}, err
		}
		request = applyEgressProxy(request, endpoint, r.egress.CACertPEM())
		proxyEnv = endpoint.Env
	}
	// The values were consumed into the proxy process; nothing below may
	// reach for them again.
	if request.EgressProxy != nil {
		policy := *request.EgressProxy
		policy.Secrets = nil
		request.EgressProxy = &policy
	}
	options := []upstream.SandboxOption{
		upstream.WithMemory(uint32(positiveInt32(request.MemSizeMB, 512))),
		upstream.WithCPUs(uint8(positiveInt32(request.VCPUCount, 1))),
		// The OCI workdir is validated before provider bootstrap creates requested
		// users and home directories. Boot from the image-guaranteed root home;
		// service and exec calls apply their own post-bootstrap working directory.
		upstream.WithWorkdir("/root"),
		upstream.WithUser("root"),
		upstream.WithPullPolicy(upstream.PullPolicyIfMissing),
		upstream.WithDetached(),
		upstream.WithReplace(),
		upstream.WithEphemeral(deleteRuntimeOnTerminal(request)),
		upstream.WithLabels(map[string]string{
			"plue_kind":       "sandbox",
			"plue_guest_kind": normalizeGuestKind(request.Kind),
			"plue_generation": strconv.FormatInt(generation, 10),
		}),
	}
	options = append(options, guestBootOptions(request.Kind)...)
	if policy := networkPolicy(request); policy != nil {
		options = append(options, upstream.WithNetwork(policy))
	}
	if request.IdleTimeoutSeconds != nil && *request.IdleTimeoutSeconds > 0 {
		options = append(options, upstream.WithIdleTimeout(time.Duration(*request.IdleTimeoutSeconds)*time.Second))
	}
	registryImage := request.Image
	if strings.TrimSpace(request.SnapshotID) != "" {
		snapshot, err := upstream.Snapshot.Get(ctx, request.SnapshotID)
		if err != nil {
			r.stopEgress(id, true)
			return sandbox.CreateResult{}, err
		}
		registryImage = snapshot.ImageRef()
		options = append(options, upstream.WithFromSnapshot(request.SnapshotID))
	} else {
		options = append(options,
			upstream.WithImage(request.Image),
			// SA1019: the SDK's WithRootDisk replacement changes the rootfs
			// provisioning contract; migrate it deliberately, not in a lint sweep.
			upstream.WithOCIUpperSize(uint32(positiveInt64(request.RootfsSizeMB, msb.DefaultRootfsSizeMB(request.Kind)))), //nolint:staticcheck
		)
	}
	// Snapshot archives contain disk layers, not the OCI base image. Both a
	// cold image boot and a snapshot restored onto a new worker may need to pull
	// a private base. Mint short-lived Artifact Registry credentials through
	// Workload Identity for either path.
	if auth := googleRegistryAuth(ctx, registryImage); auth != nil {
		options = append(options, upstream.WithRegistryAuth(*auth))
	}

	live, err := upstream.CreateSandbox(ctx, id, options...)
	if err != nil {
		r.stopEgress(id, true)
		return sandbox.CreateResult{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = live.Stop(context.Background())
			_ = live.Close()
			_ = upstream.RemoveSandbox(context.Background(), id)
			r.stopEgress(id, true)
		}
	}()
	if err := bootstrap(ctx, live, request, proxyEnv); err != nil {
		return sandbox.CreateResult{}, err
	}
	if err := live.Detach(ctx); err != nil {
		return sandbox.CreateResult{}, err
	}
	cleanup = false
	return sandbox.CreateResult{ID: id}, nil
}

func deleteRuntimeOnTerminal(request sandbox.CreateRequest) bool {
	if request.Persistence == nil || request.Persistence.Type != sandbox.PersistenceEphemeral ||
		request.Persistence.DeleteEvent == nil {
		return false
	}
	switch *request.Persistence.DeleteEvent {
	case sandbox.DeleteOnStop, sandbox.DeleteOnSuspend:
		return true
	default:
		return false
	}
}

func networkPolicy(request sandbox.CreateRequest) *upstream.NetworkConfig {
	internet := strings.ToLower(strings.TrimSpace(request.Internet))
	if internet == "none" || internet == "disabled" || internet == "deny" {
		return upstream.NetworkPolicy.None()
	}
	if request.Firewall == nil {
		// Microsandbox defaults to public-only when network configuration is
		// omitted. Keep that runtime default so the HVF DNS proxy remains
		// reachable; explicitly applying the equivalent preset in 0.6.15 blocks
		// the guest's private resolver before public hostnames can be classified.
		return nil
	}

	policy := upstream.NetworkPolicy.FromProfiles(upstream.NetworkProfilePublic)
	if strings.EqualFold(strings.TrimSpace(request.Firewall.DefaultEgressAction), "deny") {
		// A custom default-deny policy already blocks every destination not
		// explicitly listed, including private and metadata ranges.
		policy = &upstream.NetworkConfig{}
		policy.DefaultEgress = upstream.PolicyActionDeny
	}
	for _, allowed := range request.Firewall.EgressAllow {
		destination := strings.TrimSpace(allowed.Host)
		if destination == "" {
			destination = "*"
		}
		rule := upstream.PolicyRule{
			Action:      upstream.PolicyActionAllow,
			Direction:   upstream.PolicyDirectionEgress,
			Destination: destination,
		}
		if allowed.Port > 0 {
			rule.Port = strconv.Itoa(int(allowed.Port))
		}
		switch strings.ToLower(strings.TrimSpace(allowed.Protocol)) {
		case "tcp":
			rule.Protocol = upstream.PolicyProtocolTCP
		case "udp":
			rule.Protocol = upstream.PolicyProtocolUDP
		case "icmp":
			rule.Protocols = []upstream.PolicyProtocol{
				upstream.PolicyProtocolICMPv4,
				upstream.PolicyProtocolICMPv6,
			}
		}
		policy.Rules = append(policy.Rules, rule)
	}
	return policy
}

func (r *SDKRuntime) Get(ctx context.Context, id string) (sandbox.Sandbox, error) {
	handle, err := upstream.GetSandbox(ctx, id)
	if err != nil {
		return sandbox.Sandbox{}, err
	}
	state := sandbox.StateStopped
	switch handle.Status() {
	case upstream.SandboxStatusRunning, upstream.SandboxStatusDraining:
		state = sandbox.StateRunning
	case upstream.SandboxStatusPaused:
		state = sandbox.StateSuspending
	}
	return sandbox.Sandbox{
		ID: id, RuntimeID: id, State: state, LastNetworkActivity: handle.UpdatedAt(),
	}, nil
}

// stopEgress tears down the sandbox's proxy. forget also drops the marker
// that records the sandbox as proxy-backed; a retained disk keeps it so a
// later Start fails closed until secrets are re-supplied.
func (r *SDKRuntime) stopEgress(id string, forget bool) {
	if r.egress == nil {
		return
	}
	if forget {
		r.egress.Stop(id)
		return
	}
	r.egress.Suspend(id)
}

// requireEgress fails closed when a proxy-backed sandbox has no live proxy:
// after a worker restart the values are gone and the guest's default-deny
// firewall would leave it with no egress at all.
func (r *SDKRuntime) requireEgress(id string) (map[string]string, error) {
	if r.egress == nil {
		return nil, nil
	}
	if endpoint, live := r.egress.Endpoint(id); live {
		return endpoint.Env, nil
	}
	if r.egress.Required(id) {
		return nil, ErrEgressProxyUnavailable
	}
	return nil, nil
}

func (r *SDKRuntime) Delete(ctx context.Context, id string) error {
	// Delete intentionally does not require guest quiescence: the caller has
	// authorized data destruction, and a wedged guest must not make orphan or
	// quota cleanup impossible. Microsandbox requires a terminal guest before
	// removing its persisted state, so force a non-terminal guest down first.
	// Durable stop/snapshot paths quiesce separately.
	r.stopEgress(id, true)
	handle, err := upstream.GetSandbox(ctx, id)
	if err != nil {
		return err
	}
	if handle.Status() != upstream.SandboxStatusStopped && handle.Status() != upstream.SandboxStatusCrashed {
		if err := handle.Kill(ctx, upstream.WithKillTimeout(30*time.Second)); err != nil {
			return err
		}
	}
	return handle.Remove(ctx)
}

// StartWithEgress rebinds credentials before the retained guest starts. Values
// remain only in the proxy process, just as on initial creation.
func (r *SDKRuntime) StartWithEgress(ctx context.Context, id string, policy *sandbox.EgressProxyPolicy) (sandbox.StartResult, error) {
	if r.egress == nil {
		return sandbox.StartResult{}, ErrEgressProxyUnavailable
	}
	if _, err := r.egress.Resume(ctx, id, policy); err != nil {
		return sandbox.StartResult{}, err
	}
	result, err := r.Start(ctx, id)
	if err != nil {
		r.egress.Suspend(id)
	}
	return result, err
}

func (r *SDKRuntime) Start(ctx context.Context, id string) (sandbox.StartResult, error) {
	handle, err := upstream.GetSandbox(ctx, id)
	if err != nil {
		return sandbox.StartResult{}, err
	}
	if handle.Status() == upstream.SandboxStatusRunning {
		return sandbox.StartResult{ID: id, RuntimeID: id}, nil
	}
	if _, err := r.requireEgress(id); err != nil {
		return sandbox.StartResult{}, err
	}
	live, err := handle.StartDetached(ctx)
	if err != nil {
		return sandbox.StartResult{}, err
	}
	if err := live.Detach(ctx); err != nil {
		return sandbox.StartResult{}, err
	}
	return sandbox.StartResult{ID: id, RuntimeID: id}, nil
}

func (r *SDKRuntime) Stop(ctx context.Context, id string) (sandbox.StopResult, error) {
	handle, err := upstream.GetSandbox(ctx, id)
	if err != nil {
		return sandbox.StopResult{}, err
	}
	if handle.Status() != upstream.SandboxStatusStopped && handle.Status() != upstream.SandboxStatusCrashed {
		if err := quiesce(ctx, id); err != nil {
			return sandbox.StopResult{}, err
		}
		if err := stopWithoutEscalation(ctx, handle); err != nil {
			return sandbox.StopResult{}, err
		}
	}
	// A stopped guest must not leave its credentials resident on the host.
	r.stopEgress(id, false)
	return sandbox.StopResult{SandboxID: id, RuntimeID: id}, nil
}

func (r *SDKRuntime) Suspend(ctx context.Context, id string) (sandbox.SuspendResult, error) {
	if _, err := r.Stop(ctx, id); err != nil {
		return sandbox.SuspendResult{}, err
	}
	return sandbox.SuspendResult{ID: id, RuntimeID: id}, nil
}

func (r *SDKRuntime) Exec(ctx context.Context, id string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
	// Fail closed before anything reaches the SDK so no plaintext ever has a
	// transient window in runtime state, logs, or the guest.
	if len(request.Secrets) > 0 {
		return sandbox.ExecResult{}, ErrSecretDeliveryUnavailable
	}
	proxyEnv, err := r.requireEgress(id)
	if err != nil {
		return sandbox.ExecResult{}, err
	}
	live, err := connectRunning(ctx, id)
	if err != nil {
		return sandbox.ExecResult{}, err
	}
	defer func() { _ = live.Close() }()
	options := []upstream.ExecOption{upstream.WithExecTimeout(boundedExecTimeout(request.TimeoutMS))}
	if len(proxyEnv) > 0 {
		options = append(options, upstream.WithExecEnv(proxyEnv))
	}
	// The provider-facing Exec contract is Bash: product commands use pipefail,
	// arrays, and other Bash syntax. Microsandbox's Shell helper invokes the
	// image's /bin/sh (dash on Debian), so explicitly enter Bash and quote the
	// complete script as one argument.
	output, err := live.Shell(ctx, bashExecCommand(request.Command), options...)
	if err != nil {
		return sandbox.ExecResult{}, err
	}
	status := int32(output.ExitCode())
	return sandbox.ExecResult{Stdout: output.Stdout(), Stderr: output.Stderr(), StatusCode: &status}, nil
}

func bashExecCommand(command string) string {
	return "exec /bin/bash -lc " + shellQuote(command)
}

func boundedExecTimeout(timeoutMilliseconds *int64) time.Duration {
	const maximum = 30 * time.Minute
	if timeoutMilliseconds == nil || *timeoutMilliseconds <= 0 {
		return maximum
	}
	if *timeoutMilliseconds > int64(maximum/time.Millisecond) {
		return maximum
	}
	requested := time.Duration(*timeoutMilliseconds) * time.Millisecond
	return requested
}

func (r *SDKRuntime) WriteFile(ctx context.Context, id, filePath string, request sandbox.WriteFileRequest) error {
	live, err := connectRunning(ctx, id)
	if err != nil {
		return err
	}
	defer func() { _ = live.Close() }()
	if err := ensureGuestParent(ctx, live, filePath); err != nil {
		return err
	}
	return live.FS().WriteString(ctx, filePath, request.Content)
}

func (r *SDKRuntime) StartService(ctx context.Context, id string, service sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	proxyEnv, err := r.requireEgress(id)
	if err != nil {
		return sandbox.CreateServiceResult{}, err
	}
	service.Env = mergeProxyEnv(service.Env, proxyEnv)
	live, err := connectRunning(ctx, id)
	if err != nil {
		return sandbox.CreateServiceResult{}, err
	}
	defer func() { _ = live.Close() }()
	if err := startService(ctx, live, service); err != nil {
		return sandbox.CreateServiceResult{Success: false, Message: err.Error(), ServiceName: service.Name}, err
	}
	return sandbox.CreateServiceResult{Success: true, Message: "service started", ServiceName: service.Name}, nil
}

func (r *SDKRuntime) Snapshot(ctx context.Context, id, snapshotID string, _ sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	r.maintenance.RLock()
	defer r.maintenance.RUnlock()
	handle, err := upstream.GetSandbox(ctx, id)
	if err != nil {
		return sandbox.SnapshotResult{}, err
	}
	wasRunning := handle.Status() == upstream.SandboxStatusRunning || handle.Status() == upstream.SandboxStatusDraining
	if wasRunning {
		if err := quiesce(ctx, id); err != nil {
			return sandbox.SnapshotResult{}, err
		}
		if err := stopWithoutEscalation(ctx, handle); err != nil {
			return sandbox.SnapshotResult{}, err
		}
	}
	// Microsandbox snapshots clone the stopped sandbox's upper.ext4 directly.
	// Its lifecycle state can become terminal before macOS has durably flushed
	// the final clean-unmount writes. Fsync the source before the runtime's
	// clonefile fast path so a recovery artifact cannot capture a stale ext4
	// superblock and later boot with a read-only root filesystem.
	if err := syncSandboxUpper(id); err != nil {
		return sandbox.SnapshotResult{}, fmt.Errorf("sync stopped sandbox before snapshot: %w", err)
	}
	artifact, err := handle.Snapshot(ctx, snapshotID)
	if err != nil {
		if wasRunning {
			_, _ = r.Start(context.WithoutCancel(ctx), id)
		}
		return sandbox.SnapshotResult{}, err
	}
	if wasRunning {
		if _, err := r.Start(ctx, id); err != nil {
			return sandbox.SnapshotResult{}, fmt.Errorf("snapshot created but source restart failed: %w", err)
		}
	}
	return sandbox.SnapshotResult{
		SnapshotID: snapshotID, SourceSandboxID: id,
		SourceRuntimeID: id + ":" + artifact.Digest(),
	}, nil
}

// stopWithoutEscalation deliberately avoids SandboxHandle.Stop. The upstream
// helper force-kills the guest when its ten-second graceful deadline expires
// and still returns success. That is appropriate for best-effort teardown but
// unsafe immediately before a durable snapshot: a force-killed ext4 upper can
// be cloned with a dirty superblock and restore read-only. Snapshot-producing
// lifecycle operations fail instead of silently converting a graceful stop
// into data-corrupting success.
func stopWithoutEscalation(ctx context.Context, handle *upstream.SandboxHandle) error {
	if err := handle.RequestStop(ctx); err != nil {
		return err
	}
	waitCtx, cancel := context.WithTimeout(ctx, durableStopTimeout)
	defer cancel()
	if _, err := handle.WaitUntilStopped(waitCtx); err != nil {
		return fmt.Errorf("guest did not stop gracefully before durable deadline: %w", err)
	}
	return nil
}

func syncSandboxUpper(id string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	upper := filepath.Join(home, ".microsandbox", "sandboxes", id, "upper.ext4")
	file, err := os.Open(upper)
	if err != nil {
		return err
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	return errors.Join(syncErr, closeErr)
}

func quiesce(ctx context.Context, id string) error {
	live, err := connectRunning(ctx, id)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrQuiesceFailed, err)
	}
	defer func() { _ = live.Close() }()
	quiesceCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := live.Shell(quiesceCtx, "sync", upstream.WithExecTimeout(30*time.Second)); err != nil {
		return fmt.Errorf("%w: %v", ErrQuiesceFailed, err)
	}
	return nil
}

func (r *SDKRuntime) DeleteSnapshot(ctx context.Context, snapshotID string) error {
	r.maintenance.RLock()
	defer r.maintenance.RUnlock()
	removeErr := upstream.Snapshot.Remove(ctx, snapshotID, true)
	digestPath, pathErr := snapshotArchiveDigestPath(snapshotID)
	if pathErr != nil {
		return errors.Join(removeErr, pathErr)
	}
	metadataErr := os.Remove(digestPath)
	if errors.Is(metadataErr, os.ErrNotExist) {
		metadataErr = nil
	}
	return errors.Join(removeErr, metadataErr)
}

func (r *SDKRuntime) ExportSnapshot(ctx context.Context, snapshotID, destination string) (msb.SnapshotTransferMetadata, error) {
	r.maintenance.RLock()
	defer r.maintenance.RUnlock()
	if err := upstream.Snapshot.Save(ctx, snapshotID, destination, upstream.SnapshotSaveOptions{
		WithParents: true,
	}); err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	digest, size, err := snapshotArchiveMetadata(destination)
	if err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	digestPath, err := snapshotArchiveDigestPath(snapshotID)
	if err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	if err := persistSnapshotArchiveDigest(digestPath, digest); err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	return msb.SnapshotTransferMetadata{SnapshotID: snapshotID, Digest: digest, SizeBytes: size}, nil
}

func (r *SDKRuntime) ImportSnapshot(ctx context.Context, snapshotID, archive string) (msb.SnapshotTransferMetadata, error) {
	r.maintenance.RLock()
	defer r.maintenance.RUnlock()
	if !validLocalSnapshotID(snapshotID) {
		return msb.SnapshotTransferMetadata{}, errors.New("invalid local snapshot id")
	}
	digest, archiveSize, err := snapshotArchiveMetadata(archive)
	if err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	snapshotsDir := filepath.Join(home, ".microsandbox", "snapshots")
	finalPath := filepath.Join(snapshotsDir, snapshotID)
	digestPath, err := snapshotArchiveDigestPath(snapshotID)
	if err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	// Recover a crash after the artifact rename but before index publication.
	if _, err := os.Stat(finalPath); err == nil {
		if _, err := upstream.Snapshot.Reindex(ctx, snapshotsDir); err != nil {
			return msb.SnapshotTransferMetadata{}, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return msb.SnapshotTransferMetadata{}, err
	}
	if _, err := upstream.Snapshot.Get(ctx, snapshotID); err == nil {
		persistedDigest, readErr := os.ReadFile(digestPath)
		if readErr == nil && strings.TrimSpace(string(persistedDigest)) == digest {
			return msb.SnapshotTransferMetadata{SnapshotID: snapshotID, Digest: digest, SizeBytes: archiveSize}, nil
		}
		// An imported snapshot without its durable digest marker cannot be
		// trusted or repaired in place. Remove it so this request can perform a
		// clean, verified import instead of wedging every recovery retry.
		if removeErr := upstream.Snapshot.Remove(context.WithoutCancel(ctx), snapshotID, true); removeErr != nil {
			return msb.SnapshotTransferMetadata{}, fmt.Errorf("replace imported snapshot with invalid digest marker: %w", removeErr)
		}
		if removeErr := os.Remove(digestPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return msb.SnapshotTransferMetadata{}, fmt.Errorf("remove invalid snapshot digest marker: %w", removeErr)
		}
	}
	importsDir := filepath.Join(snapshotsDir, "plue-imports")
	if err := os.MkdirAll(importsDir, 0o700); err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	// Load names archive members by content digest, not the source snapshot's
	// name. Give every attempt its own directory so an interrupted import cannot
	// wedge retries with "snapshot already exists". Imported parents remain here
	// because the SDK index resolves their content digests to these paths.
	destination, err := os.MkdirTemp(importsDir, snapshotID+"-")
	if err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	handle, err := upstream.Snapshot.Load(ctx, archive, destination)
	if err != nil {
		_ = os.RemoveAll(destination)
		return msb.SnapshotTransferMetadata{}, err
	}
	// Publish the verified head under the controller's stable ID, then reindex
	// it. Create, export, and delete all address that ID through the SDK.
	if filepath.Dir(filepath.Clean(handle.Path())) != destination {
		return msb.SnapshotTransferMetadata{}, errors.New("imported snapshot head is outside its destination")
	}
	if err := os.Rename(handle.Path(), finalPath); err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	for _, dir := range []string{destination, snapshotsDir} {
		if err := syncSnapshotDirectory(dir); err != nil {
			return msb.SnapshotTransferMetadata{}, err
		}
	}
	if _, err := upstream.Snapshot.Reindex(ctx, snapshotsDir); err != nil {
		return msb.SnapshotTransferMetadata{}, err
	}
	indexed, err := upstream.Snapshot.Get(ctx, snapshotID)
	if err != nil || indexed.Digest() != handle.Digest() {
		removeErr := upstream.Snapshot.Remove(context.WithoutCancel(ctx), snapshotID, true)
		return msb.SnapshotTransferMetadata{}, errors.Join(
			fmt.Errorf("imported snapshot was not indexed under requested id"), err, removeErr)
	}
	if err := persistSnapshotArchiveDigest(digestPath, digest); err != nil {
		removeErr := upstream.Snapshot.Remove(context.WithoutCancel(ctx), snapshotID, true)
		return msb.SnapshotTransferMetadata{}, errors.Join(err, removeErr)
	}
	return msb.SnapshotTransferMetadata{SnapshotID: snapshotID, Digest: digest, SizeBytes: archiveSize}, nil
}

func syncSnapshotDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

func validLocalSnapshotID(id string) bool {
	if id == "" {
		return false
	}
	for _, ch := range id {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '-') {
			return false
		}
	}
	return true
}

func snapshotArchiveDigestPath(snapshotID string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(snapshotID))
	return filepath.Join(home, ".microsandbox", "plue-snapshot-digests", hex.EncodeToString(sum[:])+".sha256"), nil
}

func snapshotArchiveMetadata(filePath string) (string, int64, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, err
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), size, nil
}

func persistSnapshotArchiveDigest(filePath, digest string) error {
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		return err
	}
	temporary := filePath + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(temporary) }()
	_, writeErr := io.WriteString(file, digest+"\n")
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return errors.Join(writeErr, syncErr, closeErr)
	}
	if err := os.Rename(temporary, filePath); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(filePath))
	if err != nil {
		return err
	}
	syncErr = directory.Sync()
	closeErr = directory.Close()
	return errors.Join(syncErr, closeErr)
}

func connectRunning(ctx context.Context, id string) (*upstream.Sandbox, error) {
	handle, err := upstream.GetSandbox(ctx, id)
	if err != nil {
		return nil, err
	}
	if handle.Status() != upstream.SandboxStatusRunning && handle.Status() != upstream.SandboxStatusDraining {
		return nil, fmt.Errorf("sandbox %s is not running", id)
	}
	return handle.Connect(ctx)
}

func normalizeCreateRequest(request sandbox.CreateRequest) sandbox.CreateRequest {
	request.Kind = normalizeGuestKind(request.Kind)
	if request.Template == nil {
		return request
	}
	template := request.Template
	if request.Image == "" {
		request.Image = template.Image
	}
	if len(request.Files) == 0 {
		request.Files = template.Files
	}
	if len(request.Packages) == 0 {
		request.Packages = template.Packages
	}
	if request.Git == nil {
		request.Git = template.Git
	}
	if len(request.GitRepos) == 0 {
		request.GitRepos = template.GitRepos
	}
	if len(request.Groups) == 0 {
		request.Groups = template.Groups
	}
	if request.IdleTimeoutSeconds == nil {
		request.IdleTimeoutSeconds = template.IdleTimeoutSeconds
	}
	if request.MemSizeMB == nil {
		request.MemSizeMB = template.MemSizeMB
	}
	if request.Firewall == nil {
		request.Firewall = template.Firewall
	}
	if request.Persistence == nil {
		request.Persistence = template.Persistence
	}
	if len(request.Ports) == 0 {
		request.Ports = template.Ports
	}
	if request.RootfsSizeMB == nil {
		request.RootfsSizeMB = template.RootfsSizeMB
	}
	if request.Init == nil {
		request.Init = template.Init
	}
	if len(request.Users) == 0 {
		request.Users = template.Users
	}
	if request.VCPUCount == nil {
		request.VCPUCount = template.VCPUCount
	}
	if request.Workdir == "" {
		request.Workdir = template.Workdir
	}
	return request
}

func normalizeGuestKind(kind string) string {
	switch strings.TrimSpace(kind) {
	case "vm":
		return "vm"
	case "desktop":
		return "desktop"
	default:
		return "container"
	}
}

func guestBootOptions(kind string) []upstream.SandboxOption {
	if kind = normalizeGuestKind(kind); kind == "vm" || kind == "desktop" {
		return []upstream.SandboxOption{upstream.WithInit(upstream.Init.Auto())}
	}
	// Container workloads keep the existing inert entrypoint. Provider-created
	// services are started explicitly after bootstrap.
	return []upstream.SandboxOption{upstream.WithEntrypoint("/bin/sh", "-lc", "while :; do sleep 3600; done")}
}

func bootstrap(ctx context.Context, live *upstream.Sandbox, request sandbox.CreateRequest, proxyEnv map[string]string) error {
	if normalizeGuestKind(request.Kind) == "container" && len(request.Packages) > 0 {
		packages := append([]string(nil), request.Packages...)
		sort.Strings(packages)
		command := "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends " + shellJoin(packages)
		packageOptions := []upstream.ExecOption{upstream.WithExecTimeout(10 * time.Minute)}
		if len(proxyEnv) > 0 {
			packageOptions = append(packageOptions, upstream.WithExecEnv(proxyEnv))
		}
		output, err := live.Shell(ctx, command, packageOptions...)
		if err != nil {
			return fmt.Errorf("install guest packages: %w", err)
		}
		if !output.Success() {
			return fmt.Errorf("install guest packages exited %d: %s", output.ExitCode(), truncate(output.Stderr(), 2048))
		}
	}
	for _, group := range request.Groups {
		command := "getent group " + shellQuote(group.Name) + " >/dev/null || groupadd "
		if group.GID != nil {
			command += "--gid " + strconv.Itoa(int(*group.GID)) + " "
		}
		command += shellQuote(group.Name)
		if err := shellSuccess(ctx, live, command); err != nil {
			return err
		}
	}
	for _, user := range request.Users {
		home := defaultString(user.Home, "/home/"+user.Name)
		shell := defaultString(user.Shell, "/bin/bash")
		command := "id -u " + shellQuote(user.Name) + " >/dev/null 2>&1 || useradd --create-home --home-dir " + shellQuote(home) + " --shell " + shellQuote(shell)
		if user.UID != nil {
			command += " --uid " + strconv.Itoa(int(*user.UID))
		}
		if len(user.Groups) > 0 {
			command += " --groups " + shellQuote(strings.Join(user.Groups, ","))
		}
		command += " " + shellQuote(user.Name)
		if err := shellSuccess(ctx, live, command); err != nil {
			return err
		}
	}
	for filePath, file := range request.Files {
		content := []byte(file.Content)
		if strings.EqualFold(file.Encoding, "base64") {
			decoded, err := base64.StdEncoding.DecodeString(file.Content)
			if err != nil {
				return fmt.Errorf("decode %s: %w", filePath, err)
			}
			content = decoded
		}
		if err := ensureGuestParent(ctx, live, filePath); err != nil {
			return err
		}
		if err := live.FS().Write(ctx, filePath, content); err != nil {
			return fmt.Errorf("write guest file %s: %w", filePath, err)
		}
		if file.Executable {
			if err := shellSuccess(ctx, live, "chmod 0755 "+shellQuote(filePath)); err != nil {
				return err
			}
		}
	}
	if len(proxyEnv) > 0 {
		// Image-kind hook: env-bundle trust is already wired; a distribution
		// trust store is installed only where one exists.
		if err := shellSuccess(ctx, live, egressTrustStoreHook(sandbox.EgressProxyCAGuestPath)); err != nil {
			return err
		}
	}
	repositories := append([]sandbox.GitRepositorySpec(nil), request.GitRepos...)
	if request.Git != nil {
		repositories = append(repositories, request.Git.Repos...)
	}
	for _, repository := range repositories {
		if err := cloneRepository(ctx, live, repository, request.Users, proxyEnv); err != nil {
			return err
		}
	}
	if request.Init != nil {
		for _, service := range request.Init.Services {
			if err := startService(ctx, live, service); err != nil {
				return err
			}
		}
	}
	return nil
}

// clonePlan is one guest `git clone`: its argv, its exec env, and, for a
// credentialed remote, the git config file that carries the auth header.
type clonePlan struct {
	args             []string
	env              map[string]string
	credentialConfig []byte
}

// planClone strips userinfo from the remote. The credential goes into a git
// config file included by path, never into the exec env: WithExecEnv
// persists values into runtime state and logs (see
// ErrSecretDeliveryUnavailable), so the env names only the file.
func planClone(repository sandbox.GitRepositorySpec, proxyEnv map[string]string, credentialDir string) (clonePlan, error) {
	parsed, err := url.Parse(repository.Repo)
	if err != nil {
		return clonePlan{}, fmt.Errorf("parse repository URL: %w", err)
	}
	plan := clonePlan{env: map[string]string{}}
	for key, value := range proxyEnv {
		plan.env[key] = value
	}
	if parsed.User != nil {
		username := parsed.User.Username()
		password, _ := parsed.User.Password()
		credential := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
		plan.credentialConfig = []byte("[http]\n\textraHeader = \"Authorization: Basic " + credential + "\"\n")
		plan.env["GIT_CONFIG_COUNT"] = "1"
		plan.env["GIT_CONFIG_KEY_0"] = "include.path"
		plan.env["GIT_CONFIG_VALUE_0"] = path.Join(credentialDir, "config")
		parsed.User = nil
	}
	destination := repository.Path
	if destination == "" {
		destination = path.Join("/workspace", path.Base(strings.TrimSuffix(parsed.Path, ".git")))
	}
	plan.args = cloneArgs(repository, parsed.String(), destination)
	return plan, nil
}

func cloneRepository(ctx context.Context, live *upstream.Sandbox, repository sandbox.GitRepositorySpec, users []sandbox.LinuxUserSpec, proxyEnv map[string]string) error {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return fmt.Errorf("clone credential nonce: %w", err)
	}
	credentialDir := "/tmp/plue-git-credential-" + hex.EncodeToString(nonce)
	plan, err := planClone(repository, proxyEnv, credentialDir)
	if err != nil {
		return err
	}
	cloneUser := ""
	if len(users) > 0 && users[0].Name != "" {
		cloneUser = users[0].Name
	}
	if plan.credentialConfig != nil {
		// A 0700 directory owned by the clone user fences the file from every
		// other guest user whatever mode FS().Write gives it.
		prepare := "umask 077 && mkdir " + shellQuote(credentialDir)
		if cloneUser != "" {
			prepare += " && chown " + shellQuote(cloneUser) + " " + shellQuote(credentialDir)
		}
		if err := shellSuccess(ctx, live, prepare); err != nil {
			return fmt.Errorf("prepare clone credential: %w", err)
		}
		defer func() {
			_ = shellSuccess(context.WithoutCancel(ctx), live, "rm -rf "+shellQuote(credentialDir))
		}()
		if err := live.FS().Write(ctx, plan.env["GIT_CONFIG_VALUE_0"], plan.credentialConfig); err != nil {
			return fmt.Errorf("write clone credential: %w", err)
		}
	}
	if err := ensureGuestParent(ctx, live, plan.args[len(plan.args)-1]); err != nil {
		return err
	}
	options := []upstream.ExecOption{upstream.WithExecEnv(plan.env), upstream.WithExecTimeout(10 * time.Minute)}
	if cloneUser != "" {
		options = append(options, upstream.WithExecUser(cloneUser))
	}
	output, err := live.Exec(ctx, "git", plan.args, options...)
	if err != nil {
		return fmt.Errorf("clone repository: %w", err)
	}
	if !output.Success() {
		return fmt.Errorf("clone repository exited %d: %s", output.ExitCode(), truncate(output.Stderr(), 2048))
	}
	return nil
}

// cloneArgs builds the guest `git clone` argument list. The history window is
// bounded by default (see sandbox.ResolveCloneDepth): a guest reads at most the
// coding flows' 100-commit window, and `git fetch --deepen` recovers more on
// demand, so paying for a full-history clone on every boot is pure latency.
func cloneArgs(repository sandbox.GitRepositorySpec, remote, destination string) []string {
	args := []string{"clone"}
	if depth := sandbox.ResolveCloneDepth(repository.Depth); depth > 0 {
		args = append(args, "--depth", strconv.Itoa(depth))
	}
	if repository.Rev != "" {
		args = append(args, "--branch", repository.Rev)
	}
	return append(args, "--", remote, destination)
}

func startService(ctx context.Context, live *upstream.Sandbox, service sandbox.ServiceSpec) error {
	if len(service.Exec) == 0 {
		return errors.New("service exec is required")
	}
	logPath := "/tmp/plue-service-" + safeName(service.Name) + ".log"
	command, timeout := serviceLaunchCommand(service, logPath)
	options := []upstream.ExecOption{upstream.WithExecEnv(service.Env), upstream.WithExecTimeout(timeout)}
	if service.Workdir != "" {
		options = append(options, upstream.WithExecCwd(service.Workdir))
	}
	if service.User != "" {
		options = append(options, upstream.WithExecUser(service.User))
	}
	output, err := live.Shell(ctx, command, options...)
	if err != nil {
		return fmt.Errorf("start service %s: %w", service.Name, err)
	}
	if !output.Success() {
		return fmt.Errorf("start service %s exited %d: %s", service.Name, output.ExitCode(), truncate(output.Stderr(), 2048))
	}
	return nil
}

func serviceLaunchCommand(service sandbox.ServiceSpec, logPath string) (string, time.Duration) {
	command := strings.Join(service.Exec, " ")
	if service.ReadySignal != nil && *service.ReadySignal {
		// A ready-signal service is the provider's boot barrier. Run it in the
		// foreground so Create/Start returns only after the service's own
		// readiness probe succeeds (or fails with its captured stderr).
		return "exec " + command, 2 * time.Minute
	}
	background := "setsid /bin/sh -lc " + shellQuote("exec "+command) + " >>" + shellQuote(logPath) + " 2>&1 </dev/null &"
	return background, 30 * time.Second
}

func ensureGuestParent(ctx context.Context, live *upstream.Sandbox, guestPath string) error {
	parent := path.Dir(guestPath)
	if parent == "." || parent == "/" {
		return nil
	}
	return live.FS().Mkdir(ctx, parent)
}

func shellSuccess(ctx context.Context, live *upstream.Sandbox, command string) error {
	output, err := live.Shell(ctx, command, upstream.WithExecTimeout(2*time.Minute))
	if err != nil {
		return err
	}
	if !output.Success() {
		return fmt.Errorf("guest command exited %d: %s", output.ExitCode(), truncate(output.Stderr(), 2048))
	}
	return nil
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func shellJoin(values []string) string {
	quoted := make([]string, len(values))
	for index, value := range values {
		quoted[index] = shellQuote(value)
	}
	return strings.Join(quoted, " ")
}

func positiveInt32(value *int32, fallback int32) int32 {
	if value != nil && *value > 0 {
		return *value
	}
	return fallback
}

func positiveInt64(value *int64, fallback int64) int64 {
	if value != nil && *value > 0 {
		return *value
	}
	return fallback
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func safeName(value string) string {
	if value == "" {
		return "service"
	}
	var result strings.Builder
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '-' || character == '_' {
			result.WriteRune(character)
		}
	}
	if result.Len() == 0 {
		return "service"
	}
	return result.String()
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// isGoogleRegistryImage reports whether ref points at Google Artifact Registry
// or Container Registry, the registries whose private images need an OAuth
// token rather than anonymous access.
func isGoogleRegistryImage(ref string) bool {
	host := ref
	if slash := strings.IndexByte(host, '/'); slash >= 0 {
		host = host[:slash]
	}
	host = strings.ToLower(host)
	return host == "gcr.io" ||
		strings.HasSuffix(host, ".gcr.io") ||
		strings.HasSuffix(host, ".pkg.dev")
}

// googleRegistryAuth returns registry credentials for a Google-hosted private
// image, or nil when the image is not Google-hosted or no ambient credentials
// are available. It uses Application Default Credentials (Workload Identity on
// GKE), so the token carries whatever roles the pod's service account holds.
func googleRegistryAuth(ctx context.Context, image string) *upstream.RegistryAuth {
	if !isGoogleRegistryImage(image) {
		return nil
	}
	source, err := google.DefaultTokenSource(ctx, "https://www.googleapis.com/auth/cloud-platform")
	if err != nil {
		slog.Warn("Microsandbox registry auth: no Google default credentials; pulling anonymously", "image", image, "error", err)
		return nil
	}
	token, err := source.Token()
	if err != nil || token == nil || strings.TrimSpace(token.AccessToken) == "" {
		slog.Warn("Microsandbox registry auth: could not mint Google access token; pulling anonymously", "image", image, "error", err)
		return nil
	}
	return &upstream.RegistryAuth{Username: "oauth2accesstoken", Password: token.AccessToken}
}

var _ Runtime = (*SDKRuntime)(nil)

// RevokeEgress is the worker-side revocation hook: it stops the sandbox's
// egress proxy at once and leaves the guest running behind its default-deny
// firewall. A sandbox without a proxy reports Revoked=false, which is the goal
// state already holding rather than an error.
func (r *SDKRuntime) RevokeEgress(_ context.Context, id string, req sandbox.EgressRevokeRequest) (sandbox.EgressRevokeResult, error) {
	result := sandbox.EgressRevokeResult{SandboxID: id}
	if r.egress == nil {
		return result, nil
	}
	_, live := r.egress.Endpoint(id)
	r.egress.Revoke(id, req.Reason)
	result.Revoked = live
	return result, nil
}
