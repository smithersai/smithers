package microsandbox

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

const (
	defaultContainerRootfsSizeMB = int64(2 * 1024)
	defaultVMRootfsSizeMB        = int64(4 * 1024)
	defaultDesktopRootfsSizeMB   = int64(8 * 1024)
)

// DefaultRootfsSizeMB is the writable upper-layer reservation for a sandbox.
// Immutable image layers are shared by the worker cache and accounted from
// physical filesystem usage, so they must not be charged to every sandbox.
func DefaultRootfsSizeMB(kind string) int64 {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "desktop":
		return defaultDesktopRootfsSizeMB
	case "vm":
		return defaultVMRootfsSizeMB
	default:
		return defaultContainerRootfsSizeMB
	}
}

const (
	PlacementGenerationHeader = "X-Plue-Placement-Generation"
	WorkerIDHeader            = "X-Plue-Worker-ID"
	SSHGuestUserHeader        = "X-Plue-SSH-Guest-User"
	// WorkerCapabilityAllocationExcludesStoppedCompute tells the controller that
	// the heartbeat's Allocated aggregate omits stopped guests from CPU, memory,
	// and VM-slot totals. Retained disk remains reported. During a rolling deploy
	// an older worker still includes stopped compute, so admission must use this
	// signal before discounting released reservations from the observed safety net.
	WorkerCapabilityAllocationExcludesStoppedCompute = "allocation_excludes_stopped_compute"
	// WorkerCapabilityEgressProxy advertises that the worker can run a
	// per-sandbox credential-substituting egress proxy (iron-proxy).
	WorkerCapabilityEgressProxy = "egress_proxy"
)

type WorkerCapacity struct {
	CPUMillis   int64 `json:"cpu_millis"`
	MemoryBytes int64 `json:"memory_bytes"`
	DiskBytes   int64 `json:"disk_bytes"`
	VMs         int32 `json:"vms"`
}

type WorkerHeartbeat struct {
	WorkerID        string                `json:"worker_id"`
	BootID          string                `json:"boot_id"`
	BaseURL         string                `json:"base_url"`
	State           string                `json:"state"`
	Capacity        WorkerCapacity        `json:"capacity"`
	Allocated       WorkerCapacity        `json:"allocated"`
	Capabilities    map[string]bool       `json:"capabilities"`
	RuntimeVersion  string                `json:"runtime_version"`
	WorkerImage     string                `json:"worker_image"`
	LeaseTTL        time.Duration         `json:"-"`
	LeaseTTLSeconds int64                 `json:"lease_ttl_seconds"`
	Inventory       []WorkerInventoryItem `json:"inventory,omitempty"`
	// IdentityPublicKey and IdentitySignature bind a durable worker identity to
	// every mutable heartbeat field. The mTLS certificate authenticates the
	// worker workload class; this per-node key prevents one compromised worker
	// from taking over another worker's ID and base URL.
	IdentityPublicKey []byte    `json:"identity_public_key"`
	IdentitySignature []byte    `json:"identity_signature"`
	IdentitySignedAt  time.Time `json:"identity_signed_at"`
}

// SignWorkerHeartbeat signs the canonical JSON representation of a heartbeat
// with its signature field cleared. encoding/json deterministically orders map
// keys, so controller and worker produce the same payload.
func SignWorkerHeartbeat(heartbeat *WorkerHeartbeat, privateKey ed25519.PrivateKey) error {
	if heartbeat == nil {
		return errors.New("worker heartbeat is required")
	}
	if len(privateKey) != ed25519.PrivateKeySize {
		return errors.New("worker identity private key is invalid")
	}
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok {
		return errors.New("worker identity public key is invalid")
	}
	heartbeat.IdentityPublicKey = append(heartbeat.IdentityPublicKey[:0], publicKey...)
	heartbeat.IdentitySignature = nil
	heartbeat.IdentitySignedAt = time.Now().UTC()
	payload, err := json.Marshal(heartbeat)
	if err != nil {
		return err
	}
	heartbeat.IdentitySignature = ed25519.Sign(privateKey, payload)
	return nil
}

// VerifyWorkerHeartbeatFresh rejects captured signed heartbeats after the
// authorization lease window, preventing indefinite replay of stale routing
// or inventory. A small future allowance accommodates bounded clock skew.
func VerifyWorkerHeartbeatFresh(heartbeat WorkerHeartbeat, now time.Time, maxAge, maxFutureSkew time.Duration) error {
	if heartbeat.IdentitySignedAt.IsZero() {
		return errors.New("worker heartbeat signing time is missing")
	}
	if maxAge <= 0 {
		maxAge = 45 * time.Second
	}
	if maxFutureSkew < 0 {
		maxFutureSkew = 0
	}
	if heartbeat.IdentitySignedAt.Before(now.Add(-maxAge)) {
		return errors.New("worker heartbeat identity proof expired")
	}
	if heartbeat.IdentitySignedAt.After(now.Add(maxFutureSkew)) {
		return errors.New("worker heartbeat identity proof is from the future")
	}
	return nil
}

