package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/ironproxy"
	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// ErrEgressProxyUnavailable fails a proxy-requiring operation closed: the
// sandbox asked for a credential-substituting egress proxy and this worker
// cannot provide one (no binary, CA, or the process did not come up). The
// guest is never booted with the values as a fallback.
var ErrEgressProxyUnavailable = errors.New("per-sandbox egress proxy is unavailable on this worker")

// EgressProxyConfig configures the worker-side proxy manager.
type EgressProxyConfig struct {
	// Binary is the iron-proxy executable.
	Binary string
	// Dir holds per-sandbox configs and the CA. Use tmpfs (/dev/shm) so the
	// CA key never touches the node disk.
	Dir string
	// MarkerDir persists only sandbox port reservations across worker replacement.
	// Credentials and CA material remain in Dir (tmpfs).
	MarkerDir string
	// BindHost is the host-side address the proxies listen on. Guest traffic
	// to host.microsandbox.internal lands on the host's loopback, so the
	// default 127.0.0.1 keeps every proxy off the pod's cluster-facing IP.
	BindHost string
	// PortRange bounds the per-sandbox tunnel listener ports. iron-proxy's
	// other listeners are always on, so each sandbox also takes
	// port+httpOffset, port+httpsOffset, and port+metricsOffset on the same
	// bind host; the range must leave room for all four.
	PortMin, PortMax int
	CA               ironproxy.CA
	// StartTimeout bounds how long a proxy may take to accept connections.
	StartTimeout time.Duration
	Logger       *slog.Logger
	// AuditBuffer bounds the non-blocking handoff from proxy stdout to the
	// worker's controller delivery loop. AuditDropped receives only a bounded
	// reason label and must itself be non-blocking.
	AuditBuffer  int
	AuditDropped func(reason string)
	// allowCIDRs and upstreamDenyCIDRs are test hooks so an integration test
	// can point the real binary at a loopback upstream. Production leaves
	// them nil and gets the package defaults.
	allowCIDRs        []string
	upstreamDenyCIDRs []string
}

// EgressProxyEndpoint is what the guest side needs: the proxy URL and the
// environment that routes the toolchain through it.
type EgressProxyEndpoint struct {
	Port int
	URL  string
	Env  map[string]string
}

// Listener offsets from the tunnel port. iron-proxy has no switch for its
// transparent HTTP/HTTPS or metrics listeners (verified against 0.49.0):
// unset, they bind :80, :443, and :9090, and :9090 is the worker's own
// metrics server, so every process needs four distinct loopback ports.
const (
	egressHTTPOffset    = 1000
	egressHTTPSOffset   = 2000
	egressMetricsOffset = 3000
)

type egressProxyProcess struct {
	port    int
	cmd     *exec.Cmd
	done    chan struct{}
	exitErr error
	// startedAt is when the proxy was reserved for its sandbox. The runtime
	// only learns about the sandbox after its create completes, so a proxy
	// younger than egressProxyReapGrace is never an orphan.
	startedAt time.Time
}

// egressProxyReapGrace is how long after a proxy starts ReapOrphans treats a
// runtime "not found" as the create still being in flight rather than as a
// vanished guest. Create starts the proxy BEFORE the runtime registers the
// sandbox (the guest boots with the proxy endpoint), so a reaper tick landing
// in that window used to stop the proxy under a booting guest, which then had
// no egress at all: every clone failed with "Couldn't connect to server".
const egressProxyReapGrace = 3 * time.Minute

// EgressProxyManager spawns and supervises one iron-proxy process per
// sandbox. Secret values enter only the child's environment; the manager
// keeps nothing but the port and the process handle.
type EgressProxyManager struct {
	config  EgressProxyConfig
	caCert  string
	caKey   string
	mu      sync.Mutex
	procs   map[string]*egressProxyProcess
	markers string
	// revoked records sandboxes whose proxy was torn down by an authorization
	// revocation (agent session cancelled, credential withdrawn). The reason is
	// kept so a later Endpoint or Start can say why the sandbox has no egress
	// instead of failing as an anonymous "proxy unavailable".
	revoked map[string]string
	audit   chan msb.SandboxEgressAuditRecord
}

