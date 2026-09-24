package control

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/credentialscan"
	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

const (
	// A sandbox create request carries every staged workspace payload inline
	// (smithers CLI ~8 MiB, coding host ~2 MiB, jj export helper ~5.5 MiB, all
	// gzip+base64), so 16 MiB was exceeded the day the third payload landed
	// and every workspace create failed with 413. Keep headroom for the next.
	maxRequestBody = 64 << 20
	grantTTL       = 5 * time.Minute
	identityTTL    = 15 * time.Minute
)

// Reconcile phase budgets. These are vars rather than consts ONLY so tests can
// shrink them; nothing at runtime reassigns them.
var (
	// drainCheckpointTimeout bounds ONE durable recovery checkpoint (worker-side
	// snapshot + streaming export to object storage). Reconcile is strictly
	// serial and its caller ticks it with no per-pass deadline, so before this
	// existed a single wedged upload blocked the entire reconcile loop
	// indefinitely — cleanup, restart and recovery all stopped behind it. That
	// starvation is what pushed workspace provisioning past 240s during the
	// DNS outage, when every export hung until its TCP connection died.
	//
	// A real workspace snapshot is ~140 MB; at a deliberately pessimistic
	// ~2 MB/s sustained that is ~70s, so 3 minutes completes a legitimately slow
	// checkpoint with generous headroom while capping a wedged one. It stays
	// well inside the 10-minute drain claim lease, so a checkpoint killed here
	// is retried on a later pass rather than lost.
	drainCheckpointTimeout = 3 * time.Minute
	// drainPhaseBudget caps the whole drain phase of a single reconcile pass.
	// The per-checkpoint bound alone still allows 10 claims x 3 minutes = 30
	// minutes of drain work ahead of the cleanup/restart/recovery phases, which
	// is its own starvation. Stopping the phase at 5 minutes keeps every phase
	// reachable within a pass; unclaimed drains simply wait for the next tick.
	drainPhaseBudget = 5 * time.Minute
)

type Config struct {
	APIKey                string
	PreviewAPIKey         string
	DefaultImage          string
	DefaultRootfsSizeMB   int64
	HTTPClient            *http.Client
	StreamHTTPClient      *http.Client
	Logger                *slog.Logger
	APIClientIdentity     string
	PreviewClientIdentity string
	WorkerClientIdentity  string
	AllowInsecureDev      bool
	SnapshotStore         SnapshotObjectStore
	BridgeSigner          gossh.Signer
}

type Controller struct {
	store            Store
	apiKey           string
	previewAPIKey    string
	defaultImage     string
	defaultRootfsMB  int64
	httpClient       *http.Client
	streamClient     *http.Client
	logger           *slog.Logger
	apiIdentity      string
	previewIdentity  string
	workerIdentity   string
	allowInsecureDev bool
	snapshotStore    SnapshotObjectStore
	bridgeSigner     gossh.Signer
	recoveryOwner    string
	router           http.Handler
	// now is the wall clock the reconcile phase budgets measure against. It is
	// a field purely so tests can drive those budgets deterministically; New
	// always installs time.Now.
	now func() time.Time
}

func New(store Store, config Config) *Controller {
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = observability.NewHTTPClient(35 * time.Minute)
	}
	streamClient := config.StreamHTTPClient
	if streamClient == nil {
		streamClient = observability.NewHTTPClient(0)
	}
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	defaultRootfsMB := config.DefaultRootfsSizeMB
	controller := &Controller{
		store: store, apiKey: strings.TrimSpace(config.APIKey), previewAPIKey: strings.TrimSpace(config.PreviewAPIKey),
		defaultImage: strings.TrimSpace(config.DefaultImage), defaultRootfsMB: defaultRootfsMB,
		httpClient: httpClient, streamClient: streamClient, logger: logger,
		apiIdentity:      strings.TrimSpace(config.APIClientIdentity),
		previewIdentity:  strings.TrimSpace(config.PreviewClientIdentity),
		workerIdentity:   strings.TrimSpace(config.WorkerClientIdentity),
		allowInsecureDev: config.AllowInsecureDev,
		snapshotStore:    config.SnapshotStore,
		bridgeSigner:     config.BridgeSigner,
		recoveryOwner:    "controller-" + uuid.NewString(),
		now:              time.Now,
	}
	controller.router = controller.routes()
	return controller
}

func (c *Controller) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	c.router.ServeHTTP(writer, request)
}

func (c *Controller) routes() http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	})
	router.With(c.requirePeerIdentity(c.workerIdentity)).Post("/internal/v1/workers/heartbeat", c.handleHeartbeat)
	router.With(c.requirePeerIdentity(c.workerIdentity)).Post("/internal/v1/workers/egress-audit", c.handleEgressAudit)
	router.With(c.requirePeerIdentity(c.apiIdentity)).Post("/internal/v1/access/validate", c.handleValidateAccess)
	router.With(c.requirePeerIdentity(c.previewIdentity), c.requirePreviewAPIKey).Get("/v1/domains/{domain}/port", c.handlePreviewPortStream)

	router.Group(func(api chi.Router) {
		api.Use(c.requirePeerIdentity(c.apiIdentity))
		api.Use(c.requireAPIKey)
		api.Use(c.requireIdempotency)
		api.Post("/v1/sandboxes", c.handleCreateSandbox)
		api.Post("/v1/sandboxes/snapshots", c.handleCreateSnapshot)
		api.Delete("/v1/sandboxes/snapshots/{snapshotID}", c.handleDeleteSnapshot)
		api.Get("/v1/sandboxes/{sandboxID}", c.handleInspectSandbox)
		api.Delete("/v1/sandboxes/{sandboxID}", c.handleDeleteSandbox)
		api.Post("/v1/sandboxes/{sandboxID}/start", c.handleStartSandbox)
		api.Post("/v1/sandboxes/{sandboxID}/stop", c.handleStopSandbox)
		api.Post("/v1/sandboxes/{sandboxID}/suspend", c.handleSuspendSandbox)
		api.Post("/v1/sandboxes/{sandboxID}/egress/revoke", c.handleRevokeEgress)
		api.Delete("/v1/sandboxes/{sandboxID}/access-grants", c.handleRevokeSandboxAccessGrants)
		api.Post("/v1/sandboxes/{sandboxID}/exec", c.handleExecute)
		api.Post("/v1/sandboxes/{sandboxID}/snapshot", c.handleSnapshotSandbox)
		api.Post("/v1/sandboxes/{sandboxID}/fork", c.handleForkSandbox)
		api.Put("/v1/sandboxes/{sandboxID}/files/*", c.handleWriteFile)
		api.Post("/v1/sandboxes/{sandboxID}/services", c.handleCreateService)
		api.Post("/v1/access/identities", c.handleCreateIdentity)
		api.Post("/v1/access/identities/{identityID}/permissions/sandbox/{sandboxID}", c.handleGrantPermission)
		api.Post("/v1/access/identities/{identityID}/tokens", c.handleCreateToken)
		api.Delete("/identity/v1/tokens/{grantID}", c.handleRevokeToken)
		api.Post("/v1/ingress/{domain}", c.handleCreateDomain)
		api.Delete("/v1/ingress/{domain}", c.handleDeleteDomain)
	})
	// SSH grants are the credential on this route, so it intentionally does not
	// use the controller API-key middleware.
	router.With(c.requirePeerIdentity(c.apiIdentity)).Get("/v1/sandboxes/{sandboxID}/ssh", c.handleSSHStream)
	return router
}

func (c *Controller) handleEgressAudit(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, 512<<10)
	var batch msb.WorkerEgressAuditBatch
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&batch); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_egress_audit_batch", "invalid egress audit batch")
		return
	}
	batch.WorkerID = strings.TrimSpace(batch.WorkerID)
	if batch.WorkerID == "" || len(batch.WorkerID) > 200 || len(batch.Records) == 0 || len(batch.Records) > 100 {
		writeError(writer, http.StatusBadRequest, "invalid_egress_audit_batch", "egress audit batch is outside bounded limits")
		return
	}
	accepted := make([]msb.SandboxEgressAuditRecord, 0, len(batch.Records))
	rejected := 0
	for _, record := range batch.Records {
		if !validEgressAuditRecord(record) {
			rejected++
			continue
		}
		payload, err := json.Marshal(record)
		if err != nil || credentialscan.ScanForCredentialMaterial(string(payload)) != nil {
			rejected++
			continue
		}
		accepted = append(accepted, record)
	}
	persisted := int64(0)
	if len(accepted) > 0 {
		var err error
		persisted, err = c.store.InsertEgressAuditBatch(request.Context(), batch.WorkerID, accepted)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
	}
	rejected += len(accepted) - int(persisted)
	writeJSON(writer, http.StatusAccepted, msb.WorkerEgressAuditResponse{Accepted: int(persisted), Rejected: rejected})
}

func validEgressAuditRecord(record msb.SandboxEgressAuditRecord) bool {
	if strings.TrimSpace(record.SandboxID) == "" || len(record.SandboxID) > 200 ||
		record.OccurredAt.IsZero() || strings.TrimSpace(record.Host) == "" || len(record.Host) > 253 ||
		strings.TrimSpace(record.Method) == "" || len(record.Method) > 16 || len(record.Path) > 2048 || strings.Contains(record.Path, "?") ||
		record.Status < 0 || record.Status > 999 || len(record.SwappedSecretNames) > 64 ||
		len(record.TransformSummary) > 16<<10 || !json.Valid(record.TransformSummary) {
		return false
	}
	var summary map[string]any
	if json.Unmarshal(record.TransformSummary, &summary) != nil || summary == nil {
		return false
	}
	for _, name := range record.SwappedSecretNames {
		if !validEgressAuditSecretName(name) {
			return false
		}
	}
	return true
}

