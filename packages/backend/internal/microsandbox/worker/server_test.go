package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type serverTestRuntime struct {
	Runtime
	mu      sync.Mutex
	creates int
	deletes int
	starts  int
	state   sandbox.State
}

func TestRequestCapacityUsesKindSpecificWritableDisk(t *testing.T) {
	assert.EqualValues(t, 2*1024*1024*1024, requestCapacity(sandbox.CreateRequest{Kind: "container"}).DiskBytes)
	assert.EqualValues(t, 4*1024*1024*1024, requestCapacity(sandbox.CreateRequest{Kind: "vm"}).DiskBytes)
	assert.EqualValues(t, 8*1024*1024*1024, requestCapacity(sandbox.CreateRequest{Kind: "desktop"}).DiskBytes)
	explicit := int64(12 * 1024)
	assert.EqualValues(t, 12*1024*1024*1024, requestCapacity(sandbox.CreateRequest{Kind: "container", RootfsSizeMB: &explicit}).DiskBytes)
}

type blockingSnapshotRuntime struct {
	Runtime
	entered chan struct{}
	release chan struct{}
	mu      sync.Mutex
	active  int
	maximum int
}

type blockingExecRuntime struct {
	*serverTestRuntime
	entered chan struct{}
	stopped chan struct{}
}

func (r *blockingExecRuntime) Exec(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
	close(r.entered)
	<-ctx.Done()
	close(r.stopped)
	return sandbox.ExecResult{Stdout: "stale-generation-output"}, ctx.Err()
}

func (r *blockingExecRuntime) Delete(ctx context.Context, id string) error {
	select {
	case <-r.stopped:
		return r.serverTestRuntime.Delete(ctx, id)
	default:
		return errors.New("runtime replacement began before the active exec stopped")
	}
}

func (r *blockingSnapshotRuntime) ImportSnapshot(_ context.Context, id, _ string) (msb.SnapshotTransferMetadata, error) {
	r.mu.Lock()
	r.active++
	if r.active > r.maximum {
		r.maximum = r.active
	}
	r.mu.Unlock()
	r.entered <- struct{}{}
	<-r.release
	r.mu.Lock()
	r.active--
	r.mu.Unlock()
	return msb.SnapshotTransferMetadata{SnapshotID: id, Digest: "sha256:test"}, nil
}

func (r *serverTestRuntime) Create(_ context.Context, id string, _ int64, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.creates++
	return sandbox.CreateResult{ID: id}, nil
}
func (r *serverTestRuntime) Get(_ context.Context, id string) (sandbox.Sandbox, error) {
	state := r.state
	if state == "" {
		state = sandbox.StateRunning
	}
	return sandbox.Sandbox{ID: id, State: state}, nil
}
func (r *serverTestRuntime) Start(_ context.Context, id string) (sandbox.StartResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.starts++
	r.state = sandbox.StateRunning
	return sandbox.StartResult{ID: id, RuntimeID: id}, nil
}
func (r *serverTestRuntime) Delete(context.Context, string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deletes++
	return nil
}

type mutationRecordingRuntime struct {
	*serverTestRuntime
	stops int
	execs int
}

func (r *mutationRecordingRuntime) Stop(context.Context, string) (sandbox.StopResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stops++
	return sandbox.StopResult{}, nil
}

func (r *mutationRecordingRuntime) Exec(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.execs++
	return sandbox.ExecResult{}, nil
}

func (r *mutationRecordingRuntime) counts() (stops, execs, deletes int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stops, r.execs, r.deletes
}

func TestExecWithSecretsFailsClosedThroughRealRuntime(t *testing.T) {
	// Uses the real SDKRuntime: the typed refusal fires before any SDK
	// connection, so a live guest is not required.
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_secret", Allocation{
		Generation: 1, ObservedState: "running", BootstrapComplete: true,
	}))
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: NewSDKRuntime()})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	headers := http.Header{}
	headers.Set(msb.WorkerIDHeader, "worker-a")
	headers.Set(msb.PlacementGenerationHeader, "1")
	sentinel := "PLUE_SECRET_SENTINEL_server_fail_closed"

	response := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes/msb_secret/exec",
		`{"command":"env","secrets":{"API_TOKEN":"`+sentinel+`"}}`, headers)
	assert.Equal(t, http.StatusNotImplemented, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "secret_delivery_unavailable")
	assert.NotContains(t, response.Body.String(), sentinel)
}