// NewEgressProxyManager validates the binary and CA and writes the CA to
// config.Dir. It returns an error, never a degraded manager.
func NewEgressProxyManager(config EgressProxyConfig) (*EgressProxyManager, error) {
	if strings.TrimSpace(config.Binary) == "" {
		return nil, fmt.Errorf("%w: iron-proxy binary path is required", ErrEgressProxyUnavailable)
	}
	if info, err := os.Stat(config.Binary); err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
		return nil, fmt.Errorf("%w: iron-proxy binary %s is not executable", ErrEgressProxyUnavailable, config.Binary)
	}
	if len(config.CA.CertPEM) == 0 || len(config.CA.KeyPEM) == 0 {
		return nil, fmt.Errorf("%w: CA material is required", ErrEgressProxyUnavailable)
	}
	if strings.TrimSpace(config.Dir) == "" {
		return nil, fmt.Errorf("%w: proxy state directory is required", ErrEgressProxyUnavailable)
	}
	if config.BindHost == "" {
		config.BindHost = "127.0.0.1"
	}
	if config.PortMin <= 0 || config.PortMax <= 0 || config.PortMax < config.PortMin {
		config.PortMin, config.PortMax = 41000, 41999
	}
	if config.StartTimeout <= 0 {
		config.StartTimeout = 10 * time.Second
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	if config.AuditBuffer <= 0 {
		config.AuditBuffer = 512
	}
	if err := os.MkdirAll(config.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("%w: create proxy state dir: %v", ErrEgressProxyUnavailable, err)
	}
	caCert := filepath.Join(config.Dir, "ca.crt")
	caKey := filepath.Join(config.Dir, "ca.key")
	if err := os.WriteFile(caCert, config.CA.CertPEM, 0o600); err != nil {
		return nil, fmt.Errorf("%w: write CA certificate: %v", ErrEgressProxyUnavailable, err)
	}
	if err := os.WriteFile(caKey, config.CA.KeyPEM, 0o600); err != nil {
		return nil, fmt.Errorf("%w: write CA key: %v", ErrEgressProxyUnavailable, err)
	}
	markers := config.MarkerDir
	if markers == "" {
		markers = filepath.Join(config.Dir, "sandboxes")
	}
	if err := os.MkdirAll(markers, 0o700); err != nil {
		return nil, fmt.Errorf("%w: create proxy marker dir: %v", ErrEgressProxyUnavailable, err)
	}
	return &EgressProxyManager{
		config: config, caCert: caCert, caKey: caKey,
		procs: map[string]*egressProxyProcess{}, markers: markers,
		audit: make(chan msb.SandboxEgressAuditRecord, config.AuditBuffer),
	}, nil
}

// CACertPEM is the certificate guests must trust.
func (m *EgressProxyManager) CACertPEM() []byte { return m.config.CA.CertPEM }

// Start renders the config for policy, spawns iron-proxy with the secret
// values in its environment, and waits until the listener accepts. A second
// Start for the same sandbox replaces the previous process.
func (m *EgressProxyManager) Start(ctx context.Context, sandboxID string, policy *sandbox.EgressProxyPolicy) (EgressProxyEndpoint, error) {
	return m.start(ctx, sandboxID, policy, 0)
}

