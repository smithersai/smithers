package flowdispatch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
)

type productHostProcess struct {
	command  *exec.Cmd
	done     chan error
	logs     *bytes.Buffer
	stopOnce sync.Once
	stopped  chan struct{}
}

type observedAcceptanceRuntime struct {
	flowruntime.Runtime
	t *testing.T
}

func (runtime observedAcceptanceRuntime) Observe(ctx context.Context, runID, cursor string, limit int) (flowruntime.Observation, error) {
	observation, err := runtime.Runtime.Observe(ctx, runID, cursor, limit)
	if err == nil && (!validObservationPage(cursor, observation) || observation.Run.FlowID != "librarian/history" || observation.Run.RunID != runID || observation.Terminal != terminalStatus(observation.Run.Status)) {
		sequences := make([]int64, 0, len(observation.Events))
		for _, event := range observation.Events {
			sequence := event.Sequence
			if event.Cursor != nil {
				sequence = event.Cursor.Sequence
			}
			sequences = append(sequences, sequence)
		}
		runtime.t.Logf("invalid real-host observation: run=%+v after=%s next=%s terminal=%t sequences=%v", observation.Run, cursor, observation.NextCursor, observation.Terminal, sequences)
	}
	return observation, err
}

func startProductHost(
	t *testing.T,
	node, artifact, root string,
	port int,
	digest, revision string,
	generation int64,
) (*productHostProcess, *runtimebridge.Client) {
	t.Helper()
	logs := &bytes.Buffer{}
	command := exec.Command(node, artifact, "serve", "--root", root, "--port", strconv.Itoa(port))
	command.Dir = root
	command.Env = append(os.Environ(),
		"AI_GATEWAY_API_KEY=fixture",
		"SMITHERS_API_KEY=fixture",
		"SMITHERS_GATEWAY_ID=11111111-1111-4111-8111-111111111111",
		"SMITHERS_OWNER_GENERATION="+strconv.FormatInt(generation, 10),
		"SMITHERS_SOURCE_REVISION="+revision,
		"SMITHERS_FLOW_ARTIFACT_SHA256="+digest,
		"SMITHERS_REPO=fixture/demo",
		"SMITHERS_PRODUCT_API_URL=http://127.0.0.1:1",
	)
	command.Stdout = logs
	command.Stderr = logs
	require.NoError(t, command.Start())
	host := &productHostProcess{command: command, done: make(chan error, 1), logs: logs, stopped: make(chan struct{})}
	go func() { host.done <- command.Wait() }()
	client, err := runtimebridge.New(runtimebridge.Config{
		Endpoint: "http://127.0.0.1:" + strconv.Itoa(port), Credential: "fixture",
	})
	require.NoError(t, err)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		identity, identityErr := client.Identity(context.Background())
		if identityErr == nil {
			require.Equal(t, flowruntime.Protocol, identity.Protocol)
			require.Equal(t, digest, identity.RuntimeArtifactDigest)
			require.Equal(t, revision, identity.SourceRevision)
			require.Equal(t, generation, identity.OwnerGeneration)
			return host, client
		}
		select {
		case waitErr := <-host.done:
			t.Fatalf("product host exited before readiness: %v\n%s", waitErr, logs.String())
		default:
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("product host did not become ready\n%s", logs.String())
	return nil, nil
}

func (host *productHostProcess) stop(t *testing.T) {
	t.Helper()
	if host == nil || host.command == nil || host.command.Process == nil {
		return
	}
	host.stopOnce.Do(func() {
		_ = host.command.Process.Signal(syscall.SIGTERM)
		select {
		case <-host.done:
		case <-time.After(10 * time.Second):
			_ = host.command.Process.Kill()
			<-host.done
		}
		close(host.stopped)
	})
	select {
	case <-host.stopped:
	case <-time.After(11 * time.Second):
		t.Fatalf("product host did not stop\n%s", host.logs.String())
	}
}

func runCommand(t *testing.T, directory, name string, arguments ...string) string {
	t.Helper()
	command := exec.Command(name, arguments...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	require.NoError(t, err, "%s %v: %s", name, arguments, output)
	return strings.TrimSpace(string(output))
}

func startAcceptanceWorker(service *Service, workerID string) (context.CancelFunc, <-chan error) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		defer close(done)
		done <- service.RunWorker(ctx, jobs.WorkerConfig{
			WorkerID: workerID, Capacity: 2, Lease: 5 * time.Second,
			PollInterval: 10 * time.Millisecond, RetryDelay: 20 * time.Millisecond,
		})
	}()
	return cancel, done
}

func stopAcceptanceWorker(t *testing.T, cancel context.CancelFunc, done <-chan error) {
	t.Helper()
	cancel()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("Flow acceptance worker did not stop")
	}
}