func TestCreateWithEgressProxyFailsClosedThroughRealRuntimeWithoutEchoingValues(t *testing.T) {
	// The real SDKRuntime has no proxy manager here, so the typed refusal
	// fires before any guest boots. The response must name the contract code
	// and never echo the credential value or the placeholder mapping.
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: NewSDKRuntime()})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	headers := http.Header{}
	headers.Set(msb.WorkerIDHeader, "worker-a")
	sentinel := "PLUE_SECRET_SENTINEL_server_egress"
	payload, err := json.Marshal(msb.WorkerCreateRequest{
		SandboxID: "msb_egress", Generation: 1,
		Request: sandbox.CreateRequest{
			Image: "registry.invalid/never:pulled",
			EgressProxy: &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{
				Name: "ANTHROPIC_API_KEY", Value: sentinel, Hosts: []string{"api.anthropic.com"}, MatchHeaders: []string{"x-api-key"},
			}}},
		},
	})
	require.NoError(t, err)
	response := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), headers)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "egress_proxy_unavailable")
	assert.NotContains(t, response.Body.String(), sentinel)
	_, allocated := state.CurrentAllocation("msb_egress")
	assert.False(t, allocated, "a refused create leaves no allocation behind")
}

func TestPostRelocationMutationCarryingPriorGenerationIsRejectedWithoutSideEffects(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_relocated", Allocation{
		Generation: 2, ObservedState: "running", BootstrapComplete: true,
	}))
	runtime := &mutationRecordingRuntime{serverTestRuntime: &serverTestRuntime{}}
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	headers := http.Header{}
	headers.Set(msb.WorkerIDHeader, "worker-a")

	// The sandbox relocates away during a drain and later returns under a newer
	// placement generation, exactly like a controller-driven relocation.
	payload, err := json.Marshal(msb.WorkerCreateRequest{
		SandboxID: "msb_relocated", Generation: 5,
		Request: sandbox.CreateRequest{Image: "image"},
	})
	require.NoError(t, err)
	relocated := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), headers)
	require.Equal(t, http.StatusCreated, relocated.Code, relocated.Body.String())
	baselineStops, baselineExecs, baselineDeletes := runtime.counts()

	// Every mutation carrying the pre-relocation generation must be rejected
	// without reaching the runtime.
	stale := http.Header{}
	stale.Set(msb.WorkerIDHeader, "worker-a")
	stale.Set(msb.PlacementGenerationHeader, "2")
	for _, mutation := range []struct{ method, path, body string }{
		{http.MethodPost, "/internal/v1/sandboxes/msb_relocated/stop", ""},
		{http.MethodPost, "/internal/v1/sandboxes/msb_relocated/exec", `{"command":"touch /tmp/side-effect"}`},
		{http.MethodDelete, "/internal/v1/sandboxes/msb_relocated", ""},
	} {
		response := workerRequest(server, mutation.method, mutation.path, mutation.body, stale)
		assert.Equal(t, http.StatusConflict, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), "stale_generation")
	}
	stops, execs, deletes := runtime.counts()
	assert.Equal(t, baselineStops, stops)
	assert.Equal(t, baselineExecs, execs)
	assert.Equal(t, baselineDeletes, deletes)
	assert.NoError(t, state.Check("msb_relocated", 5))
}

func TestWorkerPromotesRetainedStoppedDiskUnderNewGeneration(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_retained", Allocation{
		Generation: 1, ObservedState: "stopped", BootstrapComplete: true,
	}))
	runtime := &serverTestRuntime{state: sandbox.StateStopped}
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	payload, err := json.Marshal(msb.WorkerCreateRequest{
		SandboxID: "msb_retained", Generation: 2, ReuseStoppedDisk: true,
		Request: sandbox.CreateRequest{SnapshotID: "msbs_checkpoint"},
	})
	require.NoError(t, err)

	promoted := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
	require.Equal(t, http.StatusCreated, promoted.Code, promoted.Body.String())
	assert.NoError(t, state.Check("msb_retained", 2))
	assert.Equal(t, 0, runtime.creates)
	assert.Equal(t, 0, runtime.deletes)
	assert.Equal(t, 1, runtime.starts)

	replayed := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
	require.Equal(t, http.StatusOK, replayed.Code, replayed.Body.String())
	assert.Equal(t, 1, runtime.starts)

	stale := http.Header{}
	stale.Set(msb.PlacementGenerationHeader, "1")
	response := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes/msb_retained/stop", "", stale)
	assert.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "stale_generation")
}