// Resume replaces credentials at the retained guest's existing proxy port.
// Its firewall and routing still point at this port after a cold start.
func (m *EgressProxyManager) Resume(ctx context.Context, sandboxID string, policy *sandbox.EgressProxyPolicy) (EgressProxyEndpoint, error) {
	data, err := os.ReadFile(m.markerPath(sandboxID))
	if err != nil {
		return EgressProxyEndpoint{}, ErrEgressProxyUnavailable
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || port < m.config.PortMin || port > m.config.PortMax {
		return EgressProxyEndpoint{}, ErrEgressProxyUnavailable
	}
	return m.start(ctx, sandboxID, policy, port)
}

func (m *EgressProxyManager) start(ctx context.Context, sandboxID string, policy *sandbox.EgressProxyPolicy, port int) (EgressProxyEndpoint, error) {
	if policy == nil || !policy.Enabled {
		return EgressProxyEndpoint{}, fmt.Errorf("%w: policy is not enabled", ErrEgressProxyUnavailable)
	}
	if err := policy.Validate(); err != nil {
		return EgressProxyEndpoint{}, fmt.Errorf("%w: %v", ErrEgressProxyUnavailable, err)
	}
	m.mu.Lock()
	if existing, ok := m.procs[sandboxID]; ok {
		m.stopLocked(sandboxID, existing)
	}
	// A fresh Start re-authorizes the sandbox; clear any earlier revocation.
	delete(m.revoked, sandboxID)
	var err error
	if port == 0 {
		port, err = m.allocatePortLocked()
	} else {
		for otherID, proc := range m.procs {
			if otherID != sandboxID && proc.port == port {
				err = ErrEgressProxyUnavailable
				break
			}
		}
	}
	if err != nil {
		m.mu.Unlock()
		return EgressProxyEndpoint{}, err
	}
	// Reserve the slot before releasing the lock so concurrent creates never
	// race for the same port; a failed spawn frees it below.
	proc := &egressProxyProcess{port: port, done: make(chan struct{}), startedAt: time.Now()}
	m.procs[sandboxID] = proc
	m.mu.Unlock()

	endpoint, err := m.spawn(ctx, sandboxID, proc, policy)
	if err != nil {
		m.mu.Lock()
		if m.procs[sandboxID] == proc {
			delete(m.procs, sandboxID)
		}
		m.mu.Unlock()
		_ = os.RemoveAll(m.sandboxDir(sandboxID))
		return EgressProxyEndpoint{}, err
	}
	if err := os.WriteFile(m.markerPath(sandboxID), []byte(strconv.Itoa(port)+"\n"), 0o600); err != nil {
		m.Stop(sandboxID)
		return EgressProxyEndpoint{}, fmt.Errorf("%w: persist proxy marker: %v", ErrEgressProxyUnavailable, err)
	}
	return endpoint, nil
}

func egressProxySecretBindings(secrets []sandbox.EgressProxySecret) ([]ironproxy.SecretBinding, []string) {
	bindings := make([]ironproxy.SecretBinding, 0, len(secrets))
	env := make([]string, 0, len(secrets)+1)
	for i, secret := range secrets {
		name := strings.TrimSpace(secret.Name)
		// Secret names are tenant input, never process configuration keys.
		// In particular HTTPS_PROXY and IRON_* can bypass dial-time policy.
		envName := fmt.Sprintf("SMITHERS_EGRESS_SECRET_%d", i)
		// Require stays off. iron-proxy evaluates the guest's CONNECT (the
		// explicit-proxy handshake every HTTPS request starts with) against
		// the secrets transform, and a CONNECT carries no headers, so
		// `require: true` rejects every tunnel to a bound host with 403
		// before the real request exists. Verified against iron-proxy 0.49.0.
		bindings = append(bindings, ironproxy.SecretBinding{
			EnvVar: envName, ProxyValue: sandbox.EgressProxyPlaceholder(name),
			Hosts: secret.Hosts, MatchHeaders: secret.MatchHeaders,
			MatchQuery: secret.MatchQuery, MatchPath: secret.MatchPath, Require: false,
		})
		env = append(env, envName+"="+secret.Value)
	}
	return bindings, env
}

func (m *EgressProxyManager) spawn(ctx context.Context, sandboxID string, proc *egressProxyProcess, policy *sandbox.EgressProxyPolicy) (EgressProxyEndpoint, error) {
	listen := net.JoinHostPort(m.config.BindHost, strconv.Itoa(proc.port))
	httpListen := net.JoinHostPort(m.config.BindHost, strconv.Itoa(proc.port+egressHTTPOffset))
	httpsListen := net.JoinHostPort(m.config.BindHost, strconv.Itoa(proc.port+egressHTTPSOffset))
	metricsListen := net.JoinHostPort(m.config.BindHost, strconv.Itoa(proc.port+egressMetricsOffset))
	bindings, env := egressProxySecretBindings(policy.Secrets)
	sort.Strings(env)
	env = append(env, "PATH=/usr/local/bin:/usr/bin:/bin", "HOME="+m.config.Dir)
	config, err := ironproxy.RenderYAML(ironproxy.Spec{
		ListenAddr: listen, HTTPListen: httpListen, HTTPSListen: httpsListen, MetricsListen: metricsListen,
		CACertPath: m.caCert, CAKeyPath: m.caKey,
		AllowDomains: policy.AllowDomains, AllowCIDRs: m.config.allowCIDRs,
		UpstreamDenyCIDRs: m.config.upstreamDenyCIDRs, Secrets: bindings,
	})
	if err != nil {
		return EgressProxyEndpoint{}, fmt.Errorf("%w: render config: %v", ErrEgressProxyUnavailable, err)
	}
	dir := m.sandboxDir(sandboxID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return EgressProxyEndpoint{}, fmt.Errorf("%w: create proxy dir: %v", ErrEgressProxyUnavailable, err)
	}
	configPath := filepath.Join(dir, "proxy.yaml")
	if err := os.WriteFile(configPath, config, 0o600); err != nil {
		return EgressProxyEndpoint{}, fmt.Errorf("%w: write proxy config: %v", ErrEgressProxyUnavailable, err)
	}

	// The child is deliberately detached from ctx: a create request's
	// cancellation must not kill a proxy that a live guest already depends on.
	cmd := exec.Command(m.config.Binary, "-config", configPath)
	cmd.Env = env
	cmd.Dir = dir
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return EgressProxyEndpoint{}, fmt.Errorf("%w: attach proxy stdout: %v", ErrEgressProxyUnavailable, err)
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return EgressProxyEndpoint{}, fmt.Errorf("%w: start iron-proxy: %v", ErrEgressProxyUnavailable, err)
	}
	proc.cmd = cmd
	logger := m.config.Logger.With("sandbox_id", sandboxID, "egress_proxy_port", proc.port)
	go m.relayLogs(logger, sandboxID, stdout)
	go func() {
		proc.exitErr = cmd.Wait()
		close(proc.done)
		if proc.exitErr != nil {
			logger.Warn("egress proxy exited", "error", proc.exitErr)
		}
	}()

	if err := m.waitListening(ctx, listen, proc); err != nil {
		m.Stop(sandboxID)
		return EgressProxyEndpoint{}, err
	}
	logger.Info("egress proxy ready", "bindings", len(bindings), "allow_domains", len(policy.AllowDomains))
	return EgressProxyEndpoint{
		Port: proc.port,
		URL:  ironproxy.GuestProxyURL(proc.port),
		Env:  ironproxy.GuestEnv(ironproxy.GuestProxyURL(proc.port), sandbox.EgressProxyCAGuestPath),
	}, nil
}

