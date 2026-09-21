package control

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// hostileSnapshotStore fails every object-storage call. Any test using it
// proves the code path under test never touched GCS.
type hostileSnapshotStore struct{ opens atomic.Int32 }

func (s *hostileSnapshotStore) Put(context.Context, string, io.Reader) (string, string, int64, error) {
	return "", "", 0, errors.New("object storage must not be written on this path")
}

func (s *hostileSnapshotStore) Open(context.Context, string) (io.ReadCloser, error) {
	s.opens.Add(1)
	return nil, errors.New("object storage is unavailable")
}

func (s *hostileSnapshotStore) Delete(context.Context, string) error { return nil }

// TestEnsureSnapshotAvailableSkipsObjectStorageWhenWorkerAlreadyHoldsSnapshot
// is the create-path SPOF fix. Allocate prefers the snapshot's own worker, so
// this is the COMMON case for every golden-snapshot workspace boot: before the
// fix a non-empty object_uri made it re-download ~140 MB from GCS and re-import
// it to a worker that already had the artifact, which also made object storage
// a hard dependency of creates that needed nothing from it.
func TestEnsureSnapshotAvailableSkipsObjectStorageWhenWorkerAlreadyHoldsSnapshot(t *testing.T) {
	var imports atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPut && strings.HasSuffix(request.URL.Path, "/import") {
			imports.Add(1)
		}
		http.NotFound(writer, request)
	}))
	defer worker.Close()

	objects := &hostileSnapshotStore{}
	controller := New(&controllerTestStore{}, Config{SnapshotStore: objects, AllowInsecureDev: true})

	err := controller.ensureSnapshotAvailable(context.Background(), Placement{
		SandboxID: "msb_a", LocalID: "msb_a", WorkerID: "worker-a",
		WorkerURL: worker.URL, Generation: 1,
		SnapshotLocalID: "msbs_golden", SnapshotWorkerID: "worker-a",
		SnapshotObjectURI: "gs://bucket/golden.tar", SnapshotDigest: "digest-1",
	})

	require.NoError(t, err, "a snapshot already on the target worker must not need object storage")
	assert.Zero(t, objects.opens.Load(), "GCS must not be read when the worker already holds the snapshot")
	assert.Zero(t, imports.Load(), "the worker must not be asked to re-import a snapshot it already has")
}

// The relocation case must still go through durable storage: a different worker
// genuinely does not have the artifact.
func TestEnsureSnapshotAvailableImportsWhenTargetWorkerDiffers(t *testing.T) {
	var imports atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		require.Equal(t, http.MethodPut, request.Method)
		require.True(t, strings.HasSuffix(request.URL.Path, "/import"))
		imports.Add(1)
		payload, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		assert.Equal(t, []byte("snapshot-archive"), payload)
		writeJSON(writer, http.StatusOK, msb.SnapshotTransferMetadata{SnapshotID: "msbs_golden", Digest: "digest-1"})
	}))
	defer worker.Close()

	controller := New(&controllerTestStore{}, Config{
		SnapshotStore:    &memorySnapshotStore{payload: []byte("snapshot-archive")},
		AllowInsecureDev: true,
	})

	require.NoError(t, controller.ensureSnapshotAvailable(context.Background(), Placement{
		SandboxID: "msb_a", LocalID: "msb_a", WorkerID: "worker-b",
		WorkerURL: worker.URL, Generation: 1,
		SnapshotLocalID: "msbs_golden", SnapshotWorkerID: "worker-a",
		SnapshotObjectURI: "gs://bucket/golden.tar", SnapshotDigest: "digest-1",
	}))
	assert.Equal(t, int32(1), imports.Load(), "relocation onto another worker must import from durable storage")
}

// Regression guard for the load-bearing non-empty check on SnapshotWorkerID:
// ClaimRecovery hydrates SnapshotLocalID/ObjectURI/Digest from the recovery
// checkpoint but deliberately leaves SnapshotWorkerID empty. If the
// short-circuit ignored that, recovery onto a fresh worker would skip the
// import and boot a VM whose snapshot is not on the node.
func TestEnsureSnapshotAvailableStillImportsWhenSnapshotWorkerIsUnknown(t *testing.T) {
	var imports atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		imports.Add(1)
		writeJSON(writer, http.StatusOK, msb.SnapshotTransferMetadata{SnapshotID: "msbs_recovery", Digest: "digest-1"})
	}))
	defer worker.Close()

	controller := New(&controllerTestStore{}, Config{
		SnapshotStore:    &memorySnapshotStore{payload: []byte("snapshot-archive")},
		AllowInsecureDev: true,
	})

	require.NoError(t, controller.ensureSnapshotAvailable(context.Background(), Placement{
		SandboxID: "msb_a", LocalID: "msb_a", WorkerID: "worker-b",
		WorkerURL: worker.URL, Generation: 1,
		SnapshotLocalID: "msbs_recovery", SnapshotWorkerID: "",
		SnapshotObjectURI: "gs://bucket/recovery.tar", SnapshotDigest: "digest-1",
	}))
	assert.Equal(t, int32(1), imports.Load(),
		"an unknown snapshot worker (the recovery path) must never short-circuit the import")
}

