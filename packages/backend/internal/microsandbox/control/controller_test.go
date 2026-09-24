package control

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	msbworker "github.com/smithersai/smithers/packages/backend/internal/microsandbox/worker"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type storedOperation struct {
	digest   string
	response OperationResponse
	complete bool
}

type controllerTestStore struct {
	Store
	mu                    sync.Mutex
	workerURL             string
	placement             *Placement
	allocateCalls         int
	allocatedRequest      sandbox.CreateRequest
	sanitizedRequest      json.RawMessage
	operations            map[string]storedOperation
	accessGrantCalls      int
	revokedAccessTarget   string
	storedOperationBodies [][]byte
	completeContextErr    error
	heartbeatCalls        int
	previewResolveCalls   int
	previewTarget         *msb.PreviewTarget
	// Reservation accounting mirror. Stored inverted so the zero value matches
	// a freshly allocated placement, which holds its reservation.
	reservationReleased     bool
	reservationReleases     int
	reservationAcquires     int
	acquireReservationError error
	setStateCalls           int
	queuedCreateCleanups    []string
	validateAccessFn        func(msb.AccessValidationRequest) (msb.AccessValidationResponse, error)
	completedRecovery       struct {
		id         string
		generation int64
		observed   string
	}
	egressAuditWorkerID string
	egressAuditRecords  []msb.SandboxEgressAuditRecord
}

func (s *controllerTestStore) InsertEgressAuditBatch(_ context.Context, workerID string, records []msb.SandboxEgressAuditRecord) (int64, error) {
	s.egressAuditWorkerID = workerID
	s.egressAuditRecords = append(s.egressAuditRecords, records...)
	return int64(len(records)), nil
}

func (s *controllerTestStore) Heartbeat(_ context.Context, _ msb.WorkerHeartbeat) (msb.WorkerHeartbeatResponse, error) {
	s.heartbeatCalls++
	return msb.WorkerHeartbeatResponse{Accepted: true, Authorized: true, AdmitNew: true, State: "ready"}, nil
}

func (s *controllerTestStore) ReleaseReservation(_ context.Context, _ string, _ int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reservationReleased {
		return nil
	}
	s.reservationReleased = true
	s.reservationReleases++
	return nil
}

func (s *controllerTestStore) AcquireReservation(_ context.Context, _ string, _ int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.acquireReservationError != nil {
		return false, s.acquireReservationError
	}
	if !s.reservationReleased {
		return false, nil
	}
	s.reservationReleased = false
	s.reservationAcquires++
	return true, nil
}

func TestControllerRequiresSignedWorkerHeartbeat(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	heartbeat := msb.WorkerHeartbeat{WorkerID: "worker-a", BootID: "boot-a", BaseURL: "https://worker-a.internal", State: "ready"}
	require.NoError(t, msb.SignWorkerHeartbeat(&heartbeat, privateKey))
	payload, err := json.Marshal(heartbeat)
	require.NoError(t, err)
	store := &controllerTestStore{}
	controller := New(store, Config{AllowInsecureDev: true})
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/workers/heartbeat", bytes.NewReader(payload))
	response := httptest.NewRecorder()
	controller.ServeHTTP(response, request)
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, 1, store.heartbeatCalls)

	heartbeat.BaseURL = "https://attacker.internal"
	payload, err = json.Marshal(heartbeat)
	require.NoError(t, err)
	request = httptest.NewRequest(http.MethodPost, "/internal/v1/workers/heartbeat", bytes.NewReader(payload))
	response = httptest.NewRecorder()
	controller.ServeHTTP(response, request)
	assert.Equal(t, http.StatusForbidden, response.Code)
	assert.Equal(t, 1, store.heartbeatCalls)
}

func TestControllerPersistsSafeEgressAuditAndRefusesCredentialShapedRecord(t *testing.T) {
	store := &controllerTestStore{}
	controller := New(store, Config{AllowInsecureDev: true})
	batch := msb.WorkerEgressAuditBatch{WorkerID: "worker-a", Records: []msb.SandboxEgressAuditRecord{
		{SandboxID: "msb_safe", OccurredAt: time.Now(), Host: "api.cerebras.ai", Method: "POST", Path: "/v1/chat", Status: 200, Allowed: true, SwappedSecretNames: []string{"CEREBRAS_API_KEY"}, TransformSummary: json.RawMessage(`{"swapped_secret_count":1}`)},
		{SandboxID: "msb_unsafe", OccurredAt: time.Now(), Host: "api.openai.com", Method: "POST", Path: "/sk-proj-abcdefghijklmnopqrstuvwxyzABCDEF", Status: 200, Allowed: true, TransformSummary: json.RawMessage(`{}`)},
		{SandboxID: "msb_query", OccurredAt: time.Now(), Host: "example.com", Method: "GET", Path: "/search?token=ordinary-value", Status: 200, Allowed: true, TransformSummary: json.RawMessage(`{}`)},
	}}
	payload, err := json.Marshal(batch)
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/workers/egress-audit", bytes.NewReader(payload))
	response := httptest.NewRecorder()
	controller.ServeHTTP(response, request)
	require.Equal(t, http.StatusAccepted, response.Code)
	assert.Equal(t, "worker-a", store.egressAuditWorkerID)
	assert.Len(t, store.egressAuditRecords, 1)
	assert.Equal(t, "msb_safe", store.egressAuditRecords[0].SandboxID)
	var result msb.WorkerEgressAuditResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	assert.Equal(t, 1, result.Accepted)
	assert.Equal(t, 2, result.Rejected)
}

type denyingHeartbeatStore struct {
	Store
	denial *HeartbeatDenial
}

func (s *denyingHeartbeatStore) Heartbeat(context.Context, msb.WorkerHeartbeat) (msb.WorkerHeartbeatResponse, error) {
	return msb.WorkerHeartbeatResponse{}, s.denial
}