func (m *EgressProxyManager) waitListening(ctx context.Context, listen string, proc *egressProxyProcess) error {
	deadline := time.Now().Add(m.config.StartTimeout)
	for {
		select {
		case <-proc.done:
			return fmt.Errorf("%w: iron-proxy exited before listening: %v", ErrEgressProxyUnavailable, proc.exitErr)
		case <-ctx.Done():
			return fmt.Errorf("%w: %v", ErrEgressProxyUnavailable, ctx.Err())
		default:
		}
		conn, err := net.DialTimeout("tcp", listen, 250*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%w: iron-proxy did not listen on %s within %s", ErrEgressProxyUnavailable, listen, m.config.StartTimeout)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// relayLogs forwards iron-proxy's JSON audit lines into the worker log. The
// proxy never prints credential values (that is an upstream invariant we
// rely on), but the relay redacts bearer/basic-shaped tokens anyway.
func (m *EgressProxyManager) relayLogs(logger *slog.Logger, sandboxID string, reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		logger.Info("egress proxy", "line", redactCredentialShapes(line))
		record, err := parseEgressAuditRecord(sandboxID, []byte(line))
		if err != nil {
			continue
		}
		select {
		case m.audit <- record:
		default:
			if m.config.AuditDropped != nil {
				m.config.AuditDropped("backpressure")
			}
		}
	}
}

// AuditRecords exposes the bounded, non-blocking proxy-audit handoff. There is
// exactly one worker delivery loop consuming it.
func (m *EgressProxyManager) AuditRecords() <-chan msb.SandboxEgressAuditRecord {
	if m == nil {
		return nil
	}
	return m.audit
}

type ironProxyAuditEnvelope struct {
	Time  json.RawMessage `json:"time"`
	Msg   string          `json:"msg"`
	Audit struct {
		Host               string          `json:"host"`
		Method             string          `json:"method"`
		Path               string          `json:"path"`
		URL                string          `json:"url"`
		Status             int32           `json:"status"`
		StatusCode         int32           `json:"status_code"`
		Allowed            *bool           `json:"allowed"`
		Decision           string          `json:"decision"`
		Action             string          `json:"action"`
		RequestTransforms  json.RawMessage `json:"request_transforms"`
		ResponseTransforms json.RawMessage `json:"response_transforms"`
	} `json:"audit"`
}

const (
	maxEgressAuditHost = 253
	maxEgressAuditPath = 2048
	maxSwappedSecrets  = 64
)

func parseEgressAuditRecord(sandboxID string, line []byte) (msb.SandboxEgressAuditRecord, error) {
	var envelope ironProxyAuditEnvelope
	if len(line) == 0 || len(line) > 1<<20 || json.Unmarshal(line, &envelope) != nil || envelope.Msg != "request" {
		return msb.SandboxEgressAuditRecord{}, errors.New("not a proxy request audit record")
	}
	host := strings.ToLower(strings.TrimSpace(envelope.Audit.Host))
	method := strings.ToUpper(strings.TrimSpace(envelope.Audit.Method))
	if sandboxID == "" || host == "" || len(host) > maxEgressAuditHost || method == "" || len(method) > 16 {
		return msb.SandboxEgressAuditRecord{}, errors.New("proxy request audit record has invalid identity fields")
	}
	path := strings.TrimSpace(envelope.Audit.Path)
	if path == "" {
		path = strings.TrimSpace(envelope.Audit.URL)
	}
	path = stripAuditQuery(path)
	if len(path) > maxEgressAuditPath {
		path = path[:maxEgressAuditPath]
	}
	status := envelope.Audit.Status
	if status == 0 {
		status = envelope.Audit.StatusCode
	}
	if status < 0 || status > 999 {
		return msb.SandboxEgressAuditRecord{}, errors.New("proxy request audit record has invalid status")
	}
	allowed := status > 0 && status < 400
	if envelope.Audit.Allowed != nil {
		allowed = *envelope.Audit.Allowed
	} else if decision := strings.ToLower(strings.TrimSpace(envelope.Audit.Decision)); decision != "" {
		allowed = decision == "allow" || decision == "allowed"
	} else if action := strings.ToLower(strings.TrimSpace(envelope.Audit.Action)); action != "" {
		allowed = action == "allow" || action == "allowed" || action == "warn"
	}
	names, requestTransformCount, pathSwapped := auditTransformProjection(envelope.Audit.RequestTransforms)
	_, responseTransformCount, _ := auditTransformProjection(envelope.Audit.ResponseTransforms)
	if pathSwapped {
		path = "/[redacted]"
	}
	if len(names) > maxSwappedSecrets {
		names = names[:maxSwappedSecrets]
	}
	summary, _ := json.Marshal(map[string]any{
		"request_transform_count":  requestTransformCount,
		"response_transform_count": responseTransformCount,
		"swapped_secret_count":     len(names),
	})
	return msb.SandboxEgressAuditRecord{
		SandboxID: sandboxID, OccurredAt: parseAuditTime(envelope.Time), Host: host,
		Method: method, Path: path, Status: status, Allowed: allowed,
		SwappedSecretNames: names, TransformSummary: summary,
	}, nil
}

func stripAuditQuery(raw string) string {
	if parsed, err := url.Parse(raw); err == nil {
		if parsed.Path != "" {
			if parsed.RawPath != "" {
				return parsed.EscapedPath()
			}
			return parsed.Path
		}
	}
	if before, _, found := strings.Cut(raw, "?"); found {
		return before
	}
	return raw
}

func parseAuditTime(raw json.RawMessage) time.Time {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
			return parsed.UTC()
		}
	}
	var number float64
	if json.Unmarshal(raw, &number) == nil && number > 0 {
		seconds := int64(number)
		nanos := int64((number - float64(seconds)) * float64(time.Second))
		if seconds > 10_000_000_000 {
			milliseconds := seconds
			seconds, nanos = milliseconds/1000, (milliseconds%1000)*int64(time.Millisecond)
		}
		return time.Unix(seconds, nanos).UTC()
	}
	return time.Now().UTC()
}