// VerifyWorkerHeartbeat proves that the worker which first enrolled an ID is
// still the author of its current routing and inventory declaration.
func VerifyWorkerHeartbeat(heartbeat WorkerHeartbeat) error {
	if len(heartbeat.IdentityPublicKey) != ed25519.PublicKeySize ||
		len(heartbeat.IdentitySignature) != ed25519.SignatureSize {
		return errors.New("worker heartbeat identity proof is invalid")
	}
	signature := append([]byte(nil), heartbeat.IdentitySignature...)
	heartbeat.IdentitySignature = nil
	payload, err := json.Marshal(heartbeat)
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(heartbeat.IdentityPublicKey), payload, signature) {
		return errors.New("worker heartbeat identity signature is invalid")
	}
	return nil
}

type WorkerInventoryItem struct {
	SandboxID  string `json:"sandbox_id"`
	Generation int64  `json:"generation"`
	State      string `json:"state,omitempty"`
}

type WorkerHeartbeatResponse struct {
	Accepted         bool                   `json:"accepted"`
	State            string                 `json:"state"`
	Authorized       bool                   `json:"authorized"`
	AdmitNew         bool                   `json:"admit_new"`
	DeleteOrphans    []WorkerInventoryItem  `json:"delete_orphans,omitempty"`
	DiskGCProtection WorkerDiskGCProtection `json:"disk_gc_protection"`
	// IdentityRotated reports that this heartbeat re-bound the durable worker
	// ID to a new identity key. That only happens when a worker re-registers
	// after losing its per-node key (a node relocation) and the previous
	// key's lease has long expired; both sides log it so an identity handover
	// is always visible in controller and worker logs.
	IdentityRotated bool `json:"identity_rotated,omitempty"`
}

// WorkerDiskGCProtection is the controller-authoritative set of host-local
// artifacts that cache maintenance must retain. Images are registry references;
// snapshots are provider-local names on the heartbeat's worker.
type WorkerDiskGCProtection struct {
	Images    []string `json:"images,omitempty"`
	Snapshots []string `json:"snapshots,omitempty"`
}

// SandboxEgressAuditRecord is the bounded, value-free projection a worker
// derives from one iron-proxy request audit line. It intentionally excludes
// headers, bodies, query strings, and transformed values.
type SandboxEgressAuditRecord struct {
	SandboxID          string          `json:"sandbox_id"`
	OccurredAt         time.Time       `json:"occurred_at"`
	Host               string          `json:"host"`
	Method             string          `json:"method"`
	Path               string          `json:"path"`
	Status             int32           `json:"status"`
	Allowed            bool            `json:"allowed"`
	SwappedSecretNames []string        `json:"swapped_secret_names"`
	TransformSummary   json.RawMessage `json:"transform_summary"`
}

type WorkerEgressAuditBatch struct {
	WorkerID string                     `json:"worker_id"`
	Records  []SandboxEgressAuditRecord `json:"records"`
}

type WorkerEgressAuditResponse struct {
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
}

type WorkerCreateRequest struct {
	SandboxID        string                `json:"sandbox_id"`
	Generation       int64                 `json:"generation"`
	ReuseStoppedDisk bool                  `json:"reuse_stopped_disk,omitempty"`
	Request          sandbox.CreateRequest `json:"request"`
}

type WorkerForkRequest struct {
	SandboxID       string              `json:"sandbox_id"`
	Generation      int64               `json:"generation"`
	SourceSandboxID string              `json:"source_sandbox_id"`
	Request         sandbox.ForkRequest `json:"request"`
}

type WorkerSnapshotRequest struct {
	SnapshotID string                  `json:"snapshot_id"`
	Generation int64                   `json:"generation"`
	Request    sandbox.SnapshotRequest `json:"request"`
}

type SnapshotTransferMetadata struct {
	SnapshotID string `json:"snapshot_id"`
	Digest     string `json:"digest"`
	SizeBytes  int64  `json:"size_bytes"`
}

type WorkerCreateSnapshotRequest struct {
	SnapshotID string                        `json:"snapshot_id"`
	Generation int64                         `json:"generation"`
	Request    sandbox.CreateSnapshotRequest `json:"request"`
	Image      string                        `json:"image"`
}

type AccessValidationRequest struct {
	SandboxID string `json:"sandbox_id"`
	Token     string `json:"token"`
	User      string `json:"user"`
	Protocol  string `json:"protocol"`
}

type AccessValidationResponse struct {
	Allowed    bool      `json:"allowed"`
	SandboxID  string    `json:"sandbox_id,omitempty"`
	WorkerID   string    `json:"worker_id,omitempty"`
	WorkerURL  string    `json:"worker_url,omitempty"`
	LocalID    string    `json:"local_id,omitempty"`
	Generation int64     `json:"generation,omitempty"`
	ExpiresAt  time.Time `json:"expires_at,omitempty"`
}