// A heartbeat denial must be observable on the controller: a machine-readable
// code in the response body AND a log line naming the worker and the reason.
// The 2026-08-05 relocation incident was undiagnosable precisely because the
// denial produced neither.
func TestControllerHeartbeatDenialSurfacesCodeAndLogs(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	heartbeat := msb.WorkerHeartbeat{WorkerID: "worker-relocated", BootID: "boot-b", BaseURL: "https://worker-new-node.internal", State: "ready"}
	require.NoError(t, msb.SignWorkerHeartbeat(&heartbeat, privateKey))
	payload, err := json.Marshal(heartbeat)
	require.NoError(t, err)

	var logs bytes.Buffer
	controller := New(&denyingHeartbeatStore{denial: &HeartbeatDenial{
		Code: "worker_identity_conflict", Message: "worker id is bound to a different identity key",
	}}, Config{AllowInsecureDev: true, Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/workers/heartbeat", bytes.NewReader(payload))
	response := httptest.NewRecorder()
	controller.ServeHTTP(response, request)

	assert.Equal(t, http.StatusForbidden, response.Code)
	assert.Contains(t, response.Body.String(), "worker_identity_conflict")
	assert.Contains(t, response.Body.String(), "different identity key")
	logged := logs.String()
	assert.Contains(t, logged, "heartbeat denied")
	assert.Contains(t, logged, "worker-relocated")
	assert.Contains(t, logged, "worker_identity_conflict")
}

func (s *controllerTestStore) Allocate(_ context.Context, id string, request sandbox.CreateRequest, sanitized json.RawMessage, _ ResourceOwner) (Placement, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.allocateCalls++
	s.allocatedRequest = request
	s.sanitizedRequest = append([]byte(nil), sanitized...)
	return Placement{SandboxID: id, LocalID: id, WorkerID: "worker-a", WorkerURL: s.workerURL, Generation: 1}, nil
}

type createContractRuntime struct {
	msbworker.Runtime
	request sandbox.CreateRequest
}

func (r *createContractRuntime) Create(_ context.Context, id string, _ int64, request sandbox.CreateRequest) (sandbox.CreateResult, error) {
	r.request = request
	return sandbox.CreateResult{ID: id}, nil
}

// The API client, controller, and worker are released separately and both
// servers reject unknown JSON fields. Exercise the real strict decoders on
// both hops so additions to the provider-neutral create contract cannot land
// with coverage at only one boundary.
func TestCreateRequestRoundTripsControllerAndWorkerDecoders(t *testing.T) {
	state, err := msbworker.LoadState(t.TempDir() + "/state.json")
	require.NoError(t, err)
	runtime := &createContractRuntime{}
	worker := msbworker.NewServer(msbworker.ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	worker.AuthorizeUntil(time.Now().Add(time.Minute), true)
	workerServer := httptest.NewServer(worker)
	defer workerServer.Close()

	store := &controllerTestStore{workerURL: workerServer.URL}
	controllerServer := httptest.NewServer(New(store, Config{APIKey: "api-key", AllowInsecureDev: true}))
	defer controllerServer.Close()

	rootfsSizeMB := int64(12 * 1024)
	request := sandbox.CreateRequest{
		Kind:         "vm",
		Image:        "image@sha256:contract",
		RootfsSizeMB: &rootfsSizeMB,
		Init: &sandbox.ServiceConfig{Enabled: true, Services: []sandbox.ServiceSpec{{
			Name: "agent", Exec: []string{"/bin/agent"}, Env: map[string]string{"API_TOKEN": "proxy-placeholder"},
		}}},
		EgressProxy: &sandbox.EgressProxyPolicy{Enabled: true, AllowDomains: []string{"api.example.com"}, Secrets: []sandbox.EgressProxySecret{{
			Name: "API_TOKEN", Value: "operation-only-value", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"},
		}}},
	}
	client := msb.NewClient(controllerServer.URL, "api-key")
	result, err := client.CreateSandbox(sandbox.WithIdempotencyKey(context.Background(), "create-contract"), request)
	require.NoError(t, err)
	assert.NotEmpty(t, result.ID)
	assert.Equal(t, request, runtime.request)
}

func TestControllerSecretSentinelIsTransientAndAbsentFromDurableOperationState(t *testing.T) {
	const sentinel = "plue-secret-sentinel-never-persist"
	var workerSawSentinel bool
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		workerSawSentinel = bytes.Contains(payload, []byte(sentinel))
		var create msb.WorkerCreateRequest
		require.NoError(t, json.Unmarshal(payload, &create))
		writeJSON(writer, http.StatusCreated, sandbox.CreateResult{ID: create.SandboxID})
	}))
	defer worker.Close()

	store := &controllerTestStore{workerURL: worker.URL}
	controller := New(store, Config{APIKey: "api-key", DefaultImage: "image@sha256:one", AllowInsecureDev: true})
	body := `{"init":{"services":[{"name":"agent","exec":["/bin/agent"],"env":{"TOKEN":"` + sentinel + `"}}]}}`
	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "sentinel-create", body)
	require.Equal(t, http.StatusCreated, response.Code)
	assert.True(t, workerSawSentinel, "the selected worker needs the secret for this one operation")
	assert.NotContains(t, string(store.sanitizedRequest), sentinel)
	assert.Contains(t, string(store.sanitizedRequest), "[redacted]")
	assert.NotContains(t, response.Body.String(), sentinel)
	for _, storedBody := range store.storedOperationBodies {
		assert.NotContains(t, string(storedBody), sentinel)
	}
}

// Egress-proxy secret values ride the same one-shot channel as service env:
// the selected worker sees them once, and nothing durable (allocation
// request, operation record, response) ever does.
func TestControllerEgressProxySecretSentinelIsTransientAndAbsentFromDurableState(t *testing.T) {
	const sentinel = "plue-egress-secret-sentinel-never-persist"
	var workerSawSentinel bool
	var workerSawBinding bool
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		workerSawSentinel = bytes.Contains(payload, []byte(sentinel))
		var create msb.WorkerCreateRequest
		require.NoError(t, json.Unmarshal(payload, &create))
		workerSawBinding = create.Request.EgressProxy != nil && len(create.Request.EgressProxy.Secrets) == 1 &&
			create.Request.EgressProxy.Secrets[0].Hosts[0] == "api.anthropic.com"
		writeJSON(writer, http.StatusCreated, sandbox.CreateResult{ID: create.SandboxID})
	}))
	defer worker.Close()

	store := &controllerTestStore{workerURL: worker.URL}
	controller := New(store, Config{APIKey: "api-key", DefaultImage: "image@sha256:one", AllowInsecureDev: true})
	body := `{"egressProxy":{"enabled":true,"secrets":[{"name":"ANTHROPIC_API_KEY","value":"` + sentinel +
		`","hosts":["api.anthropic.com"],"matchHeaders":["x-api-key"]}]}}`
	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "egress-sentinel-create", body)
	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	assert.True(t, workerSawSentinel, "the selected worker needs the value once to seed its proxy process")
	assert.True(t, workerSawBinding, "the binding declaration reaches the worker intact")
	assert.NotContains(t, string(store.sanitizedRequest), sentinel)
	assert.Contains(t, string(store.sanitizedRequest), `"hosts":["api.anthropic.com"]`, "the non-secret binding is durable for recovery")
	assert.NotContains(t, response.Body.String(), sentinel)
	for _, storedBody := range store.storedOperationBodies {
		assert.NotContains(t, string(storedBody), sentinel)
	}
}

func TestControllerPassesThroughEgressProxyUnavailableWithoutEchoingValues(t *testing.T) {
	const sentinel = "plue-egress-secret-sentinel-unavailable"
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeError(writer, http.StatusServiceUnavailable, "egress_proxy_unavailable",
			"per-sandbox egress proxy is unavailable on this worker")
	}))
	defer worker.Close()

	store := &controllerTestStore{workerURL: worker.URL}
	controller := New(store, Config{APIKey: "api-key", DefaultImage: "image@sha256:one", AllowInsecureDev: true})
	body := `{"egressProxy":{"enabled":true,"secrets":[{"name":"TOKEN","value":"` + sentinel +
		`","hosts":["example.test"],"matchHeaders":["authorization"]}]}}`
	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "egress-unavailable", body)
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "egress_proxy_unavailable")
	assert.NotContains(t, response.Body.String(), sentinel)
	assert.Len(t, store.queuedCreateCleanups, 1, "the refused placement is parked for reconciled cleanup like any failed create")
	for _, storedBody := range store.storedOperationBodies {
		assert.NotContains(t, string(storedBody), sentinel)
	}
}