func validEgressAuditSecretName(name string) bool {
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

type bufferedResponseWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

type operationContextKey struct{}
type operationContext struct {
	key       string
	operation string
	owner     ResourceOwner
}

func (w *bufferedResponseWriter) Header() http.Header { return w.header }
func (w *bufferedResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *bufferedResponseWriter) Write(payload []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(payload)
}

func (c *Controller) requireIdempotency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet || request.Method == http.MethodHead {
			next.ServeHTTP(writer, request)
			return
		}
		key := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
		if key == "" || len(key) > 200 || strings.IndexFunc(key, unicode.IsSpace) >= 0 {
			writeError(writer, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key header is required")
			return
		}
		payload, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBody+1))
		if err != nil || len(payload) > maxRequestBody {
			writeError(writer, http.StatusRequestEntityTooLarge, "request_too_large", "request body exceeds controller limit")
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(payload))
		operation := request.Method + " " + request.URL.EscapedPath()
		owner, ownerErr := requestResourceOwner(request)
		if ownerErr != nil {
			writeError(writer, http.StatusBadRequest, "invalid_resource_link", ownerErr.Error())
			return
		}
		digestInput := append(append([]byte(operation), 0), []byte(owner.Kind)...)
		digestInput = append(digestInput, 0)
		digestInput = append(digestInput, []byte(owner.ID)...)
		digestInput = append(digestInput, 0)
		digestInput = append(digestInput, payload...)
		hash := sha256.Sum256(digestInput)
		replay, acquired, err := c.store.BeginOperation(request.Context(), key, operation, hex.EncodeToString(hash[:]))
		if err != nil {
			switch {
			case errors.Is(err, ErrIdempotencyConflict):
				writeError(writer, http.StatusConflict, "idempotency_conflict", err.Error())
			case errors.Is(err, ErrOperationInProgress):
				writeError(writer, http.StatusConflict, "operation_in_progress", err.Error())
			default:
				writeStoreError(writer, err)
			}
			return
		}
		if !acquired {
			if !replay.Replayable {
				writeError(writer, http.StatusConflict, "non_replayable_operation", "operation already succeeded; its secret response cannot be replayed")
				return
			}
			if replay.ContentType != "" {
				writer.Header().Set("Content-Type", replay.ContentType)
			}
			for name, values := range replay.Headers {
				writer.Header()[name] = append([]string(nil), values...)
			}
			writer.WriteHeader(replay.StatusCode)
			_, _ = writer.Write(replay.Body)
			return
		}
		request = request.WithContext(context.WithValue(request.Context(), operationContextKey{}, operationContext{
			key: key, operation: operation, owner: owner,
		}))
		buffered := &bufferedResponseWriter{header: make(http.Header)}
		next.ServeHTTP(buffered, request)
		if buffered.status == 0 {
			buffered.status = http.StatusOK
		}
		sensitive := request.Method == http.MethodPost &&
			(strings.HasSuffix(request.URL.Path, "/tokens") || strings.HasSuffix(request.URL.Path, "/exec"))
		stored := OperationResponse{
			StatusCode: buffered.status, ContentType: buffered.header.Get("Content-Type"),
			Body: buffered.body.Bytes(), Replayable: !sensitive,
			Headers: durableOperationHeaders(buffered.header),
		}
		if sensitive {
			stored.Body = nil
		}
		completeCtx, cancelComplete := context.WithTimeout(context.WithoutCancel(request.Context()), 5*time.Second)
		err = c.store.CompleteOperation(completeCtx, key, stored)
		cancelComplete()
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		for name, values := range buffered.header {
			writer.Header()[name] = append([]string(nil), values...)
		}
		writer.WriteHeader(buffered.status)
		_, _ = writer.Write(buffered.body.Bytes())
	})
}

func durableOperationHeaders(header http.Header) map[string][]string {
	result := map[string][]string{}
	for _, name := range []string{"X-Plue-Cleanup-Pending", "Location", "Retry-After"} {
		if values := header.Values(name); len(values) > 0 {
			result[http.CanonicalHeaderKey(name)] = append([]string(nil), values...)
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func requestResourceOwner(request *http.Request) (ResourceOwner, error) {
	owner := ResourceOwner{
		Kind: strings.TrimSpace(request.Header.Get(sandbox.ResourceKindHeader)),
		ID:   strings.TrimSpace(request.Header.Get(sandbox.ResourceIDHeader)),
	}
	if (owner.Kind == "") != (owner.ID == "") {
		return ResourceOwner{}, errors.New("resource kind and id must be provided together")
	}
	if owner.Kind == "" {
		return ResourceOwner{}, nil
	}
	if len(owner.Kind) > 64 || len(owner.ID) > 200 {
		return ResourceOwner{}, errors.New("resource kind or id exceeds controller limit")
	}
	for index, character := range owner.Kind {
		if !((character >= 'a' && character <= 'z') || (index > 0 && character >= '0' && character <= '9') ||
			(index > 0 && character == '_')) {
			return ResourceOwner{}, errors.New("resource kind must be lower snake case")
		}
	}
	if strings.IndexFunc(owner.ID, unicode.IsControl) >= 0 {
		return ResourceOwner{}, errors.New("resource id contains control characters")
	}
	return owner, nil
}

func (c *Controller) requirePeerIdentity(expected string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if expected == "" {
			if c.allowInsecureDev {
				return next
			}
			return http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writeError(writer, http.StatusServiceUnavailable, "authentication_not_configured", "mTLS peer identity is not configured")
			})
		}
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.TLS == nil || len(request.TLS.PeerCertificates) == 0 ||
				subtle.ConstantTimeCompare([]byte(request.TLS.PeerCertificates[0].Subject.CommonName), []byte(expected)) != 1 {
				writeError(writer, http.StatusForbidden, "peer_identity_denied", "mTLS peer identity is not authorized for this route")
				return
			}
			next.ServeHTTP(writer, request)
		})
	}
}

func (c *Controller) requireAPIKey(next http.Handler) http.Handler {
	return c.requireBearerKey(c.apiKey, "controller")(next)
}

func (c *Controller) requirePreviewAPIKey(next http.Handler) http.Handler {
	return c.requireBearerKey(c.previewAPIKey, "preview")(next)
}

func (c *Controller) requireBearerKey(key, scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if key == "" {
			if c.allowInsecureDev {
				return next
			}
			return http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writeError(writer, http.StatusServiceUnavailable, "authentication_not_configured", scope+" credential is not configured")
			})
		}
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			provided := strings.TrimSpace(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "))
			if subtle.ConstantTimeCompare([]byte(provided), []byte(key)) != 1 {
				writeError(writer, http.StatusUnauthorized, "unauthorized", "invalid "+scope+" credential")
				return
			}
			next.ServeHTTP(writer, request)
		})
	}
}

func (c *Controller) handleHeartbeat(writer http.ResponseWriter, request *http.Request) {
	var heartbeat msb.WorkerHeartbeat
	if !decodeJSON(writer, request, &heartbeat) {
		return
	}
	if strings.TrimSpace(heartbeat.WorkerID) == "" || strings.TrimSpace(heartbeat.BaseURL) == "" {
		writeError(writer, http.StatusBadRequest, "invalid_worker", "worker_id and base_url are required")
		return
	}
	if err := msb.VerifyWorkerHeartbeat(heartbeat); err != nil {
		c.logHeartbeatDenied(heartbeat, "worker_identity_denied", err)
		writeError(writer, http.StatusForbidden, "worker_identity_denied", err.Error())
		return
	}
	if err := msb.VerifyWorkerHeartbeatFresh(heartbeat, time.Now(), 45*time.Second, 15*time.Second); err != nil {
		c.logHeartbeatDenied(heartbeat, "worker_identity_expired", err)
		writeError(writer, http.StatusForbidden, "worker_identity_expired", err.Error())
		return
	}
	response, err := c.store.Heartbeat(request.Context(), heartbeat)
	if err != nil {
		var denial *HeartbeatDenial
		if errors.As(err, &denial) {
			c.logHeartbeatDenied(heartbeat, denial.Code, denial)
			writeError(writer, http.StatusForbidden, denial.Code, denial.Message)
			return
		}
		c.logger.Error("Microsandbox worker heartbeat processing failed",
			"worker_id", heartbeat.WorkerID, "boot_id", heartbeat.BootID, "error", err)
		writeStoreError(writer, err)
		return
	}
	if response.IdentityRotated {
		c.logger.Warn("Microsandbox worker identity superseded after relocation",
			"worker_id", heartbeat.WorkerID, "boot_id", heartbeat.BootID,
			"base_url", heartbeat.BaseURL,
			"identity_fingerprint", identityFingerprint(heartbeat.IdentityPublicKey))
	}
	c.logger.Info("Microsandbox runtime registered",
		"worker_id", heartbeat.WorkerID,
		"boot_id", heartbeat.BootID,
		"runtime_version", heartbeat.RuntimeVersion,
		"state", heartbeat.State,
		"base_url", heartbeat.BaseURL,
		"authorized", response.Authorized,
		"inventory_count", len(heartbeat.Inventory))
	writeJSON(writer, http.StatusOK, response)
}

// logHeartbeatDenied makes every server-side heartbeat refusal observable.
// During the 2026-08-05 relocation incident the only controller-side signal
// was the absence of a registration log line; the denial itself was silent on
// both ends of the connection.
func (c *Controller) logHeartbeatDenied(heartbeat msb.WorkerHeartbeat, code string, err error) {
	c.logger.Warn("Microsandbox worker heartbeat denied",
		"worker_id", heartbeat.WorkerID, "boot_id", heartbeat.BootID,
		"base_url", heartbeat.BaseURL, "code", code,
		"identity_fingerprint", identityFingerprint(heartbeat.IdentityPublicKey),
		"error", err)
}

// identityFingerprint identifies an ed25519 public key in logs. Public keys
// are not secret; the digest just keeps log lines short and grep-stable.
func identityFingerprint(publicKey []byte) string {
	if len(publicKey) == 0 {
		return ""
	}
	digest := sha256.Sum256(publicKey)
	return hex.EncodeToString(digest[:8])
}

func (c *Controller) handleCreateSandbox(writer http.ResponseWriter, request *http.Request) {
	var create sandbox.CreateRequest
	if !decodeJSON(writer, request, &create) {
		return
	}
	response, err := c.createSandbox(request.Context(), create)
	if err != nil {
		c.logger.Error("Microsandbox sandbox creation failed", "snapshot_id", create.SnapshotID, "error", err)
		writeControllerError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, response)
}

func (c *Controller) createSandbox(ctx context.Context, create sandbox.CreateRequest) (sandbox.CreateResult, error) {
	return c.createSandboxWithSnapshotOwnership(ctx, create, false)
}