func auditTransformProjection(raw json.RawMessage) ([]string, int, bool) {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return []string{}, 0, false
	}
	seen := map[string]struct{}{}
	pathSwapped := false
	projectTransform := func(transform map[string]any) {
		annotations, ok := transform["annotations"].(map[string]any)
		if !ok {
			return
		}
		swapped, ok := annotations["swapped"].([]any)
		if !ok {
			return
		}
		for _, item := range swapped {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if secret, ok := entry["secret"].(string); ok && validAuditSecretName(secret) {
				seen[secret] = struct{}{}
			}
			if locations, ok := entry["locations"].([]any); ok {
				for _, rawLocation := range locations {
					location, ok := rawLocation.(string)
					if ok && strings.HasPrefix(strings.ToLower(location), "path") {
						pathSwapped = true
					}
				}
			}
		}
	}
	transformCount := 0
	switch transforms := value.(type) {
	case map[string]any:
		transformCount = len(transforms)
		for _, rawTransform := range transforms {
			if transform, ok := rawTransform.(map[string]any); ok {
				projectTransform(transform)
			}
		}
	case []any:
		for _, rawTransform := range transforms {
			transform, ok := rawTransform.(map[string]any)
			if !ok {
				continue
			}
			transformCount++
			projectTransform(transform)
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, transformCount, pathSwapped
}

func validAuditSecretName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for index, char := range name {
		if !((char >= 'A' && char <= 'Z') || (index > 0 && char >= '0' && char <= '9') || (index > 0 && char == '_')) {
			return false
		}
	}
	return true
}