// This opt-in acceptance crosses the complete production boundary: shared Go
// admission, the packaged TypeScript host, canonical Control receipts/journal,
// PostgreSQL reconnect, owner replacement, terminal projection, and durable
// cancellation. It never downloads a runtime artifact.
func TestRealBundledHostAdmissionReconnectCompletionAndCancellation(t *testing.T) {
	if os.Getenv("SMITHERS_FLOWDISPATCH_REAL_HOST") != "1" {
		t.Skip("set SMITHERS_FLOWDISPATCH_REAL_HOST=1 to build and execute the bundled product host")
	}
	store, _ := newFlowDispatchStore(t)
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	require.NoError(t, err)
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	fixtureRoot := t.TempDir()
	runCommand(t, fixtureRoot, "git", "init", "-b", "main")
	runCommand(t, fixtureRoot, "git", "config", "user.name", "Fixture")
	runCommand(t, fixtureRoot, "git", "config", "user.email", "fixture@example.invalid")
	require.NoError(t, os.WriteFile(filepath.Join(fixtureRoot, "README.md"), []byte("# Fixture\n"), 0o644))
	runCommand(t, fixtureRoot, "git", "add", ".")
	runCommand(t, fixtureRoot, "git", "commit", "-m", "Fixture")
	revision := runCommand(t, fixtureRoot, "git", "rev-parse", "HEAD")
	require.Len(t, revision, 40)

	artifact := filepath.Join(t.TempDir(), "smithers-product-host.mjs")
	build := exec.Command(node, "--input-type=module", "--eval",
		`import { buildProductHost } from "./flows/librarian/build.mjs"; await buildProductHost(process.argv[1])`, artifact)
	build.Dir = repositoryRoot
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	artifactBytes, err := os.ReadFile(artifact)
	require.NoError(t, err)
	digestBytes := sha256.Sum256(artifactBytes)
	digest := hex.EncodeToString(digestBytes[:])

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	var client flowruntime.Runtime
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			if client == nil {
				return nil, &testRuntimeFailure{code: "runtime_not_started", retryable: true}
			}
			return observedAcceptanceRuntime{Runtime: client, t: t}, nil
		}), ObservationDelay: 10 * time.Millisecond,
	})
	require.NoError(t, err)
	request := LaunchRequest{
		Scope: jobs.Scope{TenantID: "owner", PrincipalID: "owner"}, RequestID: "real-host-history",
		Target: flowruntime.Target{BindingKind: "trusted-owner", BindingID: "owner"},
		FlowID: "librarian/history", Payload: []byte(`{"repo":"fixture/demo","_librarian":{"kind":"history"}}`),
		AuthorizationContext: []byte(`{"role":"owner"}`), Projection: []byte(`{"kind":"acceptance"}`),
		ApprovalPolicy: ApprovalManual,
	}
	admittedAt := time.Now()
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	require.Less(t, time.Since(admittedAt), time.Second)
	joined, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	require.True(t, joined.Joined)
	require.Equal(t, receipt.OperationID, joined.OperationID)
	pending, err := store.Get(context.Background(), request.Scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateAccepted, pending.State)
	require.Empty(t, pending.ExternalReceipt)

	// The product request exists before the packaged host. Starting and
	// reaching the canonical runtime are worker concerns, never part of the
	// caller's launch latency.
	host, runtimeClient := startProductHost(t, node, artifact, fixtureRoot, port, digest, revision, 1)
	client = runtimeClient
	t.Cleanup(func() { host.stop(t) })

	stopFirst, firstDone := startAcceptanceWorker(service, "real-host-owner-1")
	t.Cleanup(func() { stopAcceptanceWorker(t, stopFirst, firstDone) })
	parked := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateWaiting && bytes.Contains(operation.ExternalReceipt, []byte(`"Parked"`))
	})
	require.Empty(t, parked.TerminalReceipt)
	stopAcceptanceWorker(t, stopFirst, firstDone)
	host.stop(t)
	approval, err := service.Approve(context.Background(), request.Scope, receipt.OperationID, "real-host-approval", []byte(`{"role":"owner"}`))
	require.NoError(t, err)
	require.Equal(t, jobs.StateAccepted, approval.State)

	host, client = startProductHost(t, node, artifact, fixtureRoot, port, digest, revision, 2)
	stopSecond, secondDone := startAcceptanceWorker(service, "real-host-owner-2")
	t.Cleanup(func() { stopAcceptanceWorker(t, stopSecond, secondDone) })
	completed := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCompleted
	})
	var terminal terminalReceipt
	require.NoError(t, json.Unmarshal(completed.TerminalReceipt, &terminal))
	require.NotNil(t, terminal.Run)
	require.Equal(t, "completed", terminal.Run.Status)
	page, err := store.Replay(context.Background(), request.Scope, 0, 1000)
	require.NoError(t, err)
	require.NotEmpty(t, page.Events)
	require.Equal(t, "operation.completed", page.Events[len(page.Events)-1].Type)

	cancelRequest := request
	cancelRequest.RequestID = "real-host-cancel"
	cancelReceipt, err := service.Admit(context.Background(), cancelRequest)
	require.NoError(t, err)
	waitOperation(t, store, request.Scope, cancelReceipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateWaiting && bytes.Contains(operation.ExternalReceipt, []byte(`"Parked"`))
	})
	pending, err = service.CancelRequest(context.Background(), request.Scope, cancelRequest.RequestID)
	require.NoError(t, err)
	require.True(t, pending.CancellationRequested)
	waitOperation(t, store, request.Scope, cancelReceipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCancelled
	})
	stopAcceptanceWorker(t, stopSecond, secondDone)
	host.stop(t)
}

func Example_realHostAcceptanceCommand() {
	fmt.Println("SMITHERS_FLOWDISPATCH_REAL_HOST=1 GOMAXPROCS=2 go test -p 2 ./packages/backend/flowdispatch -run RealBundledHost -v")
	// Output: SMITHERS_FLOWDISPATCH_REAL_HOST=1 GOMAXPROCS=2 go test -p 2 ./packages/backend/flowdispatch -run RealBundledHost -v
}