func (s *controllerTestStore) SetState(context.Context, string, int64, string, string, string) error {
	s.setStateCalls++
	return nil
}

func (s *controllerTestStore) QueueFailedCreateCleanup(_ context.Context, id string, _ int64, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queuedCreateCleanups = append(s.queuedCreateCleanups, id)
	return nil
}

// A failed create must be parked as pending cleanup, not released best-effort:
// the reconcile loop retries the worker delete and tombstones the row, so a
// transient store failure cannot strand the placement in observed_state
// 'failed' forever (production parked two rows for nine days on 2026-08-10).
func TestControllerQueuesCleanupWhenWorkerCreateFails(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeError(writer, http.StatusBadGateway, "worker_unavailable", "worker exploded")
	}))
	defer worker.Close()

	store := &controllerTestStore{workerURL: worker.URL}
	controller := New(store, Config{APIKey: "api-key", DefaultImage: "image@sha256:one", AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "create-fails", `{"image":"image@sha256:one"}`)
	require.NotEqual(t, http.StatusCreated, response.Code)
	assert.Len(t, store.queuedCreateCleanups, 1, "failed create must be queued for reconciled cleanup")
}

func (s *controllerTestStore) RecordService(context.Context, string, int64, json.RawMessage) error {
	return nil
}

func (s *controllerTestStore) ResolveDomainMapping(context.Context, string) (msb.PreviewTarget, error) {
	s.previewResolveCalls++
	if s.previewTarget != nil {
		return *s.previewTarget, nil
	}
	return msb.PreviewTarget{}, ErrNotFound
}

func (s *controllerTestStore) ValidateAccess(_ context.Context, request msb.AccessValidationRequest, _ []byte) (msb.AccessValidationResponse, error) {
	if s.validateAccessFn == nil {
		return msb.AccessValidationResponse{}, ErrDenied
	}
	return s.validateAccessFn(request)
}

func TestControllerPassesThroughSecretDeliveryUnavailableWithoutEchoingValues(t *testing.T) {
	const sentinel = "plue-secret-sentinel-exec-fail-closed"
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeError(writer, http.StatusNotImplemented, "secret_delivery_unavailable",
			"operation-scoped secret delivery is unavailable")
	}))
	defer worker.Close()

	store := &controllerTestStore{workerURL: worker.URL}
	controller := New(store, Config{APIKey: "api-key", DefaultImage: "image@sha256:one", AllowInsecureDev: true})
	body := `{"command":"env","secrets":{"TOKEN":"` + sentinel + `"}}`
	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_x/exec", "secret-exec", body)
	require.Equal(t, http.StatusNotImplemented, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "secret_delivery_unavailable")
	assert.NotContains(t, response.Body.String(), sentinel)
	for _, storedBody := range store.storedOperationBodies {
		assert.NotContains(t, string(storedBody), sentinel)
	}
}

func TestControllerFailsClosedWhenAuthenticationIsUnconfigured(t *testing.T) {
	controller := New(&controllerTestStore{}, Config{})
	request := httptest.NewRequest(http.MethodGet, "/v1/sandboxes/msb_test", nil)
	response := httptest.NewRecorder()
	controller.ServeHTTP(response, request)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.Contains(t, response.Body.String(), "authentication_not_configured")
}

func TestPreviewRouteRequiresPreviewScopedIdentityAndKey(t *testing.T) {
	store := &controllerTestStore{}
	_, bridgeKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	bridgeSigner, err := gossh.NewSignerFromKey(bridgeKey)
	require.NoError(t, err)
	controller := New(store, Config{
		APIKey: "admin-key", PreviewAPIKey: "preview-key",
		APIClientIdentity: "plue-microsandbox-api", PreviewClientIdentity: "plue-microsandbox-preview",
		BridgeSigner: bridgeSigner,
	})

	request := httptest.NewRequest(http.MethodGet, "/v1/domains/example.preview.jjhub.tech/port", nil)
	request.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Subject: pkix.Name{CommonName: "plue-microsandbox-api"}}}}
	request.Header.Set("Authorization", "Bearer admin-key")
	response := httptest.NewRecorder()
	controller.ServeHTTP(response, request)
	assert.Equal(t, http.StatusForbidden, response.Code)

	request = httptest.NewRequest(http.MethodGet, "/v1/domains/example.preview.jjhub.tech/port", nil)
	request.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Subject: pkix.Name{CommonName: "plue-microsandbox-preview"}}}}
	request.Header.Set("Authorization", "Bearer admin-key")
	response = httptest.NewRecorder()
	controller.ServeHTTP(response, request)
	assert.Equal(t, http.StatusUnauthorized, response.Code)

	request = httptest.NewRequest(http.MethodGet, "/v1/domains/example.preview.jjhub.tech/port", nil)
	request.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Subject: pkix.Name{CommonName: "plue-microsandbox-preview"}}}}
	request.Header.Set("Authorization", "Bearer preview-key")
	response = httptest.NewRecorder()
	controller.ServeHTTP(response, request)
	assert.Equal(t, http.StatusNotFound, response.Code)
	assert.Equal(t, 1, store.previewResolveCalls)
}

// A preview hit on a suspended sandbox boots it with no caller credential.
// Every such wake must leave an operator-visible trace naming the domain and
// sandbox, so a crawler holding the sandbox awake is diagnosable.
func TestPreviewWakeOfStoppedSandboxIsLogged(t *testing.T) {
	var startCalls atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/start") {
			startCalls.Add(1)
		}
		writeJSON(writer, http.StatusOK, sandbox.StartResult{})
	}))
	defer worker.Close()
	store := &controllerTestStore{
		workerURL: worker.URL,
		placement: &Placement{WorkerID: "worker-a", Generation: 3, DesiredState: "stopped", ObservedState: "running"},
		previewTarget: &msb.PreviewTarget{
			Domain: "shared.preview.jjhub.tech", SandboxID: "msb_sleepy", LocalID: "msb_sleepy",
			WorkerID: "worker-a", WorkerURL: worker.URL, Generation: 3, GuestPort: 3000, State: "stopped",
		},
	}
	_, bridgeKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	bridgeSigner, err := gossh.NewSignerFromKey(bridgeKey)
	require.NoError(t, err)
	var logs bytes.Buffer
	controller := New(store, Config{
		PreviewAPIKey: "preview-key", PreviewClientIdentity: "plue-microsandbox-preview",
		BridgeSigner: bridgeSigner, Logger: slog.New(slog.NewTextHandler(&logs, nil)),
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/domains/shared.preview.jjhub.tech/port", nil)
	request.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Subject: pkix.Name{CommonName: "plue-microsandbox-preview"}}}}
	request.Header.Set("Authorization", "Bearer preview-key")
	controller.ServeHTTP(httptest.NewRecorder(), request)

	require.EqualValues(t, 1, startCalls.Load())
	assert.Contains(t, logs.String(), "Microsandbox preview request woke a stopped sandbox")
	assert.Contains(t, logs.String(), "domain=shared.preview.jjhub.tech")
	assert.Contains(t, logs.String(), "sandbox_id=msb_sleepy")
}