// Endpoint returns the live proxy for sandboxID.
func (m *EgressProxyManager) Endpoint(sandboxID string) (EgressProxyEndpoint, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	proc, ok := m.procs[sandboxID]
	if !ok {
		return EgressProxyEndpoint{}, false
	}
	select {
	case <-proc.done:
		return EgressProxyEndpoint{}, false
	default:
	}
	url := ironproxy.GuestProxyURL(proc.port)
	return EgressProxyEndpoint{Port: proc.port, URL: url, Env: ironproxy.GuestEnv(url, sandbox.EgressProxyCAGuestPath)}, true
}

// Required reports whether sandboxID was created with an egress proxy. It
// survives a worker restart (marker on disk) so a resume after restart fails
// closed instead of booting the guest with no egress path and no proxy.
func (m *EgressProxyManager) Required(sandboxID string) bool {
	if _, live := m.Endpoint(sandboxID); live {
		return true
	}
	_, err := os.Stat(m.markerPath(sandboxID))
	return err == nil
}

// Stop terminates the proxy for sandboxID and removes its config and marker.
func (m *EgressProxyManager) Stop(sandboxID string) {
	m.Suspend(sandboxID)
	_ = os.Remove(m.markerPath(sandboxID))
}

// Revoke is the revocation hook: the sandbox's authorization ended (its agent
// session was cancelled, or a credential it was bound to was withdrawn), so
// its proxy is stopped at once and its marker dropped. The guest keeps its
// default-deny firewall, so from this moment it has no egress at all; the
// credential values that lived only in the proxy process are gone with it.
// Nothing else changes: the guest is left for the normal stop or delete path.
func (m *EgressProxyManager) Revoke(sandboxID, reason string) {
	m.mu.Lock()
	if m.revoked == nil {
		m.revoked = map[string]string{}
	}
	m.revoked[sandboxID] = strings.TrimSpace(reason)
	m.mu.Unlock()
	m.Stop(sandboxID)
	m.config.Logger.Info("egress proxy revoked", "sandbox_id", sandboxID, "reason", reason)
}

// Revoked reports whether the sandbox's proxy was torn down by Revoke, and why.
func (m *EgressProxyManager) Revoked(sandboxID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	reason, ok := m.revoked[sandboxID]
	return reason, ok
}

// Suspend terminates the proxy (and its credential-bearing process
// environment) but keeps the marker: the sandbox remains proxy-backed, so a
// later Start fails closed until its secrets are supplied again.
func (m *EgressProxyManager) Suspend(sandboxID string) {
	m.mu.Lock()
	proc, ok := m.procs[sandboxID]
	if ok {
		m.stopLocked(sandboxID, proc)
	}
	m.mu.Unlock()
	_ = os.RemoveAll(m.sandboxDir(sandboxID))
}

func (m *EgressProxyManager) stopLocked(sandboxID string, proc *egressProxyProcess) {
	delete(m.procs, sandboxID)
	if proc.cmd == nil || proc.cmd.Process == nil {
		return
	}
	_ = proc.cmd.Process.Signal(os.Interrupt)
	select {
	case <-proc.done:
	case <-time.After(3 * time.Second):
		_ = proc.cmd.Process.Kill()
		<-proc.done
	}
}