type PreviewTarget struct {
	Domain     string `json:"domain"`
	SandboxID  string `json:"sandbox_id"`
	WorkerID   string `json:"worker_id"`
	WorkerURL  string `json:"worker_url"`
	LocalID    string `json:"local_id"`
	Generation int64  `json:"generation"`
	GuestPort  int32  `json:"guest_port"`
	State      string `json:"state"`
}

type ProviderError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

type ErrorEnvelope struct {
	Error ProviderError `json:"error"`
}

// SanitizeCreateRequest removes operation-scoped credentials before a request
// is written to controller state. The original request is still forwarded once
// over mTLS to the selected worker.
func SanitizeCreateRequest(request sandbox.CreateRequest) json.RawMessage {
	request.Files = redactFiles(request.Files)
	request.Git = sanitizeGitOptions(request.Git)
	request.GitRepos = sanitizeGitRepositories(request.GitRepos)
	request.EgressProxy = sanitizeEgressProxy(request.EgressProxy)
	if request.Template != nil {
		template := *request.Template
		template.Files = redactFiles(template.Files)
		template.Git = sanitizeGitOptions(template.Git)
		template.GitRepos = sanitizeGitRepositories(template.GitRepos)
		if template.Init != nil {
			systemd := *template.Init
			systemd.Services = append([]sandbox.ServiceSpec(nil), template.Init.Services...)
			for index := range systemd.Services {
				systemd.Services[index].Env = redactEnvironment(systemd.Services[index].Env)
			}
			template.Init = &systemd
		}
		request.Template = &template
	}
	if request.Init != nil {
		systemd := *request.Init
		systemd.Services = append([]sandbox.ServiceSpec(nil), request.Init.Services...)
		for index := range systemd.Services {
			systemd.Services[index].Env = redactEnvironment(systemd.Services[index].Env)
		}
		request.Init = &systemd
	}
	payload, _ := json.Marshal(request)
	return payload
}

// SanitizeServiceSpec retains the non-secret declaration needed to restore a
// service after disk-only recovery while ensuring environment values never
// enter durable controller state.
func SanitizeServiceSpec(service sandbox.ServiceSpec) json.RawMessage {
	service.Env = redactEnvironment(service.Env)
	payload, _ := json.Marshal(service)
	return payload
}

// sanitizeEgressProxy keeps the durable, non-secret binding declaration
// (names, hosts, locations) and drops every value. The worker consumed the
// values into its proxy process; recovery cannot replay them and must not
// pretend it can.
func sanitizeEgressProxy(policy *sandbox.EgressProxyPolicy) *sandbox.EgressProxyPolicy {
	if policy == nil {
		return nil
	}
	sanitized := *policy
	sanitized.Secrets = append([]sandbox.EgressProxySecret(nil), policy.Secrets...)
	for index := range sanitized.Secrets {
		if sanitized.Secrets[index].Value != "" {
			sanitized.Secrets[index].Value = "[redacted]"
		}
	}
	return &sanitized
}

func redactFiles(files map[string]sandbox.SandboxFile) map[string]sandbox.SandboxFile {
	if len(files) == 0 {
		return nil
	}
	redacted := make(map[string]sandbox.SandboxFile, len(files))
	for path, file := range files {
		file.Content = "[redacted]"
		redacted[path] = file
	}
	return redacted
}

func sanitizeGitOptions(options *sandbox.GitOptions) *sandbox.GitOptions {
	if options == nil {
		return nil
	}
	copy := *options
	copy.Repos = sanitizeGitRepositories(options.Repos)
	return &copy
}

func sanitizeGitRepositories(repositories []sandbox.GitRepositorySpec) []sandbox.GitRepositorySpec {
	result := append([]sandbox.GitRepositorySpec(nil), repositories...)
	for index := range result {
		result[index].Repo = redactURLUserInfo(result[index].Repo)
	}
	return result
}

// redactURLUserInfo hides the userinfo of an HTTP(S) URL. The scheme match is
// case-insensitive and the userinfo ends at the last '@' of the authority, so
// a password holding a raw '@' is still hidden whole.
func redactURLUserInfo(raw string) string {
	for _, marker := range []string{"https://", "http://"} {
		if len(raw) <= len(marker) || !strings.EqualFold(raw[:len(marker)], marker) {
			continue
		}
		rest := raw[len(marker):]
		authority := rest
		if end := strings.IndexAny(rest, "/?#"); end >= 0 {
			authority = rest[:end]
		}
		if at := strings.LastIndexByte(authority, '@'); at >= 0 {
			return raw[:len(marker)] + "[redacted]@" + rest[at+1:]
		}
		return raw
	}
	return raw
}

func redactEnvironment(environment map[string]string) map[string]string {
	if len(environment) == 0 {
		return nil
	}
	redacted := make(map[string]string, len(environment))
	for key := range environment {
		redacted[key] = "[redacted]"
	}
	return redacted
}