func TestSSHStreamRejectsInvalidGrantAndBindsAuthorizedGuestUser(t *testing.T) {
	workerSawUser := make(chan string, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		workerSawUser <- request.Header.Get(msb.SSHGuestUserHeader)
		assert.Equal(t, "7", request.Header.Get(msb.PlacementGenerationHeader))
		assert.Equal(t, "worker-a", request.Header.Get(msb.WorkerIDHeader))
		socket, err := websocket.Accept(writer, request, nil)
		if !assert.NoError(t, err) {
			return
		}
		defer socket.CloseNow()
		kind, payload, err := socket.Read(request.Context())
		if !assert.NoError(t, err) {
			return
		}
		assert.Equal(t, websocket.MessageBinary, kind)
		_ = socket.Write(request.Context(), websocket.MessageBinary, payload)
	}))
	defer worker.Close()

	store := &controllerTestStore{validateAccessFn: func(request msb.AccessValidationRequest) (msb.AccessValidationResponse, error) {
		if request.Token != "valid-grant" || request.User != "developer" || request.Protocol != "ssh" {
			return msb.AccessValidationResponse{}, ErrDenied
		}
		return msb.AccessValidationResponse{
			Allowed: true, SandboxID: request.SandboxID, LocalID: request.SandboxID,
			WorkerID: "worker-a", WorkerURL: worker.URL, Generation: 7,
		}, nil
	}}
	store.placement = &Placement{WorkerID: "worker-a", Generation: 7, DesiredState: "running", ObservedState: "running"}
	controllerServer := httptest.NewServer(New(store, Config{AllowInsecureDev: true}))
	defer controllerServer.Close()
	endpoint := "ws" + strings.TrimPrefix(controllerServer.URL, "http") + "/v1/sandboxes/msb_stream/ssh?user=developer"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	badHeaders := http.Header{"X-Plue-Access-Token": []string{"invalid-grant"}}
	badSocket, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: badHeaders})
	if badSocket != nil {
		badSocket.CloseNow()
	}
	require.Error(t, err)
	require.NotNil(t, response)
	assert.Equal(t, http.StatusForbidden, response.StatusCode)
	_ = response.Body.Close()

	headers := http.Header{"X-Plue-Access-Token": []string{"valid-grant"}}
	socket, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: headers})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	defer socket.CloseNow()
	require.NoError(t, socket.Write(ctx, websocket.MessageBinary, []byte("ssh-transport")))
	kind, payload, err := socket.Read(ctx)
	require.NoError(t, err)
	assert.Equal(t, websocket.MessageBinary, kind)
	assert.Equal(t, []byte("ssh-transport"), payload)
	assert.Equal(t, "developer", <-workerSawUser)
}

// A still-valid SSH grant must not wake a suspended sandbox: the worker
// bridge would cold-boot the guest outside admission, so the compute
// reservation and egress proxy would be skipped. Only a running placement
// is bridged.
func TestSSHStreamRefusesStoppedPlacementWithoutDialingWorker(t *testing.T) {
	var workerDials atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		workerDials.Add(1)
	}))
	defer worker.Close()

	for _, observed := range []string{"stopped", "degraded", "starting"} {
		t.Run(observed, func(t *testing.T) {
			store := &controllerTestStore{
				workerURL: worker.URL,
				placement: &Placement{WorkerID: "worker-a", Generation: 7, DesiredState: "stopped", ObservedState: observed},
				validateAccessFn: func(request msb.AccessValidationRequest) (msb.AccessValidationResponse, error) {
					return msb.AccessValidationResponse{
						Allowed: true, SandboxID: request.SandboxID, LocalID: request.SandboxID,
						WorkerID: "worker-a", WorkerURL: worker.URL, Generation: 7,
					}, nil
				},
			}
			controllerServer := httptest.NewServer(New(store, Config{AllowInsecureDev: true}))
			defer controllerServer.Close()
			endpoint := "ws" + strings.TrimPrefix(controllerServer.URL, "http") + "/v1/sandboxes/msb_stream/ssh?user=developer"
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			socket, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
				HTTPHeader: http.Header{"X-Plue-Access-Token": []string{"valid-grant"}},
			})
			if socket != nil {
				_ = socket.CloseNow()
			}
			require.Error(t, err)
			require.NotNil(t, response)
			assert.Equal(t, http.StatusConflict, response.StatusCode)
			_ = response.Body.Close()
			assert.Zero(t, store.reservationAcquires)
		})
	}
	assert.Zero(t, workerDials.Load(), "a stopped placement must never reach the worker SSH bridge")
}

func (s *controllerTestStore) GetPlacement(_ context.Context, id string) (Placement, error) {
	if s.placement != nil {
		placement := *s.placement
		if placement.SandboxID == "" {
			placement.SandboxID = id
		}
		if placement.LocalID == "" {
			placement.LocalID = id
		}
		if placement.WorkerURL == "" {
			placement.WorkerURL = s.workerURL
		}
		return placement, nil
	}
	return Placement{SandboxID: id, LocalID: id, WorkerID: "worker-a", WorkerURL: s.workerURL, Generation: 1}, nil
}

func (s *controllerTestStore) BindOperation(context.Context, string, string) error { return nil }

func (s *controllerTestStore) BeginOperation(_ context.Context, key, _ string, digest string) (OperationResponse, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.operations == nil {
		s.operations = make(map[string]storedOperation)
	}
	operation, ok := s.operations[key]
	if !ok {
		s.operations[key] = storedOperation{digest: digest}
		return OperationResponse{}, true, nil
	}
	if operation.digest != digest {
		return OperationResponse{}, false, ErrIdempotencyConflict
	}
	if !operation.complete {
		return OperationResponse{}, false, ErrOperationInProgress
	}
	return operation.response, false, nil
}

func (s *controllerTestStore) CompleteOperation(ctx context.Context, key string, response OperationResponse) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completeContextErr = ctx.Err()
	operation := s.operations[key]
	response.Body = append([]byte(nil), response.Body...)
	operation.response = response
	operation.complete = true
	s.operations[key] = operation
	s.storedOperationBodies = append(s.storedOperationBodies, append([]byte(nil), response.Body...))
	return nil
}

func TestControllerCompletesIdempotencyRecordAfterCallerCancellation(t *testing.T) {
	store := &controllerTestStore{}
	controller := New(store, Config{AllowInsecureDev: true})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/v1/access/identities/msbi_cancelled/tokens", nil).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "cancelled-token")
	response := httptest.NewRecorder()
	controller.ServeHTTP(response, request)

	assert.Equal(t, http.StatusCreated, response.Code)
	assert.NoError(t, store.completeContextErr, "operation finalization must outlive the disconnected caller")
}

