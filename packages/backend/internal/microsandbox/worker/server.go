package worker

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type ServerConfig struct {
	WorkerID     string
	SSHBridgeBin string
	State        *State
	Runtime      Runtime
	Logger       *slog.Logger
	// ControllerIdentity is the mTLS client CommonName allowed to call the
	// internal routes. Empty refuses them unless AllowInsecureDev is set.
	ControllerIdentity string
	// AllowInsecureDev serves the internal routes to any caller when no
	// ControllerIdentity is configured. Local development and tests only.
	AllowInsecureDev bool
	TransferDir      string
	StateChanged     func()
}

var ErrSnapshotArchiveTooLarge = errors.New("snapshot archive exceeds worker transfer limit")

var ErrExecutionDrainTimeout = errors.New("active sandbox execution did not stop before the mutation deadline")

const maxSnapshotImportBytes int64 = 320 << 30

const executionDrainTimeout = 10 * time.Second

type activeExecution struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type Server struct {
	workerID           string
	sshBridgeBin       string
	state              *State
	runtime            Runtime
	logger             *slog.Logger
	controllerIdentity string
	allowInsecureDev   bool
	transferDir        string
	router             http.Handler
	authorizedUntil    atomic.Int64
	admitNew           atomic.Bool
	cleanupRunning     atomic.Bool
	snapshotMutations  keyedMutex
	executionsMu       sync.Mutex
	executions         map[string]map[*activeExecution]struct{}
	stateChanged       func()
}

func NewServer(config ServerConfig) *Server {
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	server := &Server{
		workerID: config.WorkerID, sshBridgeBin: strings.TrimSpace(config.SSHBridgeBin), state: config.State,
		runtime: config.Runtime, logger: logger,
		controllerIdentity: strings.TrimSpace(config.ControllerIdentity),
		allowInsecureDev:   config.AllowInsecureDev,
		transferDir:        strings.TrimSpace(config.TransferDir),
		stateChanged:       config.StateChanged,
	}
	if server.transferDir == "" {
		server.transferDir = filepath.Join(os.TempDir(), "plue-microsandbox-transfers")
	}
	if server.sshBridgeBin == "" {
		server.sshBridgeBin = "/microsandbox-worker"
	}
	server.router = server.routes()
	return server
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	s.router.ServeHTTP(writer, request)
}

func (s *Server) routes() http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	})
	router.Group(func(internal chi.Router) {
		internal.Use(s.requireControllerIdentity)
		internal.Use(s.requireAuthorization)
		internal.With(s.requireAdmission).Post("/internal/v1/sandboxes", s.handleCreate)
		internal.Get("/internal/v1/sandboxes/{sandboxID}", s.withGeneration(s.handleGet))
		internal.Delete("/internal/v1/sandboxes/{sandboxID}", s.withGeneration(s.handleDelete))
		internal.Post("/internal/v1/sandboxes/{sandboxID}/start", s.withGeneration(s.handleStart))
		internal.Post("/internal/v1/sandboxes/{sandboxID}/stop", s.withGeneration(s.handleStop))
		internal.Post("/internal/v1/sandboxes/{sandboxID}/suspend", s.withGeneration(s.handleSuspend))
		internal.Post("/internal/v1/sandboxes/{sandboxID}/egress/revoke", s.withGeneration(s.handleRevokeEgress))
		internal.Post("/internal/v1/sandboxes/{sandboxID}/exec", s.withGeneration(s.handleExec))
		internal.Put("/internal/v1/sandboxes/{sandboxID}/files/*", s.withGeneration(s.handleWriteFile))
		internal.Post("/internal/v1/sandboxes/{sandboxID}/services", s.withGeneration(s.handleService))
		internal.Post("/internal/v1/sandboxes/{sandboxID}/snapshot", s.withGeneration(s.handleSnapshot))
		internal.Get("/internal/v1/sandboxes/{sandboxID}/ssh", s.withGeneration(s.handleSSH))
		internal.Get("/internal/v1/snapshots/{snapshotID}/export", s.handleExportSnapshot)
		internal.Put("/internal/v1/snapshots/{snapshotID}/import", s.handleImportSnapshot)
		internal.Delete("/internal/v1/snapshots/{snapshotID}", s.handleDeleteSnapshot)
	})
	return router
}