func TestWorkerRetainedDiskPromotionFailsClosedWithoutStoppedAllocation(t *testing.T) {
	payload, err := json.Marshal(msb.WorkerCreateRequest{
		SandboxID: "msb_retained", Generation: 2, ReuseStoppedDisk: true,
		Request: sandbox.CreateRequest{SnapshotID: "msbs_checkpoint"},
	})
	require.NoError(t, err)

	t.Run("missing durable allocation", func(t *testing.T) {
		state, loadErr := LoadState(filepath.Join(t.TempDir(), "state.json"))
		require.NoError(t, loadErr)
		runtime := &serverTestRuntime{state: sandbox.StateStopped}
		server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
		server.AuthorizeUntil(time.Now().Add(time.Minute), true)

		response := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
		assert.Equal(t, http.StatusConflict, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), "retained_runtime_not_found")
		assert.Equal(t, 0, runtime.creates)
		assert.Equal(t, 0, runtime.starts)
	})

	t.Run("runtime is still running", func(t *testing.T) {
		state, loadErr := LoadState(filepath.Join(t.TempDir(), "state.json"))
		require.NoError(t, loadErr)
		require.NoError(t, state.Register("msb_retained", Allocation{
			Generation: 1, ObservedState: "running", BootstrapComplete: true,
		}))
		runtime := &serverTestRuntime{state: sandbox.StateRunning}
		server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
		server.AuthorizeUntil(time.Now().Add(time.Minute), true)

		response := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
		assert.Equal(t, http.StatusConflict, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), "retained_runtime_not_stopped")
		assert.Equal(t, 0, runtime.creates)
		assert.Equal(t, 0, runtime.starts)
		assert.NoError(t, state.Check("msb_retained", 1))
	})
}

func TestWorkerStartsFencedAndDrainingRejectsAdmission(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	runtime := &serverTestRuntime{}
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	payload, err := json.Marshal(msb.WorkerCreateRequest{SandboxID: "msb_test", Generation: 1, Request: sandbox.CreateRequest{Image: "image"}})
	require.NoError(t, err)

	fenced := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
	assert.Equal(t, http.StatusServiceUnavailable, fenced.Code)
	assert.Contains(t, fenced.Body.String(), "worker_fenced")

	server.AuthorizeUntil(time.Now().Add(time.Minute), false)
	draining := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
	assert.Equal(t, http.StatusServiceUnavailable, draining.Code)
	assert.Contains(t, draining.Body.String(), "worker_draining")

	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	created := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
	assert.Equal(t, http.StatusCreated, created.Code)
	assert.Equal(t, 1, runtime.creates)
	replayed := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
	assert.Equal(t, http.StatusOK, replayed.Code)
	assert.Equal(t, 1, runtime.creates)
}

func TestWorkerRecreatesRuntimeWhoseBootstrapWasInterrupted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	state, err := LoadState(path)
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_interrupted", Allocation{Generation: 1}))
	// A replacement process sees a durable `starting` allocation and a live
	// runtime left behind by the old process.
	state, err = LoadState(path)
	require.NoError(t, err)
	runtime := &serverTestRuntime{}
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	payload, err := json.Marshal(msb.WorkerCreateRequest{
		SandboxID: "msb_interrupted", Generation: 1,
		Request: sandbox.CreateRequest{Image: "image"},
	})
	require.NoError(t, err)

	response := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
	assert.Equal(t, http.StatusCreated, response.Code)
	assert.Equal(t, 1, runtime.deletes)
	assert.Equal(t, 1, runtime.creates)
	allocation, err := state.Allocation("msb_interrupted", 1)
	require.NoError(t, err)
	assert.True(t, allocation.BootstrapComplete)
}

func TestWorkerReplacesLingeringOlderGeneration(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_returning", Allocation{Generation: 2, ObservedState: "running"}))
	runtime := &serverTestRuntime{}
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	payload, err := json.Marshal(msb.WorkerCreateRequest{
		SandboxID: "msb_returning", Generation: 5,
		Request: sandbox.CreateRequest{Image: "image"},
	})
	require.NoError(t, err)
	headers := http.Header{}
	headers.Set(msb.WorkerIDHeader, "worker-a")

	response := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), headers)
	assert.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	assert.Equal(t, 1, runtime.deletes)
	assert.Equal(t, 1, runtime.creates)
	allocation, err := state.Allocation("msb_returning", 5)
	require.NoError(t, err)
	assert.True(t, allocation.BootstrapComplete)
}