func TestControllerReplaysDeferredCleanupHeader(t *testing.T) {
	const operation = "DELETE /v1/sandboxes/msb_pending"
	digestInput := append([]byte(operation), 0, 0, 0)
	digest := sha256.Sum256(digestInput)
	store := &controllerTestStore{operations: map[string]storedOperation{
		"delete-pending": {
			digest: hex.EncodeToString(digest[:]), complete: true,
			response: OperationResponse{
				StatusCode: http.StatusAccepted, Replayable: true,
				Headers: map[string][]string{"X-Plue-Cleanup-Pending": {"true"}},
			},
		},
	}}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodDelete, "/v1/sandboxes/msb_pending", "delete-pending", "")
	assert.Equal(t, http.StatusAccepted, response.Code)
	assert.Equal(t, "true", response.Header().Get("X-Plue-Cleanup-Pending"))
}

func (s *controllerTestStore) CreateAccessGrant(context.Context, string, string, []byte, time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accessGrantCalls++
	return nil
}

func (s *controllerTestStore) RevokeSandboxAccessGrants(_ context.Context, target string) error {
	s.mu.Lock()
	s.revokedAccessTarget = target
	s.mu.Unlock()
	return nil
}

func TestControllerRevokeAccessGrantRoute(t *testing.T) {
	t.Parallel()
	store := &controllerTestStore{}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodDelete, "/v1/sandboxes/vm-target/access-grants", "revoke-access", "")
	require.Equal(t, http.StatusNoContent, response.Code, response.Body.String())
	store.mu.Lock()
	defer store.mu.Unlock()
	require.Equal(t, "vm-target", store.revokedAccessTarget)
}

func (s *controllerTestStore) CompleteRecovery(_ context.Context, id string, generation int64, observed string) error {
	s.completedRecovery.id = id
	s.completedRecovery.generation = generation
	s.completedRecovery.observed = observed
	return nil
}

type memorySnapshotStore struct{ payload []byte }

func (s *memorySnapshotStore) Put(context.Context, string, io.Reader) (string, string, int64, error) {
	return "", "", 0, errors.New("unexpected put")
}
func (s *memorySnapshotStore) Open(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(s.payload)), nil
}
func (s *memorySnapshotStore) Delete(context.Context, string) error { return nil }

type durableMemorySnapshotStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	deletes int
}

type snapshotStateTestStore struct {
	Store
	states []string
}

func (s *snapshotStateTestStore) SetSnapshotState(_ context.Context, _ string, state, _, _ string, _ *int64) error {
	s.states = append(s.states, state)
	return nil
}

func (s *durableMemorySnapshotStore) Put(_ context.Context, key string, reader io.Reader) (string, string, int64, error) {
	payload, err := io.ReadAll(reader)
	if err != nil {
		return "", "", 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.objects == nil {
		s.objects = map[string][]byte{}
	}
	uri := "memory://" + key
	s.objects[uri] = append([]byte(nil), payload...)
	sum := sha256.Sum256(payload)
	return uri, "sha256:" + hex.EncodeToString(sum[:]), int64(len(payload)), nil
}

func (s *durableMemorySnapshotStore) Open(_ context.Context, uri string) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return io.NopCloser(bytes.NewReader(append([]byte(nil), s.objects[uri]...))), nil
}

func (s *durableMemorySnapshotStore) Delete(_ context.Context, uri string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, uri)
	s.deletes++
	return nil
}

func TestExportSnapshotRejectsDigestMismatchBeforePublishingRecoveryPoint(t *testing.T) {
	const archive = "snapshot-payload"
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("X-Plue-Snapshot-Digest", "sha256:0000000000000000000000000000000000000000000000000000000000000000")
		writer.Header().Set("Content-Length", "16")
		_, _ = writer.Write([]byte(archive))
	}))
	defer worker.Close()
	store := &snapshotStateTestStore{}
	objects := &durableMemorySnapshotStore{}
	controller := New(store, Config{SnapshotStore: objects, AllowInsecureDev: true})
	err := controller.exportSnapshot(context.Background(), SnapshotPlacement{
		SnapshotID: "msbs_corrupt", LocalID: "msbs_corrupt", WorkerID: "worker-a",
		WorkerURL: worker.URL, Generation: 1,
	})
	assert.ErrorContains(t, err, "digest does not match")
	assert.Equal(t, []string{"exporting"}, store.states)
	objects.mu.Lock()
	defer objects.mu.Unlock()
	assert.Empty(t, objects.objects)
	assert.Equal(t, 1, objects.deletes)
}

func TestRecoveryCreateRequestBlocksServicesUntilSecretsAreReinjected(t *testing.T) {
	wait := true
	request := sandbox.CreateRequest{
		Files:        map[string]sandbox.SandboxFile{"/run/token": {Content: "secret"}},
		Firewall:     &sandbox.FirewallPolicy{DefaultEgressAction: "deny", EgressAllow: []sandbox.FirewallEgressRule{{Host: "api.example.com", Port: 443, Protocol: "tcp"}}},
		Ports:        []sandbox.PortBinding{{Port: 3000, TargetPort: 3000}},
		Users:        []sandbox.LinuxUserSpec{{Name: "agent"}},
		Init:         &sandbox.ServiceConfig{Services: []sandbox.ServiceSpec{{Name: "agent", Exec: []string{"agent"}, Env: map[string]string{"TOKEN": "secret"}}}},
		WaitForReady: &wait,
		Internet:     "none",
		Workdir:      "/workspace",
	}
	_, err := recoveryCreateRequest(msb.SanitizeCreateRequest(request), nil)
	require.ErrorIs(t, err, ErrRecoverySecretsRequired)
	assert.NotContains(t, err.Error(), "TOKEN")
}

func TestRecoveryCreateRequestRestartsNonSecretServicesAndRetainsPolicy(t *testing.T) {
	wait := true
	request := sandbox.CreateRequest{
		Files:        map[string]sandbox.SandboxFile{"/run/bootstrap": {Content: "payload"}},
		Firewall:     &sandbox.FirewallPolicy{DefaultEgressAction: "deny", EgressAllow: []sandbox.FirewallEgressRule{{Host: "api.example.com", Port: 443, Protocol: "tcp"}}},
		Ports:        []sandbox.PortBinding{{Port: 3000, TargetPort: 3000}},
		Users:        []sandbox.LinuxUserSpec{{Name: "agent"}},
		Init:         &sandbox.ServiceConfig{Services: []sandbox.ServiceSpec{{Name: "bootstrap", Exec: []string{"/opt/bootstrap"}}}},
		WaitForReady: &wait,
		Internet:     "none",
		Workdir:      "/workspace",
	}
	dynamic := sandbox.ServiceSpec{Name: "gateway", Exec: []string{"/opt/gateway"}}
	recovered, err := recoveryCreateRequest(msb.SanitizeCreateRequest(request), []sandbox.ServiceSpec{dynamic})
	require.NoError(t, err)
	require.NotNil(t, recovered.Firewall)
	assert.Equal(t, "deny", recovered.Firewall.DefaultEgressAction)
	assert.Equal(t, request.Ports, recovered.Ports)
	assert.Equal(t, request.Users, recovered.Users)
	assert.Equal(t, request.WaitForReady, recovered.WaitForReady)
	assert.Equal(t, "none", recovered.Internet)
	assert.Equal(t, "/workspace", recovered.Workdir)
	assert.Nil(t, recovered.Files)
	assert.Nil(t, recovered.Git)
	assert.Nil(t, recovered.GitRepos)
	require.NotNil(t, recovered.Init)
	assert.Equal(t, []sandbox.ServiceSpec{request.Init.Services[0], dynamic}, recovered.Init.Services)
}