func (s *Server) requireControllerIdentity(next http.Handler) http.Handler {
	if s.controllerIdentity == "" {
		if s.allowInsecureDev {
			return next
		}
		return http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writeError(writer, http.StatusServiceUnavailable, "authentication_not_configured", "mTLS controller identity is not configured")
		})
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.TLS == nil || len(request.TLS.PeerCertificates) == 0 ||
			subtle.ConstantTimeCompare([]byte(request.TLS.PeerCertificates[0].Subject.CommonName), []byte(s.controllerIdentity)) != 1 {
			writeError(writer, http.StatusForbidden, "peer_identity_denied", "mTLS peer identity is not authorized for worker operations")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) withGeneration(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get(msb.WorkerIDHeader) != "" && request.Header.Get(msb.WorkerIDHeader) != s.workerID {
			writeError(writer, http.StatusConflict, "worker_fenced", "request targets a different worker")
			return
		}
		generation, err := strconv.ParseInt(request.Header.Get(msb.PlacementGenerationHeader), 10, 64)
		if err != nil || generation <= 0 {
			writeError(writer, http.StatusBadRequest, "generation_required", "placement generation is required")
			return
		}
		if err := s.state.Check(chi.URLParam(request, "sandboxID"), generation); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeError(writer, http.StatusNotFound, "not_found", "sandbox was not found on worker")
				return
			}
			writeError(writer, http.StatusConflict, "stale_generation", err.Error())
			return
		}
		next(writer, request)
	}
}

// lockRequestPlacement closes the check/use race left by the lightweight
// routing middleware. A stale request may pass withGeneration immediately
// before a newer create replaces the local guest; every mutation must recheck
// its generation while holding the same lock used by create and refresh.
func (s *Server) lockRequestPlacement(writer http.ResponseWriter, request *http.Request) (func(), bool) {
	id := chi.URLParam(request, "sandboxID")
	unlock := s.lock(id)
	generation, _ := strconv.ParseInt(request.Header.Get(msb.PlacementGenerationHeader), 10, 64)
	if err := s.state.Check(id, generation); err != nil {
		unlock()
		if errors.Is(err, os.ErrNotExist) {
			writeError(writer, http.StatusNotFound, "not_found", "sandbox was not found on worker")
		} else {
			writeError(writer, http.StatusConflict, "stale_generation", err.Error())
		}
		return nil, false
	}
	return unlock, true
}