func TestWorkerDrainsExecBeforeReplacingGenerationAndDiscardsStaleOutput(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_exec_race", Allocation{
		Generation: 1, ObservedState: "running", BootstrapComplete: true,
	}))
	runtime := &blockingExecRuntime{
		serverTestRuntime: &serverTestRuntime{},
		entered:           make(chan struct{}),
		stopped:           make(chan struct{}),
	}
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	headers := http.Header{}
	headers.Set(msb.WorkerIDHeader, "worker-a")
	headers.Set(msb.PlacementGenerationHeader, "1")
	execResponses := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		execResponses <- workerRequest(server, http.MethodPost,
			"/internal/v1/sandboxes/msb_exec_race/exec", `{"command":"sleep 300"}`, headers)
	}()
	select {
	case <-runtime.entered:
	case <-time.After(time.Second):
		t.Fatal("exec did not enter the runtime")
	}

	payload, err := json.Marshal(msb.WorkerCreateRequest{
		SandboxID: "msb_exec_race", Generation: 2,
		Request: sandbox.CreateRequest{Image: "image"},
	})
	require.NoError(t, err)
	replaced := workerRequest(server, http.MethodPost, "/internal/v1/sandboxes", string(payload), nil)
	assert.Equal(t, http.StatusCreated, replaced.Code, replaced.Body.String())

	select {
	case response := <-execResponses:
		assert.Equal(t, http.StatusConflict, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), "stale_generation")
		assert.NotContains(t, response.Body.String(), "stale-generation-output")
	case <-time.After(time.Second):
		t.Fatal("stale exec response did not complete")
	}
	assert.NoError(t, state.Check("msb_exec_race", 2))
	runtime.mu.Lock()
	assert.Equal(t, 1, runtime.deletes)
	assert.Equal(t, 1, runtime.creates)
	runtime.mu.Unlock()
	server.executionsMu.Lock()
	assert.Empty(t, server.executions)
	server.executionsMu.Unlock()
}

func TestWorkerRejectsStalePlacementGeneration(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_test", Allocation{Generation: 3}))
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: &serverTestRuntime{}})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)

	headers := http.Header{}
	headers.Set(msb.WorkerIDHeader, "worker-a")
	headers.Set(msb.PlacementGenerationHeader, "2")
	response := workerRequest(server, http.MethodGet, "/internal/v1/sandboxes/msb_test", "", headers)
	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Contains(t, response.Body.String(), "stale_generation")
}

func TestWorkerOrphanCleanupHonorsPersistedGeneration(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_old", Allocation{Generation: 4}))
	runtime := &serverTestRuntime{}
	server := NewServer(ServerConfig{AllowInsecureDev: true, WorkerID: "worker-a", State: state, Runtime: runtime})
	server.ScheduleOrphanDeletion(context.Background(), []msb.WorkerInventoryItem{
		{SandboxID: "msb_old", Generation: 3},
		{SandboxID: "msb_old", Generation: 4},
	})
	require.Eventually(t, func() bool {
		runtime.mu.Lock()
		defer runtime.mu.Unlock()
		return runtime.deletes == 1
	}, time.Second, 10*time.Millisecond)
	assert.Error(t, state.Check("msb_old", 4))
}

func TestQuiesceFailureIsExplicitConflict(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeRuntimeError(recorder, ErrQuiesceFailed)
	assert.Equal(t, http.StatusConflict, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "quiesce_failed")
}

func TestCopySnapshotArchiveAcceptsExactLimitAndRejectsOnlyExtraByte(t *testing.T) {
	var exact bytes.Buffer
	written, err := copySnapshotArchive(&exact, strings.NewReader("1234"), 4)
	require.NoError(t, err)
	assert.EqualValues(t, 4, written)
	assert.Equal(t, "1234", exact.String())

	var oversized bytes.Buffer
	written, err = copySnapshotArchive(&oversized, strings.NewReader("12345"), 4)
	assert.ErrorIs(t, err, ErrSnapshotArchiveTooLarge)
	assert.EqualValues(t, 5, written)
}

func TestWorkerSerializesConcurrentImportsForSameSnapshot(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	runtime := &blockingSnapshotRuntime{entered: make(chan struct{}, 2), release: make(chan struct{}, 2)}
	server := NewServer(ServerConfig{AllowInsecureDev: true,
		WorkerID: "worker-a", State: state, Runtime: runtime, TransferDir: t.TempDir(),
	})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)
	responses := make(chan *httptest.ResponseRecorder, 2)
	requestImport := func() {
		responses <- workerRequest(server, http.MethodPut, "/internal/v1/snapshots/msbs_same/import", "archive", nil)
	}
	go requestImport()
	<-runtime.entered
	go requestImport()
	select {
	case <-runtime.entered:
		t.Fatal("second import entered the runtime before the first released its snapshot lock")
	case <-time.After(100 * time.Millisecond):
	}
	runtime.release <- struct{}{}
	select {
	case <-runtime.entered:
	case <-time.After(time.Second):
		t.Fatal("second import did not proceed after the first released its snapshot lock")
	}
	runtime.release <- struct{}{}
	for range 2 {
		response := <-responses
		assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	assert.Equal(t, 1, runtime.maximum)
	assert.Equal(t, 0, server.snapshotMutations.count())
}