func TestControllerColdStartReplaysDurableNonSecretServices(t *testing.T) {
	var paths []string
	var replayed sandbox.ServiceSpec
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		switch request.URL.Path {
		case "/internal/v1/sandboxes/msb_resume/start":
			writeJSON(writer, http.StatusOK, sandbox.StartResult{ID: "msb_resume"})
		case "/internal/v1/sandboxes/msb_resume/services":
			require.NoError(t, json.NewDecoder(request.Body).Decode(&replayed))
			writeJSON(writer, http.StatusOK, sandbox.CreateServiceResult{Success: true, ServiceName: replayed.Name})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer worker.Close()

	service := sandbox.ServiceSpec{Name: "preview", Exec: []string{"node", "/opt/preview.js"}}
	store := &controllerTestStore{workerURL: worker.URL, placement: &Placement{
		SandboxID: "msb_resume", LocalID: "msb_resume", WorkerID: "worker-a",
		Generation: 1, ObservedState: "stopped", RequestSpec: json.RawMessage(`{}`),
		RecoveryServices: []sandbox.ServiceSpec{service},
	}}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodPost,
		"/v1/sandboxes/msb_resume/start", "resume-with-services", `{}`)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, []string{
		"/internal/v1/sandboxes/msb_resume/start",
		"/internal/v1/sandboxes/msb_resume/services",
	}, paths)
	assert.Equal(t, service, replayed)
}

// A same-disk start must not be held hostage by a secret-bearing declaration:
// durable state only ever holds the redacted shape, so replaying it would boot
// the service with "[redacted]" credentials, and refusing the whole start (the
// recovery answer) wedged every gateway resume — the VM could never come back
// and the caller's discard + reprovision orphaned its parked runs. The start
// boots the guest, replays the non-secret services, and skips the secret one;
// the declaring plue service re-declares it with real secrets after the start.
func TestControllerColdStartSkipsSecretBearingServices(t *testing.T) {
	var paths []string
	var replayed []sandbox.ServiceSpec
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		switch request.URL.Path {
		case "/internal/v1/sandboxes/msb_secret_start/start":
			writeJSON(writer, http.StatusOK, sandbox.StartResult{ID: "msb_secret_start"})
		case "/internal/v1/sandboxes/msb_secret_start/services":
			var service sandbox.ServiceSpec
			require.NoError(t, json.NewDecoder(request.Body).Decode(&service))
			replayed = append(replayed, service)
			writeJSON(writer, http.StatusOK, sandbox.CreateServiceResult{Success: true, ServiceName: service.Name})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer worker.Close()

	plain := sandbox.ServiceSpec{Name: "preview", Exec: []string{"node", "/opt/preview.js"}}
	secreted := sandbox.ServiceSpec{Name: "gateway", Exec: []string{"/opt/gateway"},
		Env: map[string]string{"SMITHERS_API_KEY": "[redacted]", "CEREBRAS_API_KEY": "[redacted]"}}
	store := &controllerTestStore{workerURL: worker.URL, placement: &Placement{
		SandboxID: "msb_secret_start", LocalID: "msb_secret_start", WorkerID: "worker-a",
		Generation: 1, ObservedState: "stopped", RequestSpec: json.RawMessage(`{}`),
		RecoveryServices: []sandbox.ServiceSpec{plain, secreted},
	}}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodPost,
		"/v1/sandboxes/msb_secret_start/start", "resume-with-secret-service", `{}`)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, []sandbox.ServiceSpec{plain}, replayed,
		"only the non-secret service replays; the secret holder re-declares the gateway")
}

func TestControllerIdempotencyReplaysCreateWithoutSecondWorkerMutation(t *testing.T) {
	var workerCalls int
	var workerCreate msb.WorkerCreateRequest
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		workerCalls++
		require.Equal(t, "1", request.Header.Get(msb.PlacementGenerationHeader))
		require.NoError(t, json.NewDecoder(request.Body).Decode(&workerCreate))
		writeJSON(writer, http.StatusCreated, sandbox.CreateResult{ID: workerCreate.SandboxID})
	}))
	defer worker.Close()

	store := &controllerTestStore{workerURL: worker.URL}
	controller := New(store, Config{APIKey: "api-key", DefaultImage: "registry.example/runner@sha256:abc", DefaultRootfsSizeMB: 2048, AllowInsecureDev: true})

	first := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "create-one", `{}`)
	require.Equal(t, http.StatusCreated, first.Code)
	var firstResponse sandbox.CreateResult
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &firstResponse))
	assert.True(t, strings.HasPrefix(firstResponse.ID, "msb_"))

	second := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "create-one", `{}`)
	require.Equal(t, http.StatusCreated, second.Code)
	var secondResponse sandbox.CreateResult
	require.NoError(t, json.Unmarshal(second.Body.Bytes(), &secondResponse))
	assert.Equal(t, firstResponse.ID, secondResponse.ID)
	assert.Equal(t, 1, workerCalls)
	assert.Equal(t, 1, store.allocateCalls)
	assert.Equal(t, "registry.example/runner@sha256:abc", workerCreate.Request.Image)
	assert.Equal(t, workerCreate.Request.Image, store.allocatedRequest.Image)
	require.NotNil(t, workerCreate.Request.RootfsSizeMB)
	assert.EqualValues(t, 2048, *workerCreate.Request.RootfsSizeMB)
	assert.Equal(t, workerCreate.Request.RootfsSizeMB, store.allocatedRequest.RootfsSizeMB)

	conflict := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "create-one", `{"image":"different"}`)
	assert.Equal(t, http.StatusConflict, conflict.Code)
	assert.Equal(t, 1, workerCalls)

	missing := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "", `{}`)
	assert.Equal(t, http.StatusBadRequest, missing.Code)
}