func (s *Server) requireAuthorization(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if time.Now().UnixNano() > s.authorizedUntil.Load() {
			writeError(writer, http.StatusServiceUnavailable, "worker_fenced", "worker lost controller authorization")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) requireAdmission(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !s.admitNew.Load() {
			writeError(writer, http.StatusServiceUnavailable, "worker_draining", "worker is not admitting new sandboxes")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

// AuthorizeUntil extends the worker's mutation lease after a controller
// heartbeat succeeds. If heartbeats fail beyond this deadline, the worker
// fences itself and serves no further mutations or streams.
func (s *Server) AuthorizeUntil(deadline time.Time, admitNew bool) {
	s.authorizedUntil.Store(deadline.UnixNano())
	s.admitNew.Store(admitNew)
}

func (s *Server) Fence() {
	s.authorizedUntil.Store(0)
	s.admitNew.Store(false)
}

func (s *Server) BeginDrain() {
	s.admitNew.Store(false)
}

func (s *Server) notifyStateChanged() {
	if s.stateChanged != nil {
		s.stateChanged()
	}
}

// registerExecution is called while the sandbox placement lock is held. A
// replacement therefore cannot pass its generation check until the operation
// is visible in this registry. Lifecycle mutations cancel and drain every
// registered operation before they stop, delete, or replace the guest.
func (s *Server) registerExecution(id string, cancel context.CancelFunc) *activeExecution {
	execution := &activeExecution{cancel: cancel, done: make(chan struct{})}
	s.executionsMu.Lock()
	defer s.executionsMu.Unlock()
	if s.executions == nil {
		s.executions = make(map[string]map[*activeExecution]struct{})
	}
	if s.executions[id] == nil {
		s.executions[id] = make(map[*activeExecution]struct{})
	}
	s.executions[id][execution] = struct{}{}
	return execution
}

// finishExecution closes done before removing the registry entry so a
// lifecycle request holding the placement lock can proceed without deadlocking
// on the exec handler's final generation check.
func (s *Server) finishExecution(id string, execution *activeExecution) {
	close(execution.done)
	s.executionsMu.Lock()
	defer s.executionsMu.Unlock()
	delete(s.executions[id], execution)
	if len(s.executions[id]) == 0 {
		delete(s.executions, id)
	}
}

func (s *Server) drainExecutions(ctx context.Context, id string) error {
	s.executionsMu.Lock()
	executions := make([]*activeExecution, 0, len(s.executions[id]))
	for execution := range s.executions[id] {
		executions = append(executions, execution)
	}
	s.executionsMu.Unlock()
	if len(executions) == 0 {
		return nil
	}
	for _, execution := range executions {
		execution.cancel()
	}
	drainCtx, cancel := context.WithTimeout(ctx, executionDrainTimeout)
	defer cancel()
	for _, execution := range executions {
		select {
		case <-execution.done:
		case <-drainCtx.Done():
			return fmt.Errorf("%w: %s", ErrExecutionDrainTimeout, drainCtx.Err())
		}
	}
	return nil
}

func (s *Server) requireExecutionsDrained(writer http.ResponseWriter, request *http.Request, id string) bool {
	if err := s.drainExecutions(request.Context(), id); err != nil {
		writeError(writer, http.StatusConflict, "exec_in_progress", err.Error())
		return false
	}
	return true
}

func (s *Server) LeaseState(now time.Time) (authorized, admitNew bool) {
	authorized = now.UnixNano() <= s.authorizedUntil.Load()
	return authorized, authorized && s.admitNew.Load()
}

// ScheduleOrphanDeletion applies controller-authorized inventory cleanup
// without holding the heartbeat loop. Per-sandbox mutation locks serialize it
// with ordinary requests, and the persisted generation prevents deletion of
// a newer local placement.
func (s *Server) ScheduleOrphanDeletion(ctx context.Context, items []msb.WorkerInventoryItem) {
	if len(items) == 0 || !s.cleanupRunning.CompareAndSwap(false, true) {
		return
	}
	items = append([]msb.WorkerInventoryItem(nil), items...)
	go func() {
		defer s.cleanupRunning.Store(false)
		for _, item := range items {
			select {
			case <-ctx.Done():
				return
			default:
			}
			unlock := s.lock(item.SandboxID)
			err := s.state.Check(item.SandboxID, item.Generation)
			if errors.Is(err, os.ErrNotExist) {
				unlock()
				continue
			}
			if err != nil {
				s.logger.Warn("skipping stale orphan cleanup", "sandbox_id", item.SandboxID, "generation", item.Generation)
				unlock()
				continue
			}
			if err := s.drainExecutions(ctx, item.SandboxID); err != nil {
				s.logger.Warn("Microsandbox orphan cleanup could not drain active exec", "sandbox_id", item.SandboxID, "generation", item.Generation, "error", err)
				unlock()
				continue
			}
			deleteCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			err = s.runtime.Delete(deleteCtx, item.SandboxID)
			cancel()
			if err != nil && !runtimeNotFound(err) {
				s.logger.Warn("Microsandbox orphan cleanup failed", "sandbox_id", item.SandboxID, "generation", item.Generation)
				unlock()
				continue
			}
			if err := s.state.Remove(item.SandboxID, item.Generation); err != nil {
				s.logger.Warn("Microsandbox orphan state cleanup failed", "sandbox_id", item.SandboxID, "generation", item.Generation)
			}
			unlock()
		}
	}()
}

func (s *Server) handleCreate(writer http.ResponseWriter, request *http.Request) {
	var create msb.WorkerCreateRequest
	if !decodeJSON(writer, request, &create) {
		return
	}
	if create.Generation <= 0 || strings.TrimSpace(create.SandboxID) == "" {
		writeError(writer, http.StatusBadRequest, "invalid_placement", "sandbox id and generation are required")
		return
	}
	if target := request.Header.Get(msb.WorkerIDHeader); target != "" && target != s.workerID {
		writeError(writer, http.StatusConflict, "worker_fenced", "request targets a different worker")
		return
	}
	unlock := s.lock(create.SandboxID)
	defer unlock()
	if allocation, exists := s.state.CurrentAllocation(create.SandboxID); exists {
		if allocation.Generation > create.Generation {
			writeError(writer, http.StatusConflict, "stale_generation",
				fmt.Sprintf("stale placement generation: have %d, got %d", allocation.Generation, create.Generation))
			return
		}
		if create.ReuseStoppedDisk {
			if s.promoteStoppedRuntime(writer, request, create, allocation) {
				return
			}
			return
		}
		if allocation.Generation < create.Generation {
			// A relocated sandbox may later return to this host with a newer
			// generation. The controller generation is authoritative; remove a
			// quarantined older guest before creating the new placement.
			if !s.requireExecutionsDrained(writer, request, create.SandboxID) {
				return
			}
			if deleteErr := s.runtime.Delete(request.Context(), create.SandboxID); deleteErr != nil && !runtimeNotFound(deleteErr) {
				writeRuntimeError(writer, deleteErr)
				return
			}
			if removeErr := s.state.Remove(create.SandboxID, allocation.Generation); removeErr != nil {
				writeRuntimeError(writer, removeErr)
				return
			}
		} else if !allocation.BootstrapComplete {
			// A process crash may leave a detached runtime after Register but
			// before bootstrap completed. It is not a successful idempotent create:
			// destroy it and build the requested generation from a clean disk.
			if !s.requireExecutionsDrained(writer, request, create.SandboxID) {
				return
			}
			if deleteErr := s.runtime.Delete(request.Context(), create.SandboxID); deleteErr != nil && !runtimeNotFound(deleteErr) {
				writeRuntimeError(writer, deleteErr)
				return
			}
			if removeErr := s.state.Remove(create.SandboxID, create.Generation); removeErr != nil {
				writeRuntimeError(writer, removeErr)
				return
			}
		} else {
			// A controller retry after a lost response must return the existing
			// runtime instead of WithReplace destroying and recreating its disk.
			response, getErr := s.runtime.Get(request.Context(), create.SandboxID)
			if getErr == nil {
				writeJSON(writer, http.StatusOK, sandbox.CreateResult{ID: response.ID})
				return
			}
			if !runtimeNotFound(getErr) {
				writeRuntimeError(writer, getErr)
				return
			}
			_ = s.state.Remove(create.SandboxID, create.Generation)
		}
	}
	if create.ReuseStoppedDisk {
		writeError(writer, http.StatusConflict, "retained_runtime_not_found", "retained runtime allocation is not available on this worker")
		return
	}
	capacity := requestCapacity(create.Request)
	if err := s.state.Register(create.SandboxID, Allocation{Generation: create.Generation, Capacity: capacity}); err != nil {
		writeError(writer, http.StatusConflict, "stale_generation", err.Error())
		return
	}
	response, err := s.runtime.Create(request.Context(), create.SandboxID, create.Generation, create.Request)
	if err != nil {
		s.logger.Error("Microsandbox runtime create failed", "sandbox_id", create.SandboxID, "generation", create.Generation, "error", err)
		_ = s.state.Remove(create.SandboxID, create.Generation)
		writeRuntimeError(writer, err)
		return
	}
	if err := s.state.SetObserved(create.SandboxID, create.Generation, "running"); err != nil {
		_ = s.runtime.Delete(context.WithoutCancel(request.Context()), create.SandboxID)
		_ = s.state.Remove(create.SandboxID, create.Generation)
		writeRuntimeError(writer, fmt.Errorf("persist created runtime state: %w", err))
		return
	}
	s.notifyStateChanged()
	writeJSON(writer, http.StatusCreated, response)
}

// promoteStoppedRuntime handles a planned drain when the replacement worker
// process comes back on the same durable host. The controller has already
// created and exported a verified recovery checkpoint. Reusing the retained,
// stopped local disk is both safer and faster than forking that checkpoint on
// top of the source disk on the same Microsandbox 0.6.15 host. The new
// generation still fences every command issued to the previous worker boot.
func (s *Server) promoteStoppedRuntime(writer http.ResponseWriter, request *http.Request, create msb.WorkerCreateRequest, allocation Allocation) bool {
	if allocation.Generation == create.Generation && allocation.BootstrapComplete {
		response, err := s.runtime.Get(request.Context(), create.SandboxID)
		if err != nil {
			writeRuntimeError(writer, err)
			return true
		}
		if response.State != sandbox.StateRunning {
			writeError(writer, http.StatusConflict, "retained_runtime_not_running", "retained runtime did not finish recovery")
			return true
		}
		writeJSON(writer, http.StatusOK, sandbox.CreateResult{ID: response.ID})
		return true
	}

	retained, err := s.runtime.Get(request.Context(), create.SandboxID)
	if err != nil {
		writeRuntimeError(writer, err)
		return true
	}
	if retained.State != sandbox.StateStopped {
		writeError(writer, http.StatusConflict, "retained_runtime_not_stopped", "retained runtime is not safe to promote")
		return true
	}
	original := allocation
	if err := s.state.Register(create.SandboxID, Allocation{
		Generation: create.Generation,
		Capacity:   requestCapacity(create.Request),
	}); err != nil {
		writeError(writer, http.StatusConflict, "stale_generation", err.Error())
		return true
	}
	if _, err := s.runtime.Start(request.Context(), create.SandboxID); err != nil {
		_ = s.state.Remove(create.SandboxID, create.Generation)
		_ = s.state.Register(create.SandboxID, original)
		s.logger.Error("Microsandbox retained runtime promotion failed",
			"sandbox_id", create.SandboxID, "generation", create.Generation, "error", err)
		writeRuntimeError(writer, err)
		return true
	}
	if err := s.state.SetObserved(create.SandboxID, create.Generation, "running"); err != nil {
		_ = s.state.Remove(create.SandboxID, create.Generation)
		_ = s.state.Register(create.SandboxID, original)
		writeRuntimeError(writer, fmt.Errorf("persist promoted runtime state: %w", err))
		return true
	}
	s.notifyStateChanged()
	writeJSON(writer, http.StatusCreated, sandbox.CreateResult{ID: create.SandboxID})
	return true
}

func (s *Server) handleGet(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "sandboxID")
	response, err := s.runtime.Get(request.Context(), id)
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (s *Server) handleDelete(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "sandboxID")
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	defer unlock()
	if !s.requireExecutionsDrained(writer, request, id) {
		return
	}
	if err := s.runtime.Delete(request.Context(), id); err != nil && !runtimeNotFound(err) {
		writeRuntimeError(writer, err)
		return
	}
	generation, _ := strconv.ParseInt(request.Header.Get(msb.PlacementGenerationHeader), 10, 64)
	if err := s.state.Remove(id, generation); err != nil {
		writeError(writer, http.StatusConflict, "stale_generation", err.Error())
		return
	}
	s.notifyStateChanged()
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStart(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "sandboxID")
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	defer unlock()
	var start sandbox.StartRequest
	if request.ContentLength != 0 && !decodeJSON(writer, request, &start) {
		return
	}
	var response sandbox.StartResult
	var err error
	if start.EgressProxy != nil {
		starter, ok := s.runtime.(interface {
			StartWithEgress(context.Context, string, *sandbox.EgressProxyPolicy) (sandbox.StartResult, error)
		})
		if !ok {
			writeRuntimeError(writer, ErrEgressProxyUnavailable)
			return
		}
		response, err = starter.StartWithEgress(request.Context(), id, start.EgressProxy)
	} else {
		response, err = s.runtime.Start(request.Context(), id)
	}
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	generation, _ := strconv.ParseInt(request.Header.Get(msb.PlacementGenerationHeader), 10, 64)
	if err := s.state.SetObserved(id, generation, "running"); err != nil {
		writeRuntimeError(writer, err)
		return
	}
	s.notifyStateChanged()
	writeJSON(writer, http.StatusOK, response)
}

func (s *Server) handleStop(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "sandboxID")
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	defer unlock()
	if !s.requireExecutionsDrained(writer, request, id) {
		return
	}
	response, err := s.runtime.Stop(request.Context(), id)
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	generation, _ := strconv.ParseInt(request.Header.Get(msb.PlacementGenerationHeader), 10, 64)
	if err := s.state.SetObserved(id, generation, "stopped"); err != nil {
		writeRuntimeError(writer, err)
		return
	}
	s.notifyStateChanged()
	writeJSON(writer, http.StatusOK, response)
}

func (s *Server) handleSuspend(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "sandboxID")
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	defer unlock()
	if !s.requireExecutionsDrained(writer, request, id) {
		return
	}
	response, err := s.runtime.Suspend(request.Context(), id)
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	generation, _ := strconv.ParseInt(request.Header.Get(msb.PlacementGenerationHeader), 10, 64)
	if err := s.state.SetObserved(id, generation, "stopped"); err != nil {
		writeRuntimeError(writer, err)
		return
	}
	s.notifyStateChanged()
	writeJSON(writer, http.StatusOK, response)
}