// A snapshot with no durable export that is NOT on the target worker is
// genuinely unusable and must still fail rather than silently boot.
func TestEnsureSnapshotAvailableFailsWithoutExportOnForeignWorker(t *testing.T) {
	controller := New(&controllerTestStore{}, Config{AllowInsecureDev: true})
	err := controller.ensureSnapshotAvailable(context.Background(), Placement{
		WorkerID: "worker-b", SnapshotLocalID: "msbs_local", SnapshotWorkerID: "worker-a",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no durable export")
}

// checkpointTestStore is the minimal Store surface a drain checkpoint touches.
type checkpointTestStore struct {
	Store
	workerURL string
	states    []string
}

func (s *checkpointTestStore) CreateSnapshot(_ context.Context, snapshotID, sourceID, localID string, _ bool) (SnapshotPlacement, error) {
	return SnapshotPlacement{
		SnapshotID: snapshotID, LocalID: localID, SourceID: sourceID,
		WorkerID: "worker-a", WorkerURL: s.workerURL, Generation: 1,
	}, nil
}

func (s *checkpointTestStore) SetSnapshotState(_ context.Context, _ string, state, _, _ string, _ *int64) error {
	s.states = append(s.states, state)
	return nil
}

// TestDrainCheckpointIsBoundedSoAWedgedExportCannotStarveReconcile proves the
// export is time-bounded. Before the fix checkpointStoppedVM inherited the bare
// reconcile-loop context, which has no deadline at all, so a single wedged
// upload blocked the strictly-serial reconcile loop indefinitely — the
// starvation that pushed workspace provisioning past 240s during the outage.
func TestDrainCheckpointIsBoundedSoAWedgedExportCannotStarveReconcile(t *testing.T) {
	released := make(chan struct{})
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/snapshot") {
			writeJSON(writer, http.StatusCreated, sandbox.SnapshotResult{SnapshotID: "msbs_cp"})
			return
		}
		// The export hangs exactly like a wedged upload: it never responds and
		// only unblocks when the caller's context is canceled.
		<-request.Context().Done()
		close(released)
	}))
	defer worker.Close()

	previous := drainCheckpointTimeout
	drainCheckpointTimeout = 150 * time.Millisecond
	defer func() { drainCheckpointTimeout = previous }()

	store := &checkpointTestStore{workerURL: worker.URL}
	controller := New(store, Config{SnapshotStore: &memorySnapshotStore{}, AllowInsecureDev: true})

	done := make(chan error, 1)
	start := time.Now()
	go func() {
		done <- controller.checkpointStoppedVM(context.Background(), Placement{
			SandboxID: "msb_ws", LocalID: "msb_ws", WorkerID: "worker-a",
			WorkerURL: worker.URL, Generation: 1, Persistent: true,
		})
	}()

	select {
	case err := <-done:
		require.Error(t, err, "a wedged export must fail the checkpoint, not hang forever")
		assert.Less(t, time.Since(start), 10*time.Second, "the checkpoint must be bounded by drainCheckpointTimeout")
	case <-time.After(10 * time.Second):
		t.Fatal("checkpointStoppedVM never returned: a wedged export still starves the reconcile loop")
	}

	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatal("the in-flight export request was never canceled")
	}
	assert.Contains(t, store.states, "failed", "a timed-out export must park the snapshot row, not leak it as exporting")
}

// drainBudgetTestStore lets the drain phase run while every other reconcile
// phase is a no-op.
type drainBudgetTestStore struct {
	Store
	drainClaims atomic.Int32
}

func (s *drainBudgetTestStore) Reconcile(context.Context, time.Time) (ReconcileResult, error) {
	return ReconcileResult{}, nil
}
func (s *drainBudgetTestStore) ClaimCleanup(context.Context, string, time.Duration) (Placement, error) {
	return Placement{}, ErrNotFound
}
func (s *drainBudgetTestStore) ClaimSnapshotCleanup(context.Context, string, time.Duration, time.Duration) (SnapshotPlacement, error) {
	return SnapshotPlacement{}, ErrNotFound
}
func (s *drainBudgetTestStore) ClaimRestart(context.Context, string, time.Duration) (Placement, error) {
	return Placement{}, ErrNotFound
}
func (s *drainBudgetTestStore) ClaimRecovery(context.Context, string, time.Duration) (RecoveryClaim, error) {
	return RecoveryClaim{}, ErrNotFound
}
func (s *drainBudgetTestStore) ClaimDrain(context.Context, string, time.Duration) (DrainClaim, error) {
	s.drainClaims.Add(1)
	return DrainClaim{}, ErrNotFound
}

// The per-checkpoint bound alone still allows 10 x 3 minutes of drain work
// ahead of cleanup/restart/recovery. The phase budget stops the drain loop
// claiming more work once it is spent, so every later phase stays reachable
// within a single reconcile pass.
func TestDrainPhaseStopsClaimingOnceItsBudgetIsSpent(t *testing.T) {
	store := &drainBudgetTestStore{}
	controller := New(store, Config{AllowInsecureDev: true})

	base := time.Now()
	calls := 0
	controller.now = func() time.Time {
		calls++
		if calls == 1 {
			return base // establishes the deadline
		}
		return base.Add(drainPhaseBudget + time.Second) // budget already spent
	}

	result, err := controller.Reconcile(context.Background(), base)
	require.NoError(t, err)
	assert.Zero(t, store.drainClaims.Load(), "an exhausted drain budget must not claim more drains")
	assert.Equal(t, int64(1), result.DrainDeferred, "the skipped drain work must be reported, not silently dropped")
}

// With time available the drain loop behaves exactly as before.
func TestDrainPhaseStillDrainsWithinBudget(t *testing.T) {
	store := &drainBudgetTestStore{}
	controller := New(store, Config{AllowInsecureDev: true})
	_, err := controller.Reconcile(context.Background(), time.Now())
	require.NoError(t, err)
	assert.Equal(t, int32(1), store.drainClaims.Load(),
		"the budget must not suppress normal draining; the loop stops on ErrNotFound")
}