func TestControllerDefaultsWritableDiskBySandboxKind(t *testing.T) {
	var workerCreate msb.WorkerCreateRequest
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		require.NoError(t, json.NewDecoder(request.Body).Decode(&workerCreate))
		writeJSON(writer, http.StatusCreated, sandbox.CreateResult{ID: workerCreate.SandboxID})
	}))
	defer worker.Close()

	store := &controllerTestStore{workerURL: worker.URL}
	controller := New(store, Config{APIKey: "api-key", DefaultImage: "registry.example/desktop@sha256:abc", AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes", "desktop-default-disk", `{"kind":"desktop"}`)

	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	require.NotNil(t, workerCreate.Request.RootfsSizeMB)
	assert.EqualValues(t, 8*1024, *workerCreate.Request.RootfsSizeMB)
	require.NotNil(t, store.allocatedRequest.RootfsSizeMB)
	assert.EqualValues(t, 8*1024, *store.allocatedRequest.RootfsSizeMB)
}

func TestControllerDoesNotPersistOrReplayTokenResponse(t *testing.T) {
	store := &controllerTestStore{}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})
	first := controllerRequest(t, controller, http.MethodPost, "/v1/access/identities/msbi_test/tokens", "token-one", "")
	require.Equal(t, http.StatusCreated, first.Code)
	assert.NotEmpty(t, first.Body.String())
	require.Len(t, store.storedOperationBodies, 1)
	assert.Empty(t, store.storedOperationBodies[0])
	assert.Equal(t, 1, store.accessGrantCalls)

	second := controllerRequest(t, controller, http.MethodPost, "/v1/access/identities/msbi_test/tokens", "token-one", "")
	assert.Equal(t, http.StatusConflict, second.Code)
	assert.NotContains(t, second.Body.String(), `"token"`)
	assert.Equal(t, 1, store.accessGrantCalls)
}

func TestControllerDoesNotPersistOrReplayGuestExecOutput(t *testing.T) {
	const sentinel = "exec-output-secret-sentinel"
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, sandbox.ExecResult{Stdout: sentinel})
	}))
	defer worker.Close()
	store := &controllerTestStore{workerURL: worker.URL}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})
	first := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_exec/exec", "exec-one", `{"command":"print-result"}`)
	require.Equal(t, http.StatusOK, first.Code)
	assert.Contains(t, first.Body.String(), sentinel, "the initial caller still receives its command output")
	require.Len(t, store.storedOperationBodies, 1)
	assert.NotContains(t, string(store.storedOperationBodies[0]), sentinel)

	second := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_exec/exec", "exec-one", `{"command":"print-result"}`)
	assert.Equal(t, http.StatusConflict, second.Code)
	assert.NotContains(t, second.Body.String(), sentinel)
}