func (c *Controller) createSandboxWithSnapshotOwnership(ctx context.Context, create sandbox.CreateRequest, adoptSnapshot bool) (sandbox.CreateResult, error) {
	if strings.TrimSpace(create.Image) == "" && strings.TrimSpace(create.SnapshotID) == "" {
		create.Image = c.defaultImage
	}
	if strings.TrimSpace(create.Image) == "" && strings.TrimSpace(create.SnapshotID) == "" {
		return sandbox.CreateResult{}, &requestError{Status: http.StatusBadRequest, Code: "image_required", Message: "sandbox image or snapshot is required"}
	}
	if create.RootfsSizeMB == nil && strings.TrimSpace(create.SnapshotID) == "" {
		rootfs := c.defaultRootfsMB
		if rootfs <= 0 {
			rootfs = msb.DefaultRootfsSizeMB(create.Kind)
		}
		create.RootfsSizeMB = &rootfs
	}
	id := "msb_" + uuid.NewString()
	operation, _ := ctx.Value(operationContextKey{}).(operationContext)
	placement, err := c.store.Allocate(ctx, id, create, msb.SanitizeCreateRequest(create), operation.owner)
	if err != nil {
		return sandbox.CreateResult{}, err
	}
	if operation.key != "" && bindsSandboxOperation(operation.operation) {
		if err := c.store.BindOperation(ctx, operation.key, id); err != nil {
			_ = c.store.Release(context.WithoutCancel(ctx), id, placement.Generation)
			return sandbox.CreateResult{}, fmt.Errorf("bind create idempotency state: %w", err)
		}
	}
	if adoptSnapshot && strings.TrimSpace(create.SnapshotID) != "" {
		if err := c.store.AdoptSnapshot(ctx, create.SnapshotID, id); err != nil {
			_ = c.store.Release(context.WithoutCancel(ctx), id, placement.Generation)
			return sandbox.CreateResult{}, fmt.Errorf("adopt fork recovery checkpoint: %w", err)
		}
	}
	if strings.TrimSpace(create.SnapshotID) != "" {
		if err := c.ensureSnapshotAvailable(ctx, placement); err != nil {
			c.logger.Error("Microsandbox snapshot preparation failed", "sandbox_id", id, "snapshot_id", create.SnapshotID, "error", err)
			_ = c.store.QueueFailedCreateCleanup(context.WithoutCancel(ctx), id, placement.Generation, redactedError(err))
			return sandbox.CreateResult{}, err
		}
	}

	workerRequest := msb.WorkerCreateRequest{SandboxID: placement.LocalID, Generation: placement.Generation, Request: create}
	var response sandbox.CreateResult
	err = c.workerJSON(ctx, placement, http.MethodPost, "/internal/v1/sandboxes", workerRequest, &response)
	if err != nil {
		c.logger.Error("Microsandbox worker sandbox creation failed", "sandbox_id", id, "snapshot_id", create.SnapshotID, "worker_id", placement.WorkerID, "error", err)
		_ = c.store.QueueFailedCreateCleanup(context.WithoutCancel(ctx), id, placement.Generation, redactedError(err))
		return sandbox.CreateResult{}, err
	}
	finalizeCtx, cancelFinalize := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	err = c.store.SetState(finalizeCtx, id, placement.Generation, "running", "running", "")
	cancelFinalize()
	if err != nil {
		return sandbox.CreateResult{}, err
	}
	response.ID = id
	return response, nil
}

func createsSandboxOperation(operation string) bool {
	return operation == "POST /v1/sandboxes" ||
		(strings.HasPrefix(operation, "POST /v1/sandboxes/") && strings.HasSuffix(operation, "/fork"))
}

func bindsSandboxOperation(operation string) bool {
	return createsSandboxOperation(operation) || operation == "POST /v1/sandboxes/snapshots"
}

func (c *Controller) handleInspectSandbox(writer http.ResponseWriter, request *http.Request) {
	placement, err := c.store.GetPlacement(request.Context(), chi.URLParam(request, "sandboxID"))
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if placement.WorkerUnavailable {
		writeError(writer, http.StatusServiceUnavailable, "host_lease_lost",
			"The workspace worker is unavailable. Use another workspace, or retry when this worker is available.")
		return
	}
	var response sandbox.Sandbox
	if err := c.workerJSON(request.Context(), placement, http.MethodGet, workerPath(placement.LocalID, ""), nil, &response); err != nil {
		writeControllerError(writer, err)
		return
	}
	response.ID = placement.SandboxID
	writeJSON(writer, http.StatusOK, response)
}