func TestWorkerSSHBridgeRequiresAndPropagatesGrantBoundGuestUser(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_ssh", Allocation{Generation: 3, ObservedState: "running"}))
	argsPath := filepath.Join(t.TempDir(), "args")
	homePath := filepath.Join(t.TempDir(), "home")
	bridgeHome := t.TempDir()
	t.Setenv("HOME", bridgeHome)
	bridgePath := filepath.Join(t.TempDir(), "bridge.sh")
	script := "#!/bin/sh\nprintf '%s\\n' \"$HOME\" > " + shellQuote(homePath) + "\nprintf '%s\\n' \"$@\" > " + shellQuote(argsPath) + "\ncat\n"
	require.NoError(t, os.WriteFile(bridgePath, []byte(script), 0o700))
	server := NewServer(ServerConfig{AllowInsecureDev: true,
		WorkerID: "worker-a", State: state, Runtime: &serverTestRuntime{}, SSHBridgeBin: bridgePath,
	})
	server.AuthorizeUntil(time.Now().Add(time.Minute), true)

	headers := http.Header{}
	headers.Set(msb.WorkerIDHeader, "worker-a")
	headers.Set(msb.PlacementGenerationHeader, "3")
	missing := workerRequest(server, http.MethodGet, "/internal/v1/sandboxes/msb_ssh/ssh", "", headers)
	assert.Equal(t, http.StatusBadRequest, missing.Code)
	assert.Contains(t, missing.Body.String(), "guest_user_required")

	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	endpoint := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/internal/v1/sandboxes/msb_ssh/ssh"
	headers.Set(msb.SSHGuestUserHeader, "developer")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	socket, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: headers})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	defer socket.CloseNow()
	require.NoError(t, socket.Write(ctx, websocket.MessageBinary, []byte("transport")))
	_, payload, err := socket.Read(ctx)
	require.NoError(t, err)
	assert.Equal(t, []byte("transport"), payload)
	require.Eventually(t, func() bool {
		args, readErr := os.ReadFile(argsPath)
		return readErr == nil && string(args) == "ssh-bridge\nmsb_ssh\ndeveloper\n"
	}, 5*time.Second, 10*time.Millisecond)
	home, err := os.ReadFile(homePath)
	require.NoError(t, err)
	assert.Equal(t, bridgeHome+"\n", string(home))
}

func TestKeyedMutexPrunesIdleEntries(t *testing.T) {
	var locks keyedMutex
	unlock := locks.Lock("sandbox")
	assert.Equal(t, 1, locks.count())
	if blockedUnlock, ok := locks.TryLock("sandbox"); ok {
		blockedUnlock()
		t.Fatal("TryLock unexpectedly acquired a held key")
	}
	assert.Equal(t, 1, locks.count())
	unlock()
	assert.Equal(t, 0, locks.count())
}

func workerRequest(handler http.Handler, method, path, body string, headers http.Header) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	for name, values := range headers {
		request.Header[name] = append([]string(nil), values...)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// The worker executes code and writes files for whoever reaches its internal
// routes, so a missing controller identity must refuse them, as the
// controller's own peer check does, unless dev mode is explicit.
func TestWorkerRefusesInternalRoutesWithoutControllerIdentity(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_open", Allocation{Generation: 1, ObservedState: "running"}))
	headers := http.Header{}
	headers.Set(msb.WorkerIDHeader, "worker-a")
	headers.Set(msb.PlacementGenerationHeader, "1")

	closed := NewServer(ServerConfig{WorkerID: "worker-a", State: state, Runtime: &serverTestRuntime{}})
	closed.AuthorizeUntil(time.Now().Add(time.Minute), true)
	refused := workerRequest(closed, http.MethodGet, "/internal/v1/sandboxes/msb_open", "", headers)
	assert.Equal(t, http.StatusServiceUnavailable, refused.Code)
	assert.Contains(t, refused.Body.String(), "authentication_not_configured")
	assert.Equal(t, http.StatusOK, workerRequest(closed, http.MethodGet, "/healthz", "", nil).Code)

	dev := NewServer(ServerConfig{WorkerID: "worker-a", State: state, Runtime: &serverTestRuntime{}, AllowInsecureDev: true})
	dev.AuthorizeUntil(time.Now().Add(time.Minute), true)
	assert.NotEqual(t, http.StatusServiceUnavailable, workerRequest(dev, http.MethodGet, "/internal/v1/sandboxes/msb_open", "", headers).Code)
}