func TestRecoverClaimImportsVerifiedSnapshotBeforeCreateAndRestoresDesiredStop(t *testing.T) {
	var sequence []string
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		require.Equal(t, "7", request.Header.Get(msb.PlacementGenerationHeader))
		switch {
		case request.Method == http.MethodPut && strings.HasSuffix(request.URL.Path, "/import"):
			sequence = append(sequence, "import")
			payload, err := io.ReadAll(request.Body)
			require.NoError(t, err)
			assert.Equal(t, []byte("snapshot-archive"), payload)
			writeJSON(writer, http.StatusOK, msb.SnapshotTransferMetadata{SnapshotID: "msbs_recovery", Digest: "digest-1"})
		case request.Method == http.MethodPost && request.URL.Path == "/internal/v1/sandboxes":
			sequence = append(sequence, "create")
			var create msb.WorkerCreateRequest
			require.NoError(t, json.NewDecoder(request.Body).Decode(&create))
			assert.Equal(t, "msbs_recovery", create.Request.SnapshotID)
			assert.Empty(t, create.Request.Files)
			writeJSON(writer, http.StatusCreated, sandbox.CreateResult{ID: create.SandboxID})
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/stop"):
			sequence = append(sequence, "stop")
			writeJSON(writer, http.StatusOK, sandbox.StopResult{SandboxID: "msb_workspace"})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer worker.Close()

	store := &controllerTestStore{}
	controller := New(store, Config{SnapshotStore: &memorySnapshotStore{payload: []byte("snapshot-archive")}, AllowInsecureDev: true})
	claim := RecoveryClaim{DesiredState: "stopped", Placement: Placement{
		SandboxID: "msb_workspace", LocalID: "msb_workspace", WorkerID: "worker-b",
		WorkerURL: worker.URL, Generation: 7, Persistent: true,
		Requested:       msb.WorkerCapacity{CPUMillis: 2000, MemoryBytes: 1024 * 1024 * 1024, DiskBytes: 20 * 1024 * 1024 * 1024, VMs: 1},
		SnapshotLocalID: "msbs_recovery", SnapshotObjectURI: "gs://bucket/recovery.tar", SnapshotDigest: "digest-1",
		RecoverySnapshotID: "msbs_recovery", RecoverySnapshotLocalID: "msbs_recovery",
		RecoverySnapshotObjectURI: "gs://bucket/recovery.tar", RecoverySnapshotDigest: "digest-1",
	}}
	require.NoError(t, controller.recoverClaim(context.Background(), claim))
	assert.Equal(t, []string{"import", "create", "stop"}, sequence)
	assert.Equal(t, "msb_workspace", store.completedRecovery.id)
	assert.Equal(t, int64(7), store.completedRecovery.generation)
	assert.Equal(t, "stopped", store.completedRecovery.observed)
}

func TestCleanupPreviousPlacementRemovesOldLocalRuntimeAfterSameWorkerRecovery(t *testing.T) {
	deleted := make(chan string, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		require.Equal(t, http.MethodDelete, request.Method)
		require.Equal(t, "4", request.Header.Get(msb.PlacementGenerationHeader))
		deleted <- request.URL.Path
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer worker.Close()

	controller := New(&controllerTestStore{}, Config{AllowInsecureDev: true})
	controller.cleanupPreviousPlacement(context.Background(), RecoveryClaim{
		Placement: Placement{
			SandboxID: "msb_logical", LocalID: "msb_recovered", WorkerID: "worker-a",
			WorkerURL: worker.URL, Generation: 5,
		},
		PreviousPlacement: &Placement{
			SandboxID: "msb_logical", LocalID: "msb_source", WorkerID: "worker-a",
			WorkerURL: worker.URL, Generation: 4,
		},
	})

	select {
	case path := <-deleted:
		assert.Equal(t, "/internal/v1/sandboxes/msb_source", path)
	case <-time.After(time.Second):
		t.Fatal("old provider-local runtime was not deleted")
	}
}

// forkLiveWorkerStore models the fake worker remaining healthy throughout a
// snapshot export. Renew its real PG lease at the allocation boundary instead
// of depending on the whole test finishing within one 30-second heartbeat.
// Synchronous renewal also avoids racing Allocate's SKIP LOCKED capacity query
// against a test-owned background heartbeat transaction.
type forkLiveWorkerStore struct {
	*PGStore
	heartbeat msb.WorkerHeartbeat
}

func (s *forkLiveWorkerStore) Allocate(ctx context.Context, id string, request sandbox.CreateRequest, sanitized json.RawMessage, owner ResourceOwner) (Placement, error) {
	heartbeat := s.heartbeat
	heartbeat.IdentitySignedAt = time.Now().UTC()
	if _, err := s.Heartbeat(ctx, heartbeat); err != nil {
		return Placement{}, err
	}
	return s.PGStore.Allocate(ctx, id, request, sanitized, owner)
}

func TestPersistentForkRetainsAndOwnsInitialRecoveryCheckpoint(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	const archive = "fork-snapshot-archive"
	archiveHash := sha256.Sum256([]byte(archive))
	archiveDigest := "sha256:" + hex.EncodeToString(archiveHash[:])
	var sequence []string
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/snapshot"):
			sequence = append(sequence, "snapshot")
			var snapshot msb.WorkerSnapshotRequest
			require.NoError(t, json.NewDecoder(request.Body).Decode(&snapshot))
			writeJSON(writer, http.StatusCreated, sandbox.SnapshotResult{SnapshotID: snapshot.SnapshotID, SourceSandboxID: "msb_parent"})
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/export"):
			sequence = append(sequence, "export")
			writer.Header().Set("X-Plue-Snapshot-Digest", archiveDigest)
			writer.Header().Set("Content-Length", "21")
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(archive))
		case request.Method == http.MethodPut && strings.HasSuffix(request.URL.Path, "/import"):
			payload, err := io.ReadAll(request.Body)
			require.NoError(t, err)
			assert.Equal(t, []byte(archive), payload)
			writeJSON(writer, http.StatusOK, msb.SnapshotTransferMetadata{Digest: archiveDigest, SizeBytes: int64(len(payload))})
		case request.Method == http.MethodPost && request.URL.Path == "/internal/v1/sandboxes":
			sequence = append(sequence, "create")
			var create msb.WorkerCreateRequest
			require.NoError(t, json.NewDecoder(request.Body).Decode(&create))
			// The fork child is sized by the ForkRequest, never by the 512 MiB /
			// 1 vCPU provider defaults the worker would otherwise boot.
			require.NotNil(t, create.Request.MemSizeMB)
			assert.Equal(t, int32(4096), *create.Request.MemSizeMB)
			require.NotNil(t, create.Request.VCPUCount)
			assert.Equal(t, int32(2), *create.Request.VCPUCount)
			assert.Equal(t, "container", create.Request.Kind)
			writeJSON(writer, http.StatusCreated, sandbox.CreateResult{ID: create.SandboxID})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer worker.Close()
	store := &forkLiveWorkerStore{
		PGStore:   NewPGStore(pool),
		heartbeat: heartbeatForTest("worker-fork", worker.URL),
	}
	parentRequest := sandbox.CreateRequest{Image: "image@sha256:parent"}
	_, err := store.Allocate(ctx, "msb_parent", parentRequest, msb.SanitizeCreateRequest(parentRequest), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_parent", 1, "running", "running", ""))

	objects := &durableMemorySnapshotStore{}
	controller := New(store, Config{APIKey: "api-key", SnapshotStore: objects, AllowInsecureDev: true})
	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_parent/fork", "fork-persistent", `{"persistence":{"type":"persistent"},"memSizeMB":4096,"vcpuCount":2,"kind":"container"}`)
	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	var forked sandbox.CreateResult
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &forked))
	childID := forked.ID
	require.NotEmpty(t, childID)

	var recoveryID, ownerID, snapshotState string
	var deletedAt *time.Time
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT i.recovery_snapshot_id,s.source_sandbox_id,s.state,s.deleted_at
		FROM sandbox_instances i JOIN sandbox_snapshots s ON s.id=i.recovery_snapshot_id
		WHERE i.id=$1`, childID).Scan(&recoveryID, &ownerID, &snapshotState, &deletedAt))
	assert.NotEmpty(t, recoveryID)
	assert.Equal(t, childID, ownerID)
	assert.Equal(t, "exported", snapshotState)
	assert.Nil(t, deletedAt)
	assert.Zero(t, objects.deletes)
	assert.Equal(t, []string{"snapshot", "export", "create"}, sequence)
}

func controllerRequest(t *testing.T, handler http.Handler, method, path, idempotencyKey, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer api-key")
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// A workspace VM that Microsandbox has already stopped must answer suspend/stop
// with success WITHOUT re-dispatching the worker RPC or re-running the durable
// recovery checkpoint. Regression: the controller re-checkpointed every
// already-stopped persistent VM, and when that export failed it answered
// 500 internal_error. plue's idle sweeper only releases a workspace's
// concurrent-VM quota slot when suspend succeeds, so four prod workspaces sat
// 'running' for up to four days — re-snapshotting on every 5-minute sweep —
// while the guest was provably off.
func TestSuspendAndStopAreIdempotentForAnAlreadyStoppedSandbox(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		key      string
		observed string
		path     string
	}{
		{name: "suspend a stopped guest", key: "idle-suspend-stopped", observed: "stopped", path: "/v1/sandboxes/msb_idle/suspend"},
		{name: "suspend after a failed checkpoint", key: "idle-suspend-degraded", observed: "degraded", path: "/v1/sandboxes/msb_idle/suspend"},
		{name: "stop a stopped guest", key: "idle-stop-stopped", observed: "stopped", path: "/v1/sandboxes/msb_idle/stop"},
		{name: "stop after a failed checkpoint", key: "idle-stop-degraded", observed: "degraded", path: "/v1/sandboxes/msb_idle/stop"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var workerCalls int
			// Stands in for the two prod failure modes behind the 500: an
			// unreachable worker, and a checkpoint export that cannot succeed.
			worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				workerCalls++
				http.Error(writer, "worker must not be called", http.StatusInternalServerError)
			}))
			defer worker.Close()
			store := &controllerTestStore{workerURL: worker.URL, placement: &Placement{
				WorkerID: "worker-a", Generation: 7,
				DesiredState: "stopped", ObservedState: testCase.observed,
				Persistent: true,
			}}
			// No SnapshotStore: checkpointStoppedVM would fail closed with
			// "durable snapshot object store is unavailable" if it ran at all.
			controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

			response := controllerRequest(t, controller, http.MethodPost, testCase.path, testCase.key, "")

			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			assert.Zero(t, workerCalls, "an already-stopped guest must not be re-stopped or re-checkpointed")
			assert.Contains(t, response.Body.String(), "msb_idle:7", "the runtime id must still identify the placement generation")
		})
	}
}

// The tolerance above must not swallow a guest the recovery machinery still
// owns: desired 'running' means a crashed VM is queued for restart, so
// reporting it suspended would race the reconciler bringing it back up.
func TestSuspendStillDispatchesWhenRestartIsStillDesired(t *testing.T) {
	var workerCalls int
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		workerCalls++
		http.Error(writer, "boom", http.StatusInternalServerError)
	}))
	defer worker.Close()
	store := &controllerTestStore{workerURL: worker.URL, placement: &Placement{
		WorkerID: "worker-a", Generation: 3,
		DesiredState: "running", ObservedState: "stopped",
	}}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_crashed/suspend", "crashed-suspend", "")

	assert.Equal(t, 1, workerCalls, "a guest still desired running must be stopped for real")
	assert.NotEqual(t, http.StatusOK, response.Code)
}