func (c *Controller) handleDeleteSandbox(writer http.ResponseWriter, request *http.Request) {
	placement, err := c.store.GetPlacement(request.Context(), chi.URLParam(request, "sandboxID"))
	if errors.Is(err, ErrNotFound) {
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if err := c.store.BeginDelete(request.Context(), placement.SandboxID, placement.Generation); err != nil {
		writeStoreError(writer, err)
		return
	}
	deleteErr := c.workerJSON(request.Context(), placement, http.MethodDelete, workerPath(placement.LocalID, ""), nil, nil)
	if deleteErr == nil || isWorkerNotFound(deleteErr) {
		if err := c.store.Release(request.Context(), placement.SandboxID, placement.Generation); err != nil {
			writeStoreError(writer, err)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	if err := c.store.FailCleanup(context.WithoutCancel(request.Context()), placement.SandboxID,
		placement.Generation, redactedError(deleteErr)); err != nil && !errors.Is(err, ErrStale) {
		writeStoreError(writer, err)
		return
	}
	c.logger.Warn("Microsandbox deletion accepted for reconciliation",
		"sandbox_id", placement.SandboxID, "worker_id", placement.WorkerID)
	writer.Header().Set("X-Plue-Cleanup-Pending", "true")
	writer.WriteHeader(http.StatusAccepted)
}

func (c *Controller) handleStartSandbox(writer http.ResponseWriter, request *http.Request) {
	var start sandbox.StartRequest
	if !decodeJSON(writer, request, &start) {
		return
	}
	placement, ok := c.placement(writer, request)
	if !ok {
		return
	}
	response, err := c.startPlacement(request.Context(), placement, start)
	if err != nil {
		// Admission failure happens before the reservation flag, placement state,
		// or worker changes. Preserve the stopped placement exactly as-is so the
		// caller can retry once capacity is available.
		if errors.Is(err, ErrNoCapacity) {
			writeControllerError(writer, err)
			return
		}
		_ = c.store.SetState(context.WithoutCancel(request.Context()), placement.SandboxID,
			placement.Generation, "running", "degraded", redactedError(err))
		writeControllerError(writer, err)
		return
	}
	_ = c.store.SetState(request.Context(), placement.SandboxID, placement.Generation, "running", "running", "")
	response.ID = placement.SandboxID
	response.RuntimeID = placement.SandboxID + ":" + strconv.FormatInt(placement.Generation, 10)
	writeJSON(writer, http.StatusOK, response)
}

// startPlacement cold-starts a retained guest and replays every durable,
// non-secret service declaration. Microsandbox snapshots preserve disk only,
// so reporting a resumed guest as running before its declared services return
// would make preview and workspace recovery silently incomplete.
//
// Secret-bearing declarations (any env — durable state holds only the redacted
// shape) are SKIPPED here, not replayed: the guest would come up with
// "[redacted]" for every credential, which is exactly the failure the
// recovery path refuses loudly. A same-disk start is different from fresh-disk
// recovery — the secret holder (the plue service that declared the service)
// still has the plaintext and re-declares it after the start answers; the repo
// gateway resume path does exactly that. Refusing the whole start the way
// recovery must only wedged every secret-bearing guest: the VM could never
// resume, and the caller's discard + reprovision orphaned its parked runs.
func (c *Controller) startPlacement(ctx context.Context, placement Placement, start sandbox.StartRequest) (sandbox.StartResult, error) {
	var services []sandbox.ServiceSpec
	if placement.ObservedState != "running" {
		recovered, skipped, err := startCreateRequest(placement.RequestSpec, placement.RecoveryServices)
		if err != nil {
			return sandbox.StartResult{}, err
		}
		if len(skipped) > 0 {
			c.logger.Warn("Microsandbox start skips secret-bearing services; the declaring service must re-declare them",
				"sandbox_id", placement.SandboxID, "services", skipped)
		}
		if recovered.Init != nil {
			services = recovered.Init.Services
		}
	}
	// Re-charge the worker reservation that suspend handed back, BEFORE any
	// worker RPC. A pool that filled up while this guest slept must fail the
	// resume cleanly with no_capacity and leave the guest suspended and
	// resumable — never boot it onto an overcommitted worker. Held-reservation
	// placements (never suspended, or a retried resume) are a no-op.
	acquired, err := c.store.AcquireReservation(ctx, placement.SandboxID, placement.Generation)
	if err != nil {
		return sandbox.StartResult{}, err
	}
	var response sandbox.StartResult
	if err := c.workerJSON(ctx, placement, http.MethodPost, workerPath(placement.LocalID, "/start"), start, &response); err != nil {
		// The guest never came up, so give back exactly what this resume took —
		// and nothing else, so a failed start against an already-running guest
		// cannot drop a reservation the guest is still using.
		if acquired {
			_ = c.store.ReleaseReservation(context.WithoutCancel(ctx), placement.SandboxID, placement.Generation)
		}
		return sandbox.StartResult{}, err
	}
	for _, service := range services {
		var started sandbox.CreateServiceResult
		if err := c.workerJSON(ctx, placement, http.MethodPost,
			workerPath(placement.LocalID, "/services"), service, &started); err != nil {
			return sandbox.StartResult{}, err
		}
	}
	return response, nil
}

// alreadyNotRunning reports whether a placement's recorded state already
// satisfies a stop/suspend request. Both verbs are idempotent: "the guest is
// not running" IS the requested end state, so re-dispatching the worker RPC and
// re-running the durable recovery checkpoint for a sandbox that is already
// stopped adds no progress and can only fail — and every caller reads that
// failure as "the VM is still running".
//
// That misread leaks quota. plue's idle-workspace sweeper marks a workspace
// 'suspended' — releasing its concurrent-VM slot — ONLY when suspend answers
// success (see vmAlreadyStopped in internal/services/workspace_lifecycle.go),
// so an already-stopped VM whose re-checkpoint keeps failing pinned the row at
// 'running' forever, re-snapshotting on every 5-minute sweep. handleDeleteSandbox
// has tolerated the same condition since it was written; stop and suspend must too.
//
// desired_state must already be 'stopped' for this to be safe: a crashed guest
// still marked desired 'running' is owned by the restart/recovery machinery, and
// answering success there would report a sandbox as suspended moments before the
// reconciler brings it back up.
func alreadyNotRunning(placement Placement) bool {
	if placement.DesiredState != "stopped" {
		return false
	}
	return placement.ObservedState == "stopped" || placement.ObservedState == "degraded"
}

// releaseStoppedReservation hands a just-stopped guest's CPU, memory, and
// active-VM reservation back to the pool. Its retained root disk remains
// charged until delete. This runs the moment the worker confirms the guest
// is down and the row is recorded stopped — deliberately BEFORE the durable
// checkpoint, because a checkpoint failure marks the placement degraded but does
// not bring the guest back up, and a powered-off VM must not keep holding a slot
// either way. Best effort: the reservation is re-derivable (delete releases it,
// resume re-acquires it), and failing an otherwise successful stop over an
// accounting write would be a worse outcome than one late release.
func (c *Controller) releaseStoppedReservation(ctx context.Context, placement Placement) {
	if err := c.store.ReleaseReservation(context.WithoutCancel(ctx),
		placement.SandboxID, placement.Generation); err != nil {
		c.logger.Warn("Microsandbox reservation release failed",
			"sandbox_id", placement.SandboxID, "worker_id", placement.WorkerID, "error", err)
	}
}

func (c *Controller) handleStopSandbox(writer http.ResponseWriter, request *http.Request) {
	placement, ok := c.placement(writer, request)
	if !ok {
		return
	}
	if alreadyNotRunning(placement) {
		// This also repairs pre-migration stopped placements whose reservation
		// flag defaulted to held; an idempotent retry must not leave their slot
		// pinned until a later heartbeat sweep.
		c.releaseStoppedReservation(request.Context(), placement)
		writeJSON(writer, http.StatusOK, sandbox.StopResult{
			SandboxID: placement.SandboxID,
			RuntimeID: placement.SandboxID + ":" + strconv.FormatInt(placement.Generation, 10),
		})
		return
	}
	var response sandbox.StopResult
	if err := c.workerJSON(request.Context(), placement, http.MethodPost, workerPath(placement.LocalID, "/stop"), nil, &response); err != nil {
		writeControllerError(writer, err)
		return
	}
	if err := c.store.SetState(request.Context(), placement.SandboxID, placement.Generation, "stopped", "stopped", ""); err != nil {
		writeStoreError(writer, err)
		return
	}
	c.releaseStoppedReservation(request.Context(), placement)
	if err := c.checkpointStoppedVM(request.Context(), placement); err != nil {
		_ = c.store.SetState(context.WithoutCancel(request.Context()), placement.SandboxID, placement.Generation, "stopped", "degraded", redactedError(err))
		writeControllerError(writer, err)
		return
	}
	response.SandboxID = placement.SandboxID
	response.RuntimeID = placement.SandboxID + ":" + strconv.FormatInt(placement.Generation, 10)
	writeJSON(writer, http.StatusOK, response)
}

func (c *Controller) handleSuspendSandbox(writer http.ResponseWriter, request *http.Request) {
	placement, ok := c.placement(writer, request)
	if !ok {
		return
	}
	if alreadyNotRunning(placement) {
		c.releaseStoppedReservation(request.Context(), placement)
		writeJSON(writer, http.StatusOK, sandbox.SuspendResult{
			ID:        placement.SandboxID,
			RuntimeID: placement.SandboxID + ":" + strconv.FormatInt(placement.Generation, 10),
		})
		return
	}
	var response sandbox.SuspendResult
	if err := c.workerJSON(request.Context(), placement, http.MethodPost, workerPath(placement.LocalID, "/suspend"), nil, &response); err != nil {
		writeControllerError(writer, err)
		return
	}
	if err := c.store.SetState(request.Context(), placement.SandboxID, placement.Generation, "stopped", "stopped", ""); err != nil {
		writeStoreError(writer, err)
		return
	}
	c.releaseStoppedReservation(request.Context(), placement)
	if err := c.checkpointStoppedVM(request.Context(), placement); err != nil {
		_ = c.store.SetState(context.WithoutCancel(request.Context()), placement.SandboxID, placement.Generation, "stopped", "degraded", redactedError(err))
		writeControllerError(writer, err)
		return
	}
	response.ID = placement.SandboxID
	response.RuntimeID = placement.SandboxID + ":" + strconv.FormatInt(placement.Generation, 10)
	writeJSON(writer, http.StatusOK, response)
}

func (c *Controller) handleExecute(writer http.ResponseWriter, request *http.Request) {
	var exec sandbox.ExecRequest
	if !decodeJSON(writer, request, &exec) {
		return
	}
	placement, ok := c.placement(writer, request)
	if !ok {
		return
	}
	var response sandbox.ExecResult
	if err := c.workerJSON(request.Context(), placement, http.MethodPost, workerPath(placement.LocalID, "/exec"), exec, &response); err != nil {
		writeControllerError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (c *Controller) handleWriteFile(writer http.ResponseWriter, request *http.Request) {
	var write sandbox.WriteFileRequest
	if !decodeJSON(writer, request, &write) {
		return
	}
	placement, ok := c.placement(writer, request)
	if !ok {
		return
	}
	decodedPath, err := url.PathUnescape(chi.URLParam(request, "*"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_path", "guest file path is invalid")
		return
	}
	escapedPath, err := sandbox.EscapeGuestPath(decodedPath)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_path", "guest file path is invalid")
		return
	}
	if err := c.workerJSON(request.Context(), placement, http.MethodPut, workerPath(placement.LocalID, "/files/"+escapedPath), write, nil); err != nil {
		writeControllerError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (c *Controller) handleCreateService(writer http.ResponseWriter, request *http.Request) {
	var service sandbox.ServiceSpec
	if !decodeJSON(writer, request, &service) {
		return
	}
	placement, ok := c.placement(writer, request)
	if !ok {
		return
	}
	if err := c.store.RecordService(request.Context(), placement.SandboxID, placement.Generation, msb.SanitizeServiceSpec(service)); err != nil {
		writeStoreError(writer, err)
		return
	}
	var response sandbox.CreateServiceResult
	if err := c.workerJSON(request.Context(), placement, http.MethodPost, workerPath(placement.LocalID, "/services"), service, &response); err != nil {
		writeControllerError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (c *Controller) handleSnapshotSandbox(writer http.ResponseWriter, request *http.Request) {
	var snapshot sandbox.SnapshotRequest
	if !decodeJSON(writer, request, &snapshot) {
		return
	}
	response, err := c.snapshotSandbox(request.Context(), chi.URLParam(request, "sandboxID"), snapshot, false, true)
	if err != nil {
		writeControllerError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, response)
}

func (c *Controller) snapshotSandbox(ctx context.Context, sandboxID string, request sandbox.SnapshotRequest, garbageCollectible, exportNow bool) (sandbox.SnapshotResult, error) {
	snapshotID := "msbs_" + uuid.NewString()
	placement, err := c.store.CreateSnapshot(ctx, snapshotID, sandboxID, snapshotID, garbageCollectible)
	if err != nil {
		return sandbox.SnapshotResult{}, err
	}
	workerPlacement := Placement{
		SandboxID: placement.SourceID, LocalID: placement.SourceID,
		WorkerID: placement.WorkerID, WorkerURL: placement.WorkerURL,
		Generation: placement.Generation,
	}
	workerRequest := msb.WorkerSnapshotRequest{SnapshotID: placement.LocalID, Generation: placement.Generation, Request: request}
	var response sandbox.SnapshotResult
	if err := c.workerJSON(ctx, workerPlacement, http.MethodPost, workerPath(placement.SourceID, "/snapshot"), workerRequest, &response); err != nil {
		_ = c.store.SetSnapshotState(context.WithoutCancel(ctx), snapshotID, "failed", "", "", nil)
		return sandbox.SnapshotResult{}, err
	}
	if c.snapshotStore != nil && exportNow {
		if err := c.exportSnapshot(ctx, placement); err != nil {
			_ = c.store.SetSnapshotState(context.WithoutCancel(ctx), snapshotID, "failed", "", "", nil)
			return sandbox.SnapshotResult{}, err
		}
	} else {
		_ = c.store.SetSnapshotState(ctx, snapshotID, "ready", "", "", nil)
	}
	response.SnapshotID = snapshotID
	response.SourceSandboxID = sandboxID
	return response, nil
}

func (c *Controller) checkpointStoppedVM(ctx context.Context, placement Placement) error {
	if !placement.Persistent {
		return nil
	}
	if c.snapshotStore == nil {
		return errors.New("durable snapshot object store is unavailable")
	}
	// Hard-bound the snapshot+export. context.WithTimeout only ever shortens,
	// so request-scoped callers (stop/suspend) keep their own shorter deadline
	// while the reconcile loop — which has none — can no longer be starved by a
	// single wedged upload.
	ctx, cancelCheckpoint := context.WithTimeout(ctx, drainCheckpointTimeout)
	defer cancelCheckpoint()
	response, err := c.snapshotSandbox(ctx, placement.SandboxID, sandbox.SnapshotRequest{Name: "recovery-checkpoint"}, true, true)
	if err != nil {
		return fmt.Errorf("create durable recovery checkpoint: %w", err)
	}
	previous, err := c.store.SetRecoverySnapshot(ctx, placement.SandboxID, placement.Generation, response.SnapshotID)
	if err != nil {
		_ = c.deleteSnapshot(context.WithoutCancel(ctx), response.SnapshotID)
		return fmt.Errorf("publish durable recovery checkpoint: %w", err)
	}
	if previous != "" && previous != response.SnapshotID {
		// A persistent sandbox may have been created from a shared golden or fork
		// snapshot. Only collect a checkpoint owned by this same sandbox; deleting
		// an input snapshot would break every other consumer that references it.
		previousPlacement, lookupErr := c.store.GetSnapshot(context.WithoutCancel(ctx), previous)
		if lookupErr == nil && previousPlacement.SourceID == placement.SandboxID {
			if err := c.deleteSnapshot(context.WithoutCancel(ctx), previous); err != nil {
				c.logger.Warn("superseded recovery checkpoint cleanup failed", "snapshot_id", previous)
			}
		} else if lookupErr != nil && !errors.Is(lookupErr, ErrNotFound) {
			c.logger.Warn("superseded recovery checkpoint lookup failed", "snapshot_id", previous)
		}
	}
	return nil
}

// wallClock reads the reconcile clock, tolerating a Controller built directly
// in a test rather than through New.
func (c *Controller) wallClock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// Reconcile converges database intent, worker inventory, and recoverable
// persistent placements. A claim lease makes this safe with multiple
// controller replicas; worker generations make retries safe after a crash.
func (c *Controller) Reconcile(ctx context.Context, now time.Time) (ReconcileResult, error) {
	result, err := c.store.Reconcile(ctx, now)
	if err != nil {
		return result, err
	}
	var recoveryErrors []error
	for range 100 {
		placement, claimErr := c.store.ClaimCleanup(ctx, c.recoveryOwner, 2*time.Minute)
		if errors.Is(claimErr, ErrNotFound) {
			break
		}
		if claimErr != nil {
			return result, errors.Join(append(recoveryErrors, claimErr)...)
		}
		result.CleanupAttempted++
		if placement.WorkerURL == "" {
			if releaseErr := c.store.Release(ctx, placement.SandboxID, placement.Generation); releaseErr != nil {
				result.CleanupDeferred++
				recoveryErrors = append(recoveryErrors, releaseErr)
				continue
			}
			result.CleanupSucceeded++
			continue
		}
		deleteCtx, cancelDelete := context.WithTimeout(ctx, 30*time.Second)
		deleteErr := c.workerJSON(deleteCtx, placement, http.MethodDelete, workerPath(placement.LocalID, ""), nil, nil)
		cancelDelete()
		if deleteErr != nil && !isWorkerNotFound(deleteErr) {
			result.CleanupDeferred++
			_ = c.store.FailCleanup(context.WithoutCancel(ctx), placement.SandboxID,
				placement.Generation, redactedError(deleteErr))
			recoveryErrors = append(recoveryErrors, deleteErr)
			continue
		}
		if releaseErr := c.store.Release(ctx, placement.SandboxID, placement.Generation); releaseErr != nil {
			result.CleanupDeferred++
			recoveryErrors = append(recoveryErrors, releaseErr)
			continue
		}
		result.CleanupSucceeded++
	}
	for range 25 {
		snapshot, claimErr := c.store.ClaimSnapshotCleanup(ctx, c.recoveryOwner, 5*time.Minute, 30*time.Minute)
		if errors.Is(claimErr, ErrNotFound) {
			break
		}
		if claimErr != nil {
			return result, errors.Join(append(recoveryErrors, claimErr)...)
		}
		result.SnapshotAttempted++
		cleanupCtx, cancelCleanup := context.WithTimeout(ctx, 2*time.Minute)
		cleanupErr := c.deleteSnapshotArtifacts(cleanupCtx, snapshot, true)
		cancelCleanup()
		if cleanupErr != nil {
			result.SnapshotDeferred++
			failureCtx, cancelFailure := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			_ = c.store.FailSnapshotCleanup(failureCtx, snapshot.SnapshotID, c.recoveryOwner, redactedError(cleanupErr))
			cancelFailure()
			recoveryErrors = append(recoveryErrors, cleanupErr)
			continue
		}
		if completeErr := c.store.CompleteSnapshotCleanup(ctx, snapshot.SnapshotID, c.recoveryOwner); completeErr != nil {
			result.SnapshotDeferred++
			recoveryErrors = append(recoveryErrors, completeErr)
			continue
		}
		result.SnapshotSucceeded++
	}
	// Stop claiming new drains once the phase budget is spent so the
	// cleanup/restart/recovery phases below stay reachable inside one pass.
	// Deliberately checked before each claim, never mid-checkpoint: an
	// in-flight checkpoint keeps its own full drainCheckpointTimeout.
	drainDeadline := c.wallClock().Add(drainPhaseBudget)
	for range 10 {
		if !c.wallClock().Before(drainDeadline) {
			result.DrainDeferred++
			break
		}
		claim, claimErr := c.store.ClaimDrain(ctx, c.recoveryOwner, 10*time.Minute)
		if errors.Is(claimErr, ErrNotFound) {
			break
		}
		if claimErr != nil {
			return result, errors.Join(append(recoveryErrors, claimErr)...)
		}
		result.DrainAttempted++
		if claim.PreviousObserved == "running" {
			shouldStop := true
			inspectCtx, cancelInspect := context.WithTimeout(ctx, 30*time.Second)
			var current sandbox.Sandbox
			inspectErr := c.workerJSON(inspectCtx, claim.Placement, http.MethodGet,
				workerPath(claim.Placement.LocalID, ""), nil, &current)
			cancelInspect()
			if inspectErr == nil && (current.State == sandbox.StateStopped || current.State == sandbox.StateSuspending) {
				shouldStop = false
			}
			if shouldStop {
				var stopped sandbox.StopResult
				if stopErr := c.workerJSON(ctx, claim.Placement, http.MethodPost,
					workerPath(claim.Placement.LocalID, "/stop"), nil, &stopped); stopErr != nil {
					result.DrainDeferred++
					_ = c.store.FailDrain(context.WithoutCancel(ctx), claim.Placement.SandboxID,
						claim.Placement.Generation, claim.PreviousObserved, redactedError(stopErr))
					recoveryErrors = append(recoveryErrors, stopErr)
					continue
				}
			}
		}
		if checkpointErr := c.checkpointStoppedVM(ctx, claim.Placement); checkpointErr != nil {
			result.DrainDeferred++
			_ = c.store.FailDrain(context.WithoutCancel(ctx), claim.Placement.SandboxID,
				claim.Placement.Generation, claim.PreviousObserved, redactedError(checkpointErr))
			recoveryErrors = append(recoveryErrors, checkpointErr)
			continue
		}
		if completeErr := c.store.CompleteDrainCheckpoint(ctx, claim.Placement.SandboxID,
			claim.Placement.Generation); completeErr != nil {
			result.DrainDeferred++
			_ = c.store.FailDrain(context.WithoutCancel(ctx), claim.Placement.SandboxID,
				claim.Placement.Generation, claim.PreviousObserved, redactedError(completeErr))
			recoveryErrors = append(recoveryErrors, completeErr)
			continue
		}
		result.DrainCheckpointed++
	}
	for range 10 {
		placement, claimErr := c.store.ClaimRestart(ctx, c.recoveryOwner, 10*time.Minute)
		if errors.Is(claimErr, ErrNotFound) {
			break
		}
		if claimErr != nil {
			return result, errors.Join(append(recoveryErrors, claimErr)...)
		}
		result.RestartAttempted++
		hydrated, hydrateErr := c.store.GetPlacement(ctx, placement.SandboxID)
		if hydrateErr != nil {
			result.RestartFailed++
			_ = c.store.FailRestart(context.WithoutCancel(ctx), placement.SandboxID,
				placement.Generation, redactedError(hydrateErr))
			recoveryErrors = append(recoveryErrors, hydrateErr)
			continue
		}
		_, restartErr := c.startPlacement(ctx, hydrated, sandbox.StartRequest{})
		if restartErr != nil {
			result.RestartFailed++
			_ = c.store.FailRestart(context.WithoutCancel(ctx), placement.SandboxID,
				placement.Generation, redactedError(restartErr))
			recoveryErrors = append(recoveryErrors, restartErr)
			continue
		}
		if completeErr := c.store.CompleteRecovery(ctx, placement.SandboxID, placement.Generation, "running"); completeErr != nil {
			result.RestartFailed++
			recoveryErrors = append(recoveryErrors, completeErr)
			continue
		}
		result.RestartSucceeded++
	}
	for range 10 {
		claim, claimErr := c.store.ClaimRecovery(ctx, c.recoveryOwner, 10*time.Minute)
		if errors.Is(claimErr, ErrNotFound) {
			break
		}
		if errors.Is(claimErr, ErrNoCapacity) {
			recoveryErrors = append(recoveryErrors, claimErr)
			break
		}
		if claimErr != nil {
			return result, errors.Join(append(recoveryErrors, claimErr)...)
		}
		result.RecoveryAttempted++
		if recoverErr := c.recoverClaim(ctx, claim); recoverErr != nil {
			result.RecoveryFailed++
			if errors.Is(recoverErr, ErrRecoverySecretsRequired) {
				_ = c.store.BlockRecovery(context.WithoutCancel(ctx), claim.Placement.SandboxID,
					claim.Placement.Generation, redactedError(recoverErr))
			} else {
				_ = c.store.FailRecovery(context.WithoutCancel(ctx), claim.Placement.SandboxID,
					claim.Placement.Generation, redactedError(recoverErr))
			}
			recoveryErrors = append(recoveryErrors, recoverErr)
			continue
		}
		result.RecoverySucceeded++
		c.cleanupPreviousPlacement(ctx, claim)
	}
	return result, errors.Join(recoveryErrors...)
}

func (c *Controller) cleanupPreviousPlacement(ctx context.Context, claim RecoveryClaim) {
	previous := claim.PreviousPlacement
	if previous == nil || previous.WorkerURL == "" ||
		(previous.WorkerID == claim.Placement.WorkerID && previous.LocalID == claim.Placement.LocalID) {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := c.workerJSON(cleanupCtx, *previous, http.MethodDelete,
		workerPath(previous.LocalID, ""), nil, nil); err != nil && !isWorkerNotFound(err) {
		c.logger.Warn("relocated Microsandbox source cleanup deferred to orphan reconciliation",
			"worker_id", previous.WorkerID, "generation", previous.Generation)
	}
}

func (c *Controller) recoverClaim(ctx context.Context, claim RecoveryClaim) error {
	placement := claim.Placement
	if placement.RecoverySnapshotObjectURI == "" || placement.RecoverySnapshotDigest == "" {
		return errors.New("recovery checkpoint is not durably verified")
	}
	request, err := recoveryCreateRequest(placement.RequestSpec, placement.RecoveryServices)
	if err != nil {
		return err
	}
	if !claim.ReuseStoppedDisk {
		if err := c.ensureSnapshotAvailable(ctx, placement); err != nil {
			return err
		}
	}
	request.SnapshotID = placement.RecoverySnapshotID
	if placement.Requested.CPUMillis >= 1000 {
		cpus := int32(placement.Requested.CPUMillis / 1000)
		request.VCPUCount = &cpus
	}
	if placement.Requested.MemoryBytes > 0 {
		memory := int32(placement.Requested.MemoryBytes / (1024 * 1024))
		request.MemSizeMB = &memory
	}
	if placement.Requested.DiskBytes > 0 {
		disk := placement.Requested.DiskBytes / (1024 * 1024)
		request.RootfsSizeMB = &disk
	}
	request.Persistence = &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent}
	workerRequest := msb.WorkerCreateRequest{
		SandboxID: placement.LocalID, Generation: placement.Generation,
		ReuseStoppedDisk: claim.ReuseStoppedDisk, Request: request,
	}
	var created sandbox.CreateResult
	if err := c.workerJSON(ctx, placement, http.MethodPost, "/internal/v1/sandboxes", workerRequest, &created); err != nil {
		return err
	}
	if claim.ReuseStoppedDisk && request.Init != nil {
		for _, service := range request.Init.Services {
			var started sandbox.CreateServiceResult
			if err := c.workerJSON(ctx, placement, http.MethodPost,
				workerPath(placement.LocalID, "/services"), service, &started); err != nil {
				return err
			}
		}
	}
	observed := "running"
	if claim.DesiredState == "stopped" {
		var stopped sandbox.StopResult
		if err := c.workerJSON(ctx, placement, http.MethodPost, workerPath(placement.LocalID, "/stop"), nil, &stopped); err != nil {
			return err
		}
		observed = "stopped"
	}
	return c.store.CompleteRecovery(ctx, placement.SandboxID, placement.Generation, observed)
}

// recoveryCreateRequest restores the non-secret host/runtime policy persisted
// with the placement. Bootstrap payloads that can contain credentials are
// intentionally omitted: their effects already live in the disk checkpoint,
// while replaying the durable "[redacted]" sentinels would corrupt the guest.
// Fresh-disk recovery has no secret holder on the call path, so a
// secret-bearing declaration fails the whole recovery loudly.
func recoveryCreateRequest(raw json.RawMessage, dynamicServices []sandbox.ServiceSpec) (sandbox.CreateRequest, error) {
	return mergeRecoveryRequest(raw, dynamicServices, nil)
}

// startCreateRequest is recoveryCreateRequest for a same-disk start: the
// secret holder (the declaring plue service) re-declares its services after
// the guest boots, so secret-bearing declarations are skipped — and named in
// the return — instead of blocking the start. Bootstrapping payloads are
// omitted exactly as in recovery; a corrupt durable policy still fails.
func startCreateRequest(raw json.RawMessage, dynamicServices []sandbox.ServiceSpec) (sandbox.CreateRequest, []string, error) {
	var skipped []string
	request, err := mergeRecoveryRequest(raw, dynamicServices, func(name string) error {
		skipped = append(skipped, name)
		return nil
	})
	return request, skipped, err
}

// mergeRecoveryRequest holds the shared merge. onSecret nil means strict:
// a secret-bearing declaration aborts with ErrRecoverySecretsRequired. A
// non-nil handler swallows the declaration and decides the outcome.
func mergeRecoveryRequest(raw json.RawMessage, dynamicServices []sandbox.ServiceSpec, onSecret func(name string) error) (sandbox.CreateRequest, error) {
	secret := func(name string) error {
		if onSecret != nil {
			return onSecret(name)
		}
		return fmt.Errorf("%w for service %q", ErrRecoverySecretsRequired, name)
	}
	var request sandbox.CreateRequest
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &request); err != nil {
			return sandbox.CreateRequest{}, fmt.Errorf("decode durable sandbox request policy: %w", err)
		}
	}
	request.Files = nil
	request.Git = nil
	request.GitRepos = nil
	var systemd *sandbox.ServiceConfig
	if request.Init != nil {
		copy := *request.Init
		copy.Services = append([]sandbox.ServiceSpec(nil), request.Init.Services...)
		systemd = &copy
	} else if request.Template != nil && request.Template.Init != nil {
		copy := *request.Template.Init
		copy.Services = append([]sandbox.ServiceSpec(nil), request.Template.Init.Services...)
		systemd = &copy
	}
	if request.Template != nil {
		template := *request.Template
		template.Files = nil
		template.Git = nil
		template.GitRepos = nil
		template.Init = nil
		request.Template = &template
	}
	if systemd == nil && len(dynamicServices) > 0 {
		systemd = &sandbox.ServiceConfig{Enabled: true}
	}
	if systemd != nil {
		byName := make(map[string]int, len(systemd.Services)+len(dynamicServices))
		kept := systemd.Services[:0]
		for _, service := range systemd.Services {
			if len(service.Env) > 0 {
				if err := secret(service.Name); err != nil {
					return sandbox.CreateRequest{}, err
				}
				continue
			}
			byName[service.Name] = len(kept)
			kept = append(kept, service)
		}
		systemd.Services = kept
		for _, service := range dynamicServices {
			if len(service.Env) > 0 {
				if err := secret(service.Name); err != nil {
					return sandbox.CreateRequest{}, err
				}
				continue
			}
			if index, exists := byName[service.Name]; exists {
				systemd.Services[index] = service
				continue
			}
			byName[service.Name] = len(systemd.Services)
			systemd.Services = append(systemd.Services, service)
		}
	}
	request.Init = systemd
	return request, nil
}

func (c *Controller) handleForkSandbox(writer http.ResponseWriter, request *http.Request) {
	var fork sandbox.ForkRequest
	if !decodeJSON(writer, request, &fork) {
		return
	}
	sourceID := chi.URLParam(request, "sandboxID")
	// Export the snapshot before starting the child. The runtime holds a local
	// snapshot mutation lock while exporting, and a running child consumes that
	// snapshot as its CoW parent. Publishing the compressed artifact first keeps
	// the fork recoverable without trying to export a snapshot already in use.
	temporary, err := c.snapshotSandbox(request.Context(), sourceID, sandbox.SnapshotRequest{Name: "fork"}, true, true)
	if err != nil {
		c.logger.Error("Microsandbox fork snapshot failed", "source_sandbox_id", sourceID, "error", err)
		writeControllerError(writer, err)
		return
	}
	keepSnapshot := false
	defer func() {
		if !keepSnapshot {
			_ = c.deleteSnapshot(context.WithoutCancel(request.Context()), temporary.SnapshotID)
		}
	}()
	create := sandbox.CreateRequest{
		SnapshotID: temporary.SnapshotID, IdleTimeoutSeconds: fork.IdleTimeoutSeconds,
		Persistence: fork.Persistence, Workdir: fork.Workdir,
		EgressProxy: fork.EgressProxy, Files: fork.Files,
		MemSizeMB: fork.MemSizeMB, VCPUCount: fork.VCPUCount, Kind: fork.Kind,
	}
	response, createErr := c.createSandboxWithSnapshotOwnership(request.Context(), create, true)
	if createErr != nil {
		c.logger.Error("Microsandbox fork child create failed", "source_sandbox_id", sourceID, "snapshot_id", temporary.SnapshotID, "error", createErr)
		writeControllerError(writer, createErr)
		return
	}
	// Microsandbox snapshots are layered parents, including for ephemeral
	// children. Keep this internal snapshot while the child is live; the DB
	// reference prevents cleanup and GC collects it after child deletion (or
	// after a persistent child publishes a replacement recovery checkpoint).
	keepSnapshot = true
	writeJSON(writer, http.StatusCreated, response)
}

func (c *Controller) handleCreateSnapshot(writer http.ResponseWriter, request *http.Request) {
	var snapshot sandbox.CreateSnapshotRequest
	if !decodeJSON(writer, request, &snapshot) {
		return
	}
	create := sandbox.CreateRequest{
		Image: snapshot.Template.Image, Files: snapshot.Template.Files,
		Packages: snapshot.Template.Packages, Git: snapshot.Template.Git,
		GitRepos: snapshot.Template.GitRepos, Groups: snapshot.Template.Groups,
		IdleTimeoutSeconds: snapshot.Template.IdleTimeoutSeconds,
		MemSizeMB:          snapshot.Template.MemSizeMB, Firewall: snapshot.Template.Firewall,
		Persistence: snapshot.Template.Persistence, Ports: snapshot.Template.Ports,
		RootfsSizeMB: snapshot.Template.RootfsSizeMB, Init: snapshot.Template.Init,
		Users: snapshot.Template.Users, VCPUCount: snapshot.Template.VCPUCount,
		WaitForReady: snapshot.Template.WaitForReady, Workdir: snapshot.Template.Workdir,
	}
	temporary, err := c.createSandbox(request.Context(), create)
	if err != nil {
		writeControllerError(writer, err)
		return
	}
	result, snapshotErr := c.snapshotSandbox(request.Context(), temporary.ID, sandbox.SnapshotRequest{Name: snapshot.Name}, false, true)
	_ = c.deleteSandbox(context.WithoutCancel(request.Context()), temporary.ID)
	if snapshotErr != nil {
		writeControllerError(writer, snapshotErr)
		return
	}
	writeJSON(writer, http.StatusCreated, sandbox.CreateSnapshotResponse{SnapshotID: result.SnapshotID})
}

func (c *Controller) handleDeleteSnapshot(writer http.ResponseWriter, request *http.Request) {
	if err := c.deleteSnapshot(request.Context(), chi.URLParam(request, "snapshotID")); err != nil {
		writeControllerError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (c *Controller) deleteSnapshot(ctx context.Context, snapshotID string) error {
	placement, err := c.store.BeginSnapshotCleanup(ctx, snapshotID, c.recoveryOwner, 5*time.Minute)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if cleanupErr := c.deleteSnapshotArtifacts(ctx, placement, true); cleanupErr != nil {
		failureCtx, cancelFailure := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		failureErr := c.store.FailSnapshotCleanup(failureCtx, snapshotID, c.recoveryOwner, redactedError(cleanupErr))
		cancelFailure()
		return errors.Join(cleanupErr, failureErr)
	}
	completeCtx, cancelComplete := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	completeErr := c.store.CompleteSnapshotCleanup(completeCtx, snapshotID, c.recoveryOwner)
	cancelComplete()
	return completeErr
}

func (c *Controller) deleteSnapshotArtifacts(ctx context.Context, placement SnapshotPlacement, requireWorker bool) error {
	if c.snapshotStore != nil {
		if err := c.snapshotStore.Delete(ctx, placement.ObjectURI); err != nil {
			return err
		}
	}
	if placement.WorkerURL == "" {
		// The store only suppresses a worker URL after its lease has been gone
		// long enough that the node-local artifact is no longer reachable. The
		// durable object is already deleted; do not retain a DB tombstone forever
		// for storage on a permanently lost node.
		return nil
	}
	workerPlacement := Placement{
		LocalID: placement.LocalID, WorkerID: placement.WorkerID,
		WorkerURL: placement.WorkerURL, Generation: placement.Generation,
	}
	workerErr := c.workerJSON(ctx, workerPlacement, http.MethodDelete,
		"/internal/v1/snapshots/"+url.PathEscape(placement.LocalID), nil, nil)
	if workerErr != nil && !isWorkerNotFound(workerErr) && requireWorker {
		return workerErr
	}
	return nil
}

func (c *Controller) exportSnapshot(ctx context.Context, placement SnapshotPlacement) error {
	if err := c.store.SetSnapshotState(ctx, placement.SnapshotID, "exporting", "", "", nil); err != nil {
		return err
	}
	workerPlacement := Placement{
		LocalID: placement.LocalID, WorkerID: placement.WorkerID,
		WorkerURL: placement.WorkerURL, Generation: placement.Generation,
	}
	response, err := c.workerRequest(ctx, workerPlacement, http.MethodGet,
		"/internal/v1/snapshots/"+url.PathEscape(placement.LocalID)+"/export", nil)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return &workerError{Status: response.StatusCode, Body: string(payload)}
	}
	artifactDigest := strings.TrimSpace(response.Header.Get("X-Plue-Snapshot-Digest"))
	if artifactDigest == "" {
		return errors.New("worker snapshot export omitted artifact digest")
	}
	objectURI, storedDigest, size, err := c.snapshotStore.Put(ctx, "snapshots/"+placement.SnapshotID+".tar", response.Body)
	if err != nil {
		return fmt.Errorf("persist snapshot export: %w", err)
	}
	if response.ContentLength >= 0 && response.ContentLength != size {
		_ = c.snapshotStore.Delete(context.WithoutCancel(ctx), objectURI)
		return fmt.Errorf("snapshot export size mismatch")
	}
	if storedDigest != artifactDigest {
		_ = c.snapshotStore.Delete(context.WithoutCancel(ctx), objectURI)
		return errors.New("snapshot export digest does not match worker artifact")
	}
	if err := c.store.SetSnapshotState(ctx, placement.SnapshotID, "exported", objectURI, storedDigest, &size); err != nil {
		deleteCtx, cancelDelete := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		deleteErr := c.snapshotStore.Delete(deleteCtx, objectURI)
		cancelDelete()
		return errors.Join(err, deleteErr)
	}
	return nil
}

func (c *Controller) ensureSnapshotAvailable(ctx context.Context, placement Placement) error {
	if placement.SnapshotLocalID == "" {
		return errors.New("snapshot placement is incomplete")
	}
	// Fast path: the worker Allocate chose is the worker that owns the snapshot,
	// so the artifact is already on that node's disk and there is nothing to
	// transfer. Allocate deliberately prefers the snapshot's own worker
	// (ORDER BY (id=$4) DESC), so this is the COMMON case for every
	// golden-snapshot workspace boot.
	//
	// Without this, a non-empty object_uri made every such create re-open the
	// object from GCS and re-PUT ~140 MB back to a worker that already had it:
	// pure waste that also made object storage a hard dependency of the create
	// path, so a GCS blip failed workspace creates that needed nothing from it.
	//
	// The guard on a non-empty SnapshotWorkerID is load-bearing, not cosmetic:
	// the recovery path (ClaimRecovery) hydrates SnapshotLocalID/ObjectURI/Digest
	// from the recovery checkpoint but leaves SnapshotWorkerID empty, so
	// relocation onto a new worker still imports from durable storage.
	//
	// Trusting worker identity to imply artifact presence is the same invariant
	// the no-export branch below already relied on, and the store only clears a
	// snapshot's worker once its lease has been gone long enough that the
	// node-local artifact is unreachable. If it is ever wrong, the subsequent
	// worker create fails not-found and the caller falls back (and retires a bad
	// golden pointer) exactly as it would for any other unusable snapshot.
	if placement.SnapshotWorkerID != "" && placement.WorkerID == placement.SnapshotWorkerID {
		return nil
	}
	if placement.SnapshotObjectURI == "" {
		return errors.New("snapshot has no durable export for worker relocation")
	}
	if c.snapshotStore == nil {
		return errors.New("snapshot object store is unavailable")
	}
	archive, err := c.snapshotStore.Open(ctx, placement.SnapshotObjectURI)
	if err != nil {
		return fmt.Errorf("open durable snapshot: %w", err)
	}
	defer func() { _ = archive.Close() }()
	response, err := c.workerRequest(ctx, placement, http.MethodPut,
		"/internal/v1/snapshots/"+url.PathEscape(placement.SnapshotLocalID)+"/import", archive)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return &workerError{Status: response.StatusCode, Body: string(payload)}
	}
	var metadata msb.SnapshotTransferMetadata
	if err := json.NewDecoder(response.Body).Decode(&metadata); err != nil {
		return fmt.Errorf("decode snapshot import response: %w", err)
	}
	if placement.SnapshotDigest != "" && metadata.Digest != placement.SnapshotDigest {
		return errors.New("imported snapshot digest does not match durable metadata")
	}
	return nil
}

func (c *Controller) deleteSandbox(ctx context.Context, sandboxID string) error {
	placement, err := c.store.GetPlacement(ctx, sandboxID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := c.store.BeginDelete(ctx, placement.SandboxID, placement.Generation); err != nil {
		return err
	}
	deleteErr := c.workerJSON(ctx, placement, http.MethodDelete, workerPath(placement.LocalID, ""), nil, nil)
	if deleteErr != nil && !isWorkerNotFound(deleteErr) {
		_ = c.store.FailCleanup(context.WithoutCancel(ctx), placement.SandboxID,
			placement.Generation, redactedError(deleteErr))
		return deleteErr
	}
	return c.store.Release(ctx, sandboxID, placement.Generation)
}

func (c *Controller) handleCreateIdentity(writer http.ResponseWriter, request *http.Request) {
	id := "msbi_" + uuid.NewString()
	if err := c.store.CreateIdentity(request.Context(), id, time.Now().Add(identityTTL)); err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, sandbox.Identity{ID: id, Managed: true})
}

func (c *Controller) handleGrantPermission(writer http.ResponseWriter, request *http.Request) {
	var grant sandbox.GrantAccessRequest
	if !decodeJSON(writer, request, &grant) {
		return
	}
	id := "msbp_" + uuid.NewString()
	identityID := chi.URLParam(request, "identityID")
	sandboxID := chi.URLParam(request, "sandboxID")
	if len(grant.AllowedUsers) == 0 {
		grant.AllowedUsers = []string{"root"}
	}
	if _, err := c.store.GrantPermission(request.Context(), id, identityID, sandboxID, grant.AllowedUsers); err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, sandbox.AccessGrant{ID: id, AllowedUsers: grant.AllowedUsers})
}

func (c *Controller) handleCreateToken(writer http.ResponseWriter, request *http.Request) {
	token, err := randomToken(32)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "token_generation_failed", "could not generate access token")
		return
	}
	id := "msbg_" + uuid.NewString()
	if err := c.store.CreateAccessGrant(request.Context(), id, chi.URLParam(request, "identityID"), HashAccessToken(token), time.Now().Add(grantTTL)); err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, sandbox.CreatedToken{ID: id, Token: token})
}

func (c *Controller) handleRevokeToken(writer http.ResponseWriter, request *http.Request) {
	if err := c.store.RevokeAccessGrant(request.Context(), chi.URLParam(request, "grantID")); err != nil {
		writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (c *Controller) handleRevokeSandboxAccessGrants(writer http.ResponseWriter, request *http.Request) {
	if err := c.store.RevokeSandboxAccessGrants(request.Context(), chi.URLParam(request, "sandboxID")); err != nil {
		writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (c *Controller) handleValidateAccess(writer http.ResponseWriter, request *http.Request) {
	var validation msb.AccessValidationRequest
	if !decodeJSON(writer, request, &validation) {
		return
	}
	if validation.Protocol == "" {
		validation.Protocol = "ssh"
	}
	response, err := c.store.ValidateAccess(request.Context(), validation, HashAccessToken(validation.Token))
	validation.Token = ""
	if err != nil {
		if errors.Is(err, ErrDenied) {
			writeJSON(writer, http.StatusForbidden, msb.AccessValidationResponse{Allowed: false})
			return
		}
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (c *Controller) handleCreateDomain(writer http.ResponseWriter, request *http.Request) {
	var mapping sandbox.PublishIngressRequest
	if !decodeJSON(writer, request, &mapping) {
		return
	}
	response, err := c.store.PublishIngress(request.Context(), chi.URLParam(request, "domain"), mapping.SandboxID, mapping.Port)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, response)
}

func (c *Controller) handleDeleteDomain(writer http.ResponseWriter, request *http.Request) {
	if err := c.store.RevokeIngress(request.Context(), chi.URLParam(request, "domain")); err != nil {
		writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (c *Controller) handlePreviewPortStream(writer http.ResponseWriter, request *http.Request) {
	if c.bridgeSigner == nil {
		writeError(writer, http.StatusServiceUnavailable, "preview_unavailable", "preview bridge is unavailable")
		return
	}
	target, err := c.store.ResolveDomainMapping(request.Context(), chi.URLParam(request, "domain"))
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	placement := Placement{
		SandboxID: target.SandboxID, LocalID: target.LocalID,
		WorkerID: target.WorkerID, WorkerURL: target.WorkerURL,
		Generation: target.Generation,
	}
	if target.State != "running" {
		placement, err = c.store.GetPlacement(request.Context(), target.SandboxID)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		// Preview hosts carry no caller credential, so any visitor wakes a
		// suspended sandbox and holds its reservation. Log every wake so a
		// crawler keeping a sandbox awake is visible to the operator.
		if _, err := c.startPlacement(request.Context(), placement, sandbox.StartRequest{}); err != nil {
			c.logger.Warn("Microsandbox preview wake failed",
				"domain", target.Domain, "sandbox_id", target.SandboxID, "error", redactedError(err))
			_ = c.store.SetState(context.WithoutCancel(request.Context()), target.SandboxID,
				target.Generation, "running", "degraded", redactedError(err))
			writeControllerError(writer, err)
			return
		}
		c.logger.Info("Microsandbox preview request woke a stopped sandbox",
			"domain", target.Domain, "sandbox_id", target.SandboxID, "observed_state", target.State)
		_ = c.store.SetState(request.Context(), target.SandboxID, target.Generation, "running", "running", "")
	}

	clientSocket, err := websocket.Accept(writer, request, nil)
	if err != nil {
		return
	}
	defer func() { _ = clientSocket.CloseNow() }()
	guest, closeGuest, err := c.dialGuestPort(request.Context(), placement, target.GuestPort)
	if err != nil {
		_ = clientSocket.Close(websocket.StatusTryAgainLater, "preview target unavailable")
		return
	}
	defer closeGuest()
	clientConn := websocket.NetConn(request.Context(), clientSocket, websocket.MessageBinary)
	proxyDuplex(request.Context(), clientConn, guest)
}

func (c *Controller) dialGuestPort(ctx context.Context, placement Placement, port int32) (net.Conn, func(), error) {
	workerURL, err := websocketURL(placement.WorkerURL, workerPath(placement.LocalID, "/ssh"))
	if err != nil {
		return nil, func() {}, err
	}
	headers := http.Header{}
	headers.Set(msb.PlacementGenerationHeader, strconv.FormatInt(placement.Generation, 10))
	headers.Set(msb.WorkerIDHeader, placement.WorkerID)
	headers.Set(msb.SSHGuestUserHeader, "root")
	workerSocket, response, err := websocket.Dial(ctx, workerURL, &websocket.DialOptions{HTTPClient: c.streamClient, HTTPHeader: headers})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return nil, func() {}, fmt.Errorf("open worker SSH bridge: %w", err)
	}
	stream := websocket.NetConn(ctx, workerSocket, websocket.MessageBinary)
	sshConfig := &gossh.ClientConfig{
		User: "root",
		Auth: []gossh.AuthMethod{gossh.PublicKeys(c.bridgeSigner)},
		// The placement-fenced mTLS worker is the trust root for this private,
		// ephemeral guest transport; guest host keys are not public identities.
		HostKeyCallback: func(string, net.Addr, gossh.PublicKey) error { return nil },
		Timeout:         15 * time.Second,
	}
	connection, channels, requests, err := gossh.NewClientConn(stream, "microsandbox-private", sshConfig)
	if err != nil {
		_ = stream.Close()
		_ = workerSocket.CloseNow()
		return nil, func() {}, fmt.Errorf("authenticate worker SSH bridge: %w", err)
	}
	client := gossh.NewClient(connection, channels, requests)
	closeAll := func() {
		_ = client.Close()
		_ = stream.Close()
		_ = workerSocket.CloseNow()
	}
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port)))
	deadline := time.Now().Add(30 * time.Second)
	for {
		guest, dialErr := client.Dial("tcp", address)
		if dialErr == nil {
			return guest, closeAll, nil
		}
		if time.Now().After(deadline) {
			closeAll()
			return nil, func() {}, fmt.Errorf("dial guest preview port: %w", dialErr)
		}
		select {
		case <-ctx.Done():
			closeAll()
			return nil, func() {}, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (c *Controller) handleSSHStream(writer http.ResponseWriter, request *http.Request) {
	sandboxID := chi.URLParam(request, "sandboxID")
	token := request.Header.Get("X-Plue-Access-Token")
	user := request.URL.Query().Get("user")
	validation := msb.AccessValidationRequest{SandboxID: sandboxID, Token: token, User: user, Protocol: "ssh"}
	access, err := c.store.ValidateAccess(request.Context(), validation, HashAccessToken(token))
	if err != nil || !access.Allowed {
		writeError(writer, http.StatusForbidden, "access_denied", "sandbox SSH grant is invalid or expired")
		return
	}
	// A grant outlives a suspend. Bridging a stopped placement would let the
	// worker cold-boot the guest outside startPlacement, skipping the compute
	// reservation and the egress proxy, so only a running placement of the
	// granted generation is bridged.
	placement, err := c.store.GetPlacement(request.Context(), sandboxID)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if placement.ObservedState != "running" || placement.Generation != access.Generation {
		writeError(writer, http.StatusConflict, "sandbox_not_running", "sandbox must be running before an SSH session can attach")
		return
	}

	clientSocket, err := websocket.Accept(writer, request, nil)
	if err != nil {
		return
	}
	defer func() { _ = clientSocket.CloseNow() }()

	workerURL, err := websocketURL(access.WorkerURL, "/internal/v1/sandboxes/"+url.PathEscape(access.LocalID)+"/ssh")
	if err != nil {
		_ = clientSocket.Close(websocket.StatusInternalError, "invalid worker URL")
		return
	}
	headers := http.Header{}
	headers.Set(msb.PlacementGenerationHeader, strconv.FormatInt(access.Generation, 10))
	headers.Set(msb.WorkerIDHeader, access.WorkerID)
	headers.Set(msb.SSHGuestUserHeader, user)
	workerSocket, _, err := websocket.Dial(request.Context(), workerURL, &websocket.DialOptions{HTTPClient: c.streamClient, HTTPHeader: headers}) //nolint:bodyclose // websocket.Dial closes the handshake response body
	if err != nil {
		_ = clientSocket.Close(websocket.StatusTryAgainLater, "worker stream unavailable")
		return
	}
	defer func() { _ = workerSocket.CloseNow() }()

	clientConn := websocket.NetConn(request.Context(), clientSocket, websocket.MessageBinary)
	workerConn := websocket.NetConn(request.Context(), workerSocket, websocket.MessageBinary)
	proxyDuplex(request.Context(), clientConn, workerConn)
}

func (c *Controller) placement(writer http.ResponseWriter, request *http.Request) (Placement, bool) {
	placement, err := c.store.GetPlacement(request.Context(), chi.URLParam(request, "sandboxID"))
	if err != nil {
		writeStoreError(writer, err)
		return Placement{}, false
	}
	return placement, true
}

func (c *Controller) workerJSON(ctx context.Context, placement Placement, method, path string, body, output any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	response, err := c.workerRequest(ctx, placement, method, path, reader)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return &workerError{Status: response.StatusCode, Body: string(payload)}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	if err := json.NewDecoder(response.Body).Decode(output); err != nil {
		return fmt.Errorf("decode worker response: %w", err)
	}
	return nil
}

func (c *Controller) workerRequest(ctx context.Context, placement Placement, method, path string, body io.Reader) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(placement.WorkerURL, "/")+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set(msb.PlacementGenerationHeader, strconv.FormatInt(placement.Generation, 10))
	request.Header.Set(msb.WorkerIDHeader, placement.WorkerID)
	if body != nil {
		contentType := "application/json"
		if method == http.MethodPut && strings.HasSuffix(path, "/import") {
			contentType = "application/x-tar"
		}
		request.Header.Set("Content-Type", contentType)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("worker request: %w", err)
	}
	return response, nil
}

func workerPath(localID, suffix string) string {
	return "/internal/v1/sandboxes/" + url.PathEscape(localID) + suffix
}

func websocketURL(baseURL, path string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported worker URL scheme %q", parsed.Scheme)
	}
	return parsed.String(), nil
}

func proxyDuplex(ctx context.Context, left, right io.ReadWriteCloser) {
	var once sync.Once
	closeBoth := func() {
		_ = left.Close()
		_ = right.Close()
	}
	done := make(chan struct{}, 2)
	copySide := func(destination io.Writer, source io.Reader) {
		_, _ = io.Copy(destination, source)
		once.Do(closeBoth)
		done <- struct{}{}
	}
	go copySide(left, right)
	go copySide(right, left)
	select {
	case <-ctx.Done():
		once.Do(closeBoth)
	case <-done:
	}
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, destination any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, maxRequestBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_json", "request body is invalid")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "invalid_json", "request body must contain exactly one JSON value")
		return false
	}
	return true
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, msb.ErrorEnvelope{Error: msb.ProviderError{Code: code, Message: message}})
}

func writeStoreError(writer http.ResponseWriter, err error) {
	switch {
	// Must precede the ErrNotFound arm: ErrSnapshotNotFound wraps it. Clients
	// classify a bad golden snapshot off this machine-readable code, so it can
	// never collapse back into the generic not_found envelope.
	case errors.Is(err, ErrSnapshotNotFound):
		writeError(writer, http.StatusNotFound, "snapshot_not_found", "sandbox snapshot was not found")
	case errors.Is(err, ErrNotFound):
		writeError(writer, http.StatusNotFound, "not_found", "sandbox resource was not found")
	case errors.Is(err, ErrNoCapacity):
		writeError(writer, http.StatusServiceUnavailable, "no_capacity", err.Error())
	case errors.Is(err, ErrStale):
		writeError(writer, http.StatusConflict, "stale_generation", err.Error())
	case errors.Is(err, ErrDenied):
		writeError(writer, http.StatusForbidden, "access_denied", "access grant denied")
	case errors.Is(err, ErrSnapshotInUse):
		writeError(writer, http.StatusConflict, "snapshot_in_use", err.Error())
	case errors.Is(err, ErrOperationInProgress):
		writeError(writer, http.StatusConflict, "operation_in_progress", err.Error())
	default:
		writeError(writer, http.StatusInternalServerError, "internal_error", "sandbox control operation failed")
	}
}

func writeControllerError(writer http.ResponseWriter, err error) {
	var requestErr *requestError
	if errors.As(err, &requestErr) {
		writeError(writer, requestErr.Status, requestErr.Code, requestErr.Message)
		return
	}
	var workerErr *workerError
	if errors.As(err, &workerErr) {
		code := "worker_error"
		if workerErr.Status == http.StatusNotFound {
			code = "not_found"
		}
		if passthrough := workerErrorCode(workerErr); passthrough != "" {
			code = passthrough
		}
		writeError(writer, workerErr.Status, code, "Microsandbox worker operation failed")
		return
	}
	writeStoreError(writer, err)
}

// workerErrorCode surfaces contract error codes the API caller must be able to
// distinguish. Only known codes pass through; worker error bodies are never
// echoed to clients.
func workerErrorCode(workerErr *workerError) string {
	var envelope msb.ErrorEnvelope
	if json.Unmarshal([]byte(workerErr.Body), &envelope) != nil {
		return ""
	}
	switch envelope.Error.Code {
	case "secret_delivery_unavailable", "egress_proxy_unavailable", "stale_generation", "quiesce_failed":
		return envelope.Error.Code
	}
	return ""
}

type requestError struct {
	Status  int
	Code    string
	Message string
}

func (e *requestError) Error() string { return e.Message }

type workerError struct {
	Status int
	Body   string
}

func (e *workerError) Error() string { return fmt.Sprintf("worker returned status %d", e.Status) }

func isWorkerNotFound(err error) bool {
	var workerErr *workerError
	return errors.As(err, &workerErr) && workerErr.Status == http.StatusNotFound
}

func randomToken(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func redactedError(err error) string {
	var workerErr *workerError
	if errors.As(err, &workerErr) {
		return fmt.Sprintf("worker status %d", workerErr.Status)
	}
	return "worker transport failed"
}

// handleRevokeEgress forwards an egress revocation to the worker holding the
// sandbox. A sandbox that is not running has no proxy, so the goal state (no
// egress) already holds and the answer is Revoked=false without a worker call.
func (c *Controller) handleRevokeEgress(writer http.ResponseWriter, request *http.Request) {
	placement, ok := c.placement(writer, request)
	if !ok {
		return
	}
	var req sandbox.EgressRevokeRequest
	if request.Body != nil && request.ContentLength != 0 {
		if !decodeJSON(writer, request, &req) {
			return
		}
	}
	if alreadyNotRunning(placement) {
		writeJSON(writer, http.StatusOK, sandbox.EgressRevokeResult{SandboxID: placement.SandboxID})
		return
	}
	var response sandbox.EgressRevokeResult
	if err := c.workerJSON(request.Context(), placement, http.MethodPost, workerPath(placement.LocalID, "/egress/revoke"), req, &response); err != nil {
		writeControllerError(writer, err)
		return
	}
	response.SandboxID = placement.SandboxID
	writeJSON(writer, http.StatusOK, response)
}