// ReapOrphans stops proxies whose guest is gone. An ephemeral guest that
// exits on its own is removed by the runtime without a Delete or Stop ever
// reaching this worker, and its proxy, credential values in its environment,
// would otherwise outlive it. lookup is the runtime's Get; a not-found error
// forgets the sandbox, a non-running state suspends it (marker kept so a
// later Start still fails closed), and any other error leaves it alone.
func (m *EgressProxyManager) ReapOrphans(ctx context.Context, lookup func(context.Context, string) (sandbox.Sandbox, error)) (stopped, suspended int) {
	m.mu.Lock()
	ids := make([]string, 0, len(m.procs))
	started := make(map[string]time.Time, len(m.procs))
	for id, proc := range m.procs {
		ids = append(ids, id)
		started[id] = proc.startedAt
	}
	m.mu.Unlock()
	for _, id := range ids {
		current, err := lookup(ctx, id)
		switch {
		case err != nil && runtimeNotFound(err) && time.Since(started[id]) < egressProxyReapGrace:
			// Create in flight: the runtime has not registered the guest yet.
			continue
		case err != nil && runtimeNotFound(err):
			m.config.Logger.Info("egress proxy reaped: guest no longer exists", "sandbox_id", id)
			m.Stop(id)
			stopped++
		case err != nil:
			continue
		case current.State != sandbox.StateRunning:
			m.config.Logger.Info("egress proxy suspended: guest is not running", "sandbox_id", id, "state", string(current.State))
			m.Suspend(id)
			suspended++
		}
	}
	return stopped, suspended
}

// StopAll terminates every proxy at worker shutdown, preserving retained guest ports.
func (m *EgressProxyManager) StopAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.procs))
	for id := range m.procs {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Suspend(id)
	}
}

func (m *EgressProxyManager) allocatePortLocked() (int, error) {
	used := make(map[int]struct{}, len(m.procs))
	for _, proc := range m.procs {
		used[proc.port] = struct{}{}
	}
	// Suspended guests retain their firewall's proxy port. Reserve it until
	// deletion so a later resume cannot route traffic to another tenant.
	markers, err := filepath.Glob(filepath.Join(m.markers, "*.port"))
	if err != nil {
		return 0, ErrEgressProxyUnavailable
	}
	for _, marker := range markers {
		data, err := os.ReadFile(marker)
		if err != nil {
			return 0, ErrEgressProxyUnavailable
		}
		port, err := strconv.Atoi(strings.TrimSpace(string(data)))
		if err != nil {
			return 0, ErrEgressProxyUnavailable
		}
		used[port] = struct{}{}
	}
	for port := m.config.PortMin; port <= m.config.PortMax; port++ {
		if _, taken := used[port]; taken {
			continue
		}
		free := true
		for _, candidate := range []int{port, port + egressHTTPOffset, port + egressHTTPSOffset, port + egressMetricsOffset} {
			listener, err := net.Listen("tcp", net.JoinHostPort(m.config.BindHost, strconv.Itoa(candidate)))
			if err != nil {
				free = false
				break
			}
			_ = listener.Close()
		}
		if free {
			return port, nil
		}
	}
	return 0, fmt.Errorf("%w: no free proxy port in %d-%d", ErrEgressProxyUnavailable, m.config.PortMin, m.config.PortMax)
}

func (m *EgressProxyManager) sandboxDir(sandboxID string) string {
	return filepath.Join(m.config.Dir, "sandboxes", safeName(sandboxID))
}

func (m *EgressProxyManager) markerPath(sandboxID string) string {
	return filepath.Join(m.markers, safeName(sandboxID)+".port")
}

func redactCredentialShapes(line string) string {
	fields := strings.Fields(line)
	for index, field := range fields {
		lower := strings.ToLower(field)
		if strings.HasPrefix(lower, "bearer") || strings.HasPrefix(lower, "basic") {
			if index+1 < len(fields) {
				fields[index+1] = "[redacted]"
			}
		}
	}
	return strings.Join(fields, " ")
}

// egressTrustStoreHook installs the proxy CA into a distribution trust store
// when the guest image has one. It is an image-kind hook layered on the
// portable env-bundle path: Ubuntu-derived images have update-ca-certificates;
// a NixOS guest sets security.pki.certificateFiles to the same file and this
// hook is a no-op there. POSIX sh only: the guest may not ship bash.
func egressTrustStoreHook(caPath string) string {
	return "if command -v update-ca-certificates >/dev/null 2>&1 && [ -d /usr/local/share/ca-certificates ]; then " +
		"cp " + shellQuote(caPath) + " /usr/local/share/ca-certificates/smithers-egress.crt && update-ca-certificates >/dev/null 2>&1 || true; fi"
}
