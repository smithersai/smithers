package control

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestRequestedCapacityUsesKindSpecificWritableDisk(t *testing.T) {
	assert.EqualValues(t, 2*1024*1024*1024, requestedCapacity(sandbox.CreateRequest{Kind: "container"}).DiskBytes)
	assert.EqualValues(t, 4*1024*1024*1024, requestedCapacity(sandbox.CreateRequest{Kind: "vm"}).DiskBytes)
	assert.EqualValues(t, 8*1024*1024*1024, requestedCapacity(sandbox.CreateRequest{Kind: "desktop"}).DiskBytes)
	explicit := int64(12 * 1024)
	assert.EqualValues(t, 12*1024*1024*1024, requestedCapacity(sandbox.CreateRequest{Kind: "desktop", RootfsSizeMB: &explicit}).DiskBytes)
}

// Suspending or stopping a guest must hand its worker reservation back. Before
// this the reservation was only ever released by delete, so the 30-minute idle
// timeout turned every gateway/workspace VM into a permanent capacity debit and
// seven lifetime VMs exhausted the single production worker with every guest
// asleep.
func TestStopAndSuspendReleaseTheWorkerReservation(t *testing.T) {
	for _, testCase := range []struct{ name, key, path string }{
		{name: "stop", key: "release-on-stop", path: "/v1/sandboxes/msb_idle/stop"},
		{name: "suspend", key: "release-on-suspend", path: "/v1/sandboxes/msb_idle/suspend"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writeJSON(writer, http.StatusOK, sandbox.StopResult{SandboxID: "msb_idle"})
			}))
			defer worker.Close()
			store := &controllerTestStore{workerURL: worker.URL, placement: &Placement{
				WorkerID: "worker-a", Generation: 4,
				DesiredState: "running", ObservedState: "running",
			}}
			controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

			response := controllerRequest(t, controller, http.MethodPost, testCase.path, testCase.key, "")

			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			assert.True(t, store.reservationReleased, "a powered-off guest must not keep holding a pool slot")
			assert.Equal(t, 1, store.reservationReleases)
		})
	}
}

func TestAlreadyStoppedRequestRepairsAStillHeldReservation(t *testing.T) {
	store := &controllerTestStore{placement: &Placement{
		WorkerID: "worker-a", Generation: 4,
		DesiredState: "stopped", ObservedState: "stopped",
	}}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

	response := controllerRequest(t, controller, http.MethodPost,
		"/v1/sandboxes/msb_idle/suspend", "repair-held-reservation", "")

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.True(t, store.reservationReleased)
	assert.Equal(t, 1, store.reservationReleases)
}

// A checkpoint failure marks the placement degraded but does not bring the
// guest back up, so the slot must still be returned: the release runs before
// the checkpoint precisely so this path cannot leak.
func TestStopReleasesTheReservationEvenWhenTheCheckpointFails(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, sandbox.StopResult{SandboxID: "msb_idle"})
	}))
	defer worker.Close()
	// Persistent placement with no SnapshotStore: checkpointStoppedVM fails closed.
	store := &controllerTestStore{workerURL: worker.URL, placement: &Placement{
		WorkerID: "worker-a", Generation: 4, Persistent: true,
		DesiredState: "running", ObservedState: "running",
	}}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_idle/stop", "checkpoint-fails", "")

	require.NotEqual(t, http.StatusOK, response.Code)
	assert.True(t, store.reservationReleased)
}

// Resuming re-charges the reservation before any worker RPC.
func TestStartReacquiresTheWorkerReservationBeforeBootingTheGuest(t *testing.T) {
	var started bool
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		started = true
		writeJSON(writer, http.StatusOK, sandbox.StartResult{ID: "msb_idle"})
	}))
	defer worker.Close()
	store := &controllerTestStore{workerURL: worker.URL, reservationReleased: true, placement: &Placement{
		WorkerID: "worker-a", Generation: 4,
		DesiredState: "stopped", ObservedState: "stopped",
	}}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_idle/start", "resume-one", "{}")

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.True(t, started)
	assert.False(t, store.reservationReleased, "a running guest holds its reservation again")
	assert.Equal(t, 1, store.reservationAcquires)
}

// Resuming into a pool that filled up while the guest slept must fail cleanly
// with no_capacity and leave the guest suspended and resumable later — never a
// half-started guest on an overcommitted worker.
func TestStartIntoAFullPoolFailsWithNoCapacityAndNeverTouchesTheWorker(t *testing.T) {
	var workerCalls int
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		workerCalls++
		writeJSON(writer, http.StatusOK, sandbox.StartResult{ID: "msb_idle"})
	}))
	defer worker.Close()
	store := &controllerTestStore{
		workerURL: worker.URL, reservationReleased: true, acquireReservationError: ErrNoCapacity,
		placement: &Placement{WorkerID: "worker-a", Generation: 4, DesiredState: "stopped", ObservedState: "stopped"},
	}
	controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

	response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_idle/start", "resume-full", "{}")

	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.Contains(t, response.Body.String(), "no_capacity")
	assert.Zero(t, workerCalls, "a refused resume must not boot the guest")
	assert.True(t, store.reservationReleased, "the guest stays suspended, resumable later")
	assert.Zero(t, store.setStateCalls, "no_capacity must preserve the stopped placement state")
}

// A resume that took the reservation and then failed to boot must give exactly
// that reservation back — and a failed start against a guest that never lost
// its reservation must not drop one it is still using.
func TestFailedStartOnlyReleasesAReservationItActuallyTook(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "boom", http.StatusInternalServerError)
	}))
	defer worker.Close()

	t.Run("suspended guest", func(t *testing.T) {
		store := &controllerTestStore{workerURL: worker.URL, reservationReleased: true, placement: &Placement{
			WorkerID: "worker-a", Generation: 4, DesiredState: "stopped", ObservedState: "stopped",
		}}
		controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

		response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_idle/start", "resume-fail", "{}")

		assert.NotEqual(t, http.StatusOK, response.Code)
		assert.Equal(t, 1, store.reservationAcquires)
		assert.Equal(t, 1, store.reservationReleases)
		assert.True(t, store.reservationReleased, "the failed resume gave the slot straight back")
	})

	t.Run("guest that still holds its reservation", func(t *testing.T) {
		store := &controllerTestStore{workerURL: worker.URL, placement: &Placement{
			WorkerID: "worker-a", Generation: 4, DesiredState: "running", ObservedState: "running",
		}}
		controller := New(store, Config{APIKey: "api-key", AllowInsecureDev: true})

		response := controllerRequest(t, controller, http.MethodPost, "/v1/sandboxes/msb_idle/start", "restart-fail", "{}")

		assert.NotEqual(t, http.StatusOK, response.Code)
		assert.Zero(t, store.reservationReleases, "a live guest must keep its reservation")
		assert.False(t, store.reservationReleased)
	})
}