func (s *Server) handleExec(writer http.ResponseWriter, request *http.Request) {
	var execRequest sandbox.ExecRequest
	if !decodeJSON(writer, request, &execRequest) {
		return
	}
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	id := chi.URLParam(request, "sandboxID")
	generation, _ := strconv.ParseInt(request.Header.Get(msb.PlacementGenerationHeader), 10, 64)
	execContext, cancel := context.WithCancel(request.Context())
	execution := s.registerExecution(id, cancel)
	// Exec can legitimately run for minutes. Keep it outside the placement
	// lock, but register it before unlocking so replacement cannot miss it.
	unlock()
	response, err := s.runtime.Exec(execContext, id, execRequest)
	s.finishExecution(id, execution)
	cancel()
	if err != nil && !errors.Is(err, ErrSecretDeliveryUnavailable) {
		s.logger.Error("Microsandbox runtime exec failed", "sandbox_id", id, "error", redactCredentialShapes(err.Error()))
	}

	// A completed operation can race with a lifecycle request immediately after
	// it leaves the registry. Never return output under a stale placement even
	// though the command itself was drained before runtime replacement.
	postUnlock := s.lock(id)
	postErr := s.state.Check(id, generation)
	postUnlock()
	if postErr != nil {
		writeError(writer, http.StatusConflict, "stale_generation", "sandbox placement changed while the command was running")
		return
	}
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (s *Server) handleWriteFile(writer http.ResponseWriter, request *http.Request) {
	var write sandbox.WriteFileRequest
	if !decodeJSON(writer, request, &write) {
		return
	}
	filePath, err := url.PathUnescape(chi.URLParam(request, "*"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_path", "guest file path is invalid")
		return
	}
	if _, err := sandbox.EscapeGuestPath(filePath); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_path", "guest file path is invalid")
		return
	}
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	defer unlock()
	if err := s.runtime.WriteFile(request.Context(), chi.URLParam(request, "sandboxID"), "/"+strings.TrimPrefix(filePath, "/"), write); err != nil {
		writeRuntimeError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleService(writer http.ResponseWriter, request *http.Request) {
	var service sandbox.ServiceSpec
	if !decodeJSON(writer, request, &service) {
		return
	}
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	defer unlock()
	id := chi.URLParam(request, "sandboxID")
	response, err := s.runtime.StartService(request.Context(), id, service)
	if err != nil {
		// The wire response deliberately hides the cause (runtime_error);
		// the worker log is the only place an operator can read it. Service
		// names and runtime errors carry no secret values; guest stderr is
		// truncated by the runtime and scrubbed of credential shapes here.
		s.logger.Error("Microsandbox runtime service start failed", "sandbox_id", id, "service", service.Name, "error", redactCredentialShapes(err.Error()))
		writeRuntimeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (s *Server) handleSnapshot(writer http.ResponseWriter, request *http.Request) {
	var snapshot msb.WorkerSnapshotRequest
	if !decodeJSON(writer, request, &snapshot) {
		return
	}
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	defer unlock()
	id := chi.URLParam(request, "sandboxID")
	if !s.requireExecutionsDrained(writer, request, id) {
		return
	}
	response, err := s.runtime.Snapshot(request.Context(), id, snapshot.SnapshotID, snapshot.Request)
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, response)
}

func (s *Server) handleDeleteSnapshot(writer http.ResponseWriter, request *http.Request) {
	snapshotID := chi.URLParam(request, "snapshotID")
	unlock := s.lockSnapshot(snapshotID)
	defer unlock()
	if err := s.runtime.DeleteSnapshot(request.Context(), snapshotID); err != nil && !runtimeNotFound(err) {
		writeRuntimeError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleExportSnapshot(writer http.ResponseWriter, request *http.Request) {
	snapshotID := chi.URLParam(request, "snapshotID")
	unlock := s.lockSnapshot(snapshotID)
	defer unlock()
	if err := os.MkdirAll(s.transferDir, 0o700); err != nil {
		writeRuntimeError(writer, err)
		return
	}
	archive, err := os.CreateTemp(s.transferDir, "snapshot-export-*.tar.zst")
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	archivePath := archive.Name()
	_ = archive.Close()
	defer func() { _ = os.Remove(archivePath) }()

	metadata, err := s.runtime.ExportSnapshot(request.Context(), snapshotID, archivePath)
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	file, err := os.Open(archivePath)
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	defer func() { _ = file.Close() }()
	writer.Header().Set("Content-Type", "application/zstd")
	writer.Header().Set("X-Plue-Snapshot-Digest", metadata.Digest)
	writer.Header().Set("Content-Length", strconv.FormatInt(metadata.SizeBytes, 10))
	writer.WriteHeader(http.StatusOK)
	_, _ = io.Copy(writer, file)
}

func (s *Server) handleImportSnapshot(writer http.ResponseWriter, request *http.Request) {
	snapshotID := chi.URLParam(request, "snapshotID")
	unlock := s.lockSnapshot(snapshotID)
	defer unlock()
	if err := os.MkdirAll(s.transferDir, 0o700); err != nil {
		writeRuntimeError(writer, err)
		return
	}
	archive, err := os.CreateTemp(s.transferDir, "snapshot-import-*.tar")
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	archivePath := archive.Name()
	defer func() { _ = os.Remove(archivePath) }()
	// A worker cannot accept an unbounded control-plane upload. The initial
	// fleet has 375 GiB disks; 320 GiB leaves headroom for runtime state.
	_, copyErr := copySnapshotArchive(archive, request.Body, maxSnapshotImportBytes)
	closeErr := archive.Close()
	if errors.Is(copyErr, ErrSnapshotArchiveTooLarge) {
		writeError(writer, http.StatusRequestEntityTooLarge, "snapshot_too_large", "snapshot import exceeded worker transfer limit")
		return
	}
	if copyErr != nil || closeErr != nil {
		writeRuntimeError(writer, errors.Join(copyErr, closeErr))
		return
	}
	metadata, err := s.runtime.ImportSnapshot(request.Context(), snapshotID, archivePath)
	if err != nil {
		s.logger.Error("Microsandbox runtime snapshot import failed", "snapshot_id", snapshotID, "error", err)
		writeRuntimeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, metadata)
}

func copySnapshotArchive(destination io.Writer, source io.Reader, limit int64) (int64, error) {
	limited := &io.LimitedReader{R: source, N: limit + 1}
	written, err := io.Copy(destination, limited)
	if err != nil {
		return written, err
	}
	if written > limit {
		return written, ErrSnapshotArchiveTooLarge
	}
	return written, nil
}

func (s *Server) handleSSH(writer http.ResponseWriter, request *http.Request) {
	guestUser := strings.TrimSpace(request.Header.Get(msb.SSHGuestUserHeader))
	if !validGuestUser(guestUser) {
		writeError(writer, http.StatusBadRequest, "guest_user_required", "a valid, grant-bound guest user is required")
		return
	}
	socket, err := websocket.Accept(writer, request, nil)
	if err != nil {
		return
	}
	defer func() { _ = socket.CloseNow() }()
	connection := websocket.NetConn(request.Context(), socket, websocket.MessageBinary)
	defer func() { _ = connection.Close() }()

	command := exec.CommandContext(request.Context(), s.sshBridgeBin, "ssh-bridge", chi.URLParam(request, "sandboxID"), guestUser)
	stdin, err := command.StdinPipe()
	if err != nil {
		_ = socket.Close(websocket.StatusInternalError, "SSH bridge unavailable")
		return
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = socket.Close(websocket.StatusInternalError, "SSH bridge unavailable")
		return
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		_ = socket.Close(websocket.StatusInternalError, "SSH bridge unavailable")
		return
	}
	if err := command.Start(); err != nil {
		_ = socket.Close(websocket.StatusInternalError, "SSH bridge unavailable")
		return
	}
	go func() {
		payload, _ := io.ReadAll(io.LimitReader(stderr, 64<<10))
		if len(payload) > 0 {
			s.logger.Warn("Microsandbox SSH bridge stderr", "message", strings.TrimSpace(string(payload)))
		}
	}()

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(stdin, connection)
		_ = stdin.Close()
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(connection, stdout)
		done <- struct{}{}
	}()
	select {
	case <-request.Context().Done():
	case <-done:
	}
	if command.Process != nil {
		_ = command.Process.Kill()
	}
	_ = command.Wait()
}

func validGuestUser(user string) bool {
	if user == "" || len(user) > 32 {
		return false
	}
	for index, character := range user {
		if (character >= 'a' && character <= 'z') || character == '_' ||
			(index > 0 && character >= '0' && character <= '9') ||
			(index > 0 && character == '-') {
			continue
		}
		return false
	}
	return true
}

func (s *Server) lock(id string) func() {
	return s.state.Lock(id)
}

func (s *Server) lockSnapshot(id string) func() {
	return s.snapshotMutations.Lock(id)
}

func requestCapacity(request sandbox.CreateRequest) msb.WorkerCapacity {
	cpus := int64(1)
	if request.VCPUCount != nil && *request.VCPUCount > 0 {
		cpus = int64(*request.VCPUCount)
	}
	memory := int64(512)
	if request.MemSizeMB != nil && *request.MemSizeMB > 0 {
		memory = int64(*request.MemSizeMB)
	}
	disk := msb.DefaultRootfsSizeMB(request.Kind)
	if request.RootfsSizeMB != nil && *request.RootfsSizeMB > 0 {
		disk = *request.RootfsSizeMB
	}
	return msb.WorkerCapacity{CPUMillis: cpus * 1000, MemoryBytes: memory * 1024 * 1024, DiskBytes: disk * 1024 * 1024, VMs: 1}
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, destination any) bool {
	// Must accept what the controller accepts (control/controller.go maxRequestBody).
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 64<<20))
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

func writeRuntimeError(writer http.ResponseWriter, err error) {
	if errors.Is(err, ErrSecretDeliveryUnavailable) {
		writeError(writer, http.StatusNotImplemented, "secret_delivery_unavailable",
			"operation-scoped secret delivery is unavailable: no nonpersisting channel exists in this runtime")
		return
	}
	if errors.Is(err, ErrEgressProxyUnavailable) {
		writeError(writer, http.StatusServiceUnavailable, "egress_proxy_unavailable",
			"per-sandbox egress proxy is unavailable on this worker; the sandbox was not started without its credential boundary")
		return
	}
	if errors.Is(err, ErrQuiesceFailed) {
		writeError(writer, http.StatusConflict, "quiesce_failed", "guest filesystem quiescence failed")
		return
	}
	if runtimeNotFound(err) {
		writeError(writer, http.StatusNotFound, "not_found", "Microsandbox resource was not found")
		return
	}
	writeError(writer, http.StatusInternalServerError, "runtime_error", "Microsandbox runtime operation failed")
}

func runtimeNotFound(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "not found") || strings.Contains(text, "does not exist")
}

var _ http.Handler = (*Server)(nil)

// egressRevoker is the optional runtime surface behind the egress revocation
// route; a runtime without it answers as if the sandbox had no proxy.
type egressRevoker interface {
	RevokeEgress(context.Context, string, sandbox.EgressRevokeRequest) (sandbox.EgressRevokeResult, error)
}

// handleRevokeEgress tears down a sandbox's egress proxy immediately when the
// controller reports that the authorization behind it was revoked.
func (s *Server) handleRevokeEgress(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "sandboxID")
	unlock, ok := s.lockRequestPlacement(writer, request)
	if !ok {
		return
	}
	defer unlock()
	var req sandbox.EgressRevokeRequest
	if request.Body != nil && request.ContentLength != 0 && !decodeJSON(writer, request, &req) {
		return
	}
	revoker, ok := s.runtime.(egressRevoker)
	if !ok {
		writeJSON(writer, http.StatusOK, sandbox.EgressRevokeResult{SandboxID: id})
		return
	}
	result, err := revoker.RevokeEgress(request.Context(), id, req)
	if err != nil {
		writeRuntimeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}
