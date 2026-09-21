package control

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type hostAllocation struct {
	CPUMillis   int64
	MemoryBytes int64
	DiskBytes   int64
	VMs         int32
}

const testRootDiskBytes = int64(2 * 1024 * 1024 * 1024)

func retainedDiskAllocation(count int64) hostAllocation {
	return hostAllocation{DiskBytes: count * testRootDiskBytes}
}

func readHostAllocation(t *testing.T, store *PGStore, workerID string) hostAllocation {
	t.Helper()
	var allocated hostAllocation
	require.NoError(t, store.pool.QueryRow(context.Background(), `
		SELECT allocated_cpu_millis, allocated_memory_bytes, allocated_disk_bytes, allocated_vms
		FROM sandbox_hosts WHERE id=$1`, workerID).Scan(
		&allocated.CPUMillis, &allocated.MemoryBytes, &allocated.DiskBytes, &allocated.VMs))
	return allocated
}

func readHostEffectiveCPU(t *testing.T, store *PGStore, workerID string) int64 {
	t.Helper()
	var effective int64
	require.NoError(t, store.pool.QueryRow(context.Background(), `
		SELECT `+effectiveAllocated("cpu_millis")+`
		FROM sandbox_hosts h`+observedReservationsJoin+`
		WHERE h.id=$1`, workerID).Scan(&effective))
	return effective
}

func reservationHeld(t *testing.T, store *PGStore, sandboxID string) bool {
	t.Helper()
	var held bool
	require.NoError(t, store.pool.QueryRow(context.Background(),
		`SELECT reservation_held FROM sandbox_instances WHERE id=$1`, sandboxID).Scan(&held))
	return held
}

func readInstanceState(t *testing.T, store *PGStore, sandboxID string) (desired, observed string) {
	t.Helper()
	require.NoError(t, store.pool.QueryRow(context.Background(), `
		SELECT desired_state, observed_state FROM sandbox_instances WHERE id=$1`, sandboxID).
		Scan(&desired, &observed))
	return desired, observed
}

// The whole point of the fix: a suspended VM stops counting against the worker,
// and resuming charges it again. Before this, Release-on-delete was the ONLY
// path that ever decremented allocated_*, so N lifetime VMs exhausted a worker
// even with every guest powered off.
func TestReservationReleaseOnSuspendAndReacquireOnResume(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-suspend", "https://worker-suspend.internal"))
	require.NoError(t, err)

	create := sandbox.CreateRequest{Image: "image@sha256:gateway"}
	placement, err := store.Allocate(ctx, "msb_gateway", create, msb.SanitizeCreateRequest(create),
		ResourceOwner{Kind: "repo_gateway", ID: "gateway-1"})
	require.NoError(t, err)

	charged := readHostAllocation(t, store, placement.WorkerID)
	assert.Equal(t, int64(1000), charged.CPUMillis)
	assert.Equal(t, int32(1), charged.VMs)
	assert.True(t, reservationHeld(t, store, "msb_gateway"))

	require.NoError(t, store.SetState(ctx, "msb_gateway", placement.Generation, "stopped", "stopped", ""))
	require.NoError(t, store.ReleaseReservation(ctx, "msb_gateway", placement.Generation))
	released := readHostAllocation(t, store, placement.WorkerID)
	assert.Equal(t, retainedDiskAllocation(1), released,
		"a suspended guest releases compute but retains its physical root disk")
	assert.False(t, reservationHeld(t, store, "msb_gateway"))

	// Idempotent: a retried suspend must not credit the pool twice.
	require.NoError(t, store.ReleaseReservation(ctx, "msb_gateway", placement.Generation))
	assert.Equal(t, retainedDiskAllocation(1), readHostAllocation(t, store, placement.WorkerID))

	acquired, err := store.AcquireReservation(ctx, "msb_gateway", placement.Generation)
	require.NoError(t, err)
	assert.True(t, acquired)
	assert.Equal(t, charged, readHostAllocation(t, store, placement.WorkerID))
	assert.True(t, reservationHeld(t, store, "msb_gateway"))
	desired, observed := readInstanceState(t, store, "msb_gateway")
	assert.Equal(t, "running", desired)
	assert.Equal(t, "starting", observed, "heartbeat release must not race an in-flight resume")

	// Idempotent the other way: a placement that already holds its reservation
	// reports acquired=false and leaves the counters alone.
	acquired, err = store.AcquireReservation(ctx, "msb_gateway", placement.Generation)
	require.NoError(t, err)
	assert.False(t, acquired)
	assert.Equal(t, charged, readHostAllocation(t, store, placement.WorkerID))
}

// A guest can become stopped before the one-minute heartbeat settle window has
// returned its reservation. Resume must still mark that held placement as
// starting, or a later heartbeat could release the slot while the worker is
// booting it.
func TestResumeMarksAStillHeldStoppedPlacementInFlight(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-held-resume", "https://worker-held-resume.internal"))
	require.NoError(t, err)
	create := sandbox.CreateRequest{Image: "image@sha256:gateway"}
	placement, err := store.Allocate(ctx, "msb_held", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, "msb_held", placement.Generation, "stopped", "stopped", ""))
	before := readHostAllocation(t, store, placement.WorkerID)
	assert.True(t, reservationHeld(t, store, "msb_held"))

	acquired, err := store.AcquireReservation(ctx, "msb_held", placement.Generation)
	require.NoError(t, err)
	assert.False(t, acquired, "the already-held debit must not be charged twice")
	assert.Equal(t, before, readHostAllocation(t, store, placement.WorkerID))
	desired, observed := readInstanceState(t, store, "msb_held")
	assert.Equal(t, "running", desired)
	assert.Equal(t, "starting", observed, "heartbeat release must see an in-flight resume")
}

// Resuming into a pool that filled up while the guest slept must fail with
// no_capacity and change nothing, leaving the guest suspended and resumable.
func TestReservationReacquireIntoAFullPoolFailsCleanly(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	// One VM of headroom: 2000 millis, two 1000-milli guests.
	heartbeat := heartbeatForTest("worker-full", "https://worker-full.internal")
	heartbeat.Capacity.CPUMillis = 2000
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	first, err := store.Allocate(ctx, "msb_one", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	_, err = store.Allocate(ctx, "msb_two", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)

	// msb_one idles out; its slot is genuinely returned to the pool...
	require.NoError(t, store.SetState(ctx, "msb_one", first.Generation, "stopped", "stopped", ""))
	require.NoError(t, store.ReleaseReservation(ctx, "msb_one", first.Generation))
	assert.Equal(t, int64(1000), readHostAllocation(t, store, "worker-full").CPUMillis)

	// ...and a third guest legitimately takes it.
	_, err = store.Allocate(ctx, "msb_three", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err, "released capacity is genuinely reusable")

	// Now msb_one wants to come back and there is nothing left.
	acquired, err := store.AcquireReservation(ctx, "msb_one", first.Generation)
	assert.ErrorIs(t, err, ErrNoCapacity)
	assert.False(t, acquired)
	assert.False(t, reservationHeld(t, store, "msb_one"), "the guest stays suspended, resumable later")
	assert.Equal(t, int64(2000), readHostAllocation(t, store, "worker-full").CPUMillis,
		"a refused resume must not overcommit the worker")
	desired, observed := readInstanceState(t, store, "msb_one")
	assert.Equal(t, "stopped", desired)
	assert.Equal(t, "stopped", observed, "failed admission must preserve the suspended state")

	// And it succeeds the moment a slot frees up.
	require.NoError(t, store.Release(ctx, "msb_three", 1))
	acquired, err = store.AcquireReservation(ctx, "msb_one", first.Generation)
	require.NoError(t, err)
	assert.True(t, acquired)
}

// Deleting an already-suspended instance must not decrement the host a second
// time: the suspend already gave the capacity back.
func TestDeleteAfterSuspendDoesNotDoubleCreditTheWorker(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-delete", "https://worker-delete.internal"))
	require.NoError(t, err)
	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_keep", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	_, err = store.Allocate(ctx, "msb_drop", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	assert.Equal(t, int64(2000), readHostAllocation(t, store, "worker-delete").CPUMillis)

	require.NoError(t, store.ReleaseReservation(ctx, "msb_drop", 1))
	require.NoError(t, store.Release(ctx, "msb_drop", 1))

	after := readHostAllocation(t, store, "worker-delete")
	assert.Equal(t, int64(1000), after.CPUMillis, "msb_keep still holds exactly one slot")
	assert.Equal(t, int32(1), after.VMs)
	assert.Equal(t, testRootDiskBytes, after.DiskBytes, "only the surviving guest's disk remains")
}

// suspend / resume / delete all mutate the same sandbox_hosts row. The
// accounting is transactional, so racing them may not drift the counters.
func TestReservationAccountingIsRaceSafe(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-race", "https://worker-race.internal"))
	require.NoError(t, err)
	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_race", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)

	var wait sync.WaitGroup
	for range 8 {
		wait.Add(2)
		go func() { defer wait.Done(); _ = store.ReleaseReservation(ctx, "msb_race", 1) }()
		go func() { defer wait.Done(); _, _ = store.AcquireReservation(ctx, "msb_race", 1) }()
	}
	wait.Wait()

	// Whatever order they landed in, the host counters must agree with the flag.
	allocated := readHostAllocation(t, store, "worker-race")
	if reservationHeld(t, store, "msb_race") {
		assert.Equal(t, hostAllocation{CPUMillis: 1000, MemoryBytes: 512 * 1024 * 1024,
			DiskBytes: testRootDiskBytes, VMs: 1}, allocated)
	} else {
		assert.Equal(t, retainedDiskAllocation(1), allocated)
	}

	// And a final delete converges on an empty worker either way.
	require.NoError(t, store.Release(ctx, "msb_race", 1))
	assert.Equal(t, hostAllocation{}, readHostAllocation(t, store, "worker-race"))
}

// The observer is the other half of the leak. Placement uses
// GREATEST(allocated, observed_allocated), so a worker that keeps reporting a
// stopped guest re-asserts the reservation the controller just released. The
// worker no longer counts stopped guests (worker.State.Allocated), and this
// pins the controller-side consequence: a heartbeat carrying the reduced
// observed figure leaves the released slot genuinely available.
func TestReleasedCapacityIsNotResurrectedByTheObservedReporter(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	heartbeat := heartbeatForTest("worker-observed", "https://worker-observed.internal")
	heartbeat.Capacity.CPUMillis = 1000
	heartbeat.Capabilities = map[string]bool{msb.WorkerCapabilityAllocationExcludesStoppedCompute: true}
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_observed", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)

	// The guest is running: the worker reports it, and the pool is full.
	heartbeat.Allocated = msb.WorkerCapacity{
		CPUMillis: 1000, MemoryBytes: 512 * 1024 * 1024, DiskBytes: 10 * 1024 * 1024 * 1024, VMs: 1,
	}
	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_observed", Generation: 1, State: "running"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	_, err = store.Allocate(ctx, "msb_blocked", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	assert.ErrorIs(t, err, ErrNoCapacity)

	// It idles out. The controller releases, and the fixed worker stops
	// counting it in observed_allocated.
	require.NoError(t, store.ReleaseReservation(ctx, "msb_observed", 1))
	heartbeat.Allocated = msb.WorkerCapacity{}
	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_observed", Generation: 1, State: "stopped"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	_, err = store.Allocate(ctx, "msb_admitted", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err, "the released slot must be genuinely reusable")
}

// The controller must be authoritative about released reservations even when
// the worker has NOT been redeployed and keeps reporting its powered-off guests
// in observed_allocated. Without the discount, GREATEST(allocated, observed)
// re-asserts every released slot and the whole fix is a silent no-op — and the
// worker lives in a cluster that is not reachable from an operator machine, so
// this is the realistic deploy order, not a hypothetical.
func TestReleasedCapacityIsUsableEvenWhenTheWorkerStillReportsStoppedGuests(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	heartbeat := heartbeatForTest("worker-stale", "https://worker-stale.internal")
	heartbeat.Capacity.CPUMillis = 2000
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	for _, id := range []string{"msb_a", "msb_b"} {
		_, err = store.Allocate(ctx, id, create, msb.SanitizeCreateRequest(create), ResourceOwner{})
		require.NoError(t, err)
	}

	// An OLD worker: both guests idled out, and it still counts both.
	heartbeat.Allocated = msb.WorkerCapacity{
		CPUMillis: 2000, MemoryBytes: 1024 * 1024 * 1024, DiskBytes: 20 * 1024 * 1024 * 1024, VMs: 2,
	}
	heartbeat.Inventory = []msb.WorkerInventoryItem{
		{SandboxID: "msb_a", Generation: 1, State: "stopped"},
		{SandboxID: "msb_b", Generation: 1, State: "stopped"},
	}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	require.NoError(t, store.ReleaseReservation(ctx, "msb_a", 1))
	require.NoError(t, store.ReleaseReservation(ctx, "msb_b", 1))

	assert.Equal(t, retainedDiskAllocation(2), readHostAllocation(t, store, "worker-stale"))
	_, err = store.Allocate(ctx, "msb_new", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err, "a stale observer must not resurrect a released reservation")

	// The discount only lowers the safety net to the truth; it does not let the
	// pool be oversubscribed. One slot is now genuinely taken.
	_, err = store.Allocate(ctx, "msb_new_two", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	_, err = store.Allocate(ctx, "msb_over", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	assert.ErrorIs(t, err, ErrNoCapacity, "two 1000-milli guests fill a 2000-milli worker")
}

// A guest the controller knows nothing about must still be protected by the
// observed safety net: the discount only ever covers placements the controller
// itself released.
func TestObservedSafetyNetStillCoversGuestsTheControllerDoesNotKnowAbout(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	heartbeat := heartbeatForTest("worker-unknown", "https://worker-unknown.internal")
	heartbeat.Capacity.CPUMillis = 1000
	heartbeat.Allocated = msb.WorkerCapacity{
		CPUMillis: 1000, MemoryBytes: 512 * 1024 * 1024, DiskBytes: 10 * 1024 * 1024 * 1024, VMs: 1,
	}
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	assert.Equal(t, int64(1000), readHostEffectiveCPU(t, store, "worker-unknown"))

	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_denied", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	assert.ErrorIs(t, err, ErrNoCapacity)
}

// A new worker already excludes stopped guests from Allocated. Subtracting the
// released set a second time would erase an unrelated unknown running guest
// from the safety net and permit overcommit during a rolling deploy.
func TestNewWorkerSafetyNetPreservesUnknownGuestAlongsideReleasedPlacement(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	heartbeat := heartbeatForTest("worker-mixed", "https://worker-mixed.internal")
	heartbeat.Capacity.CPUMillis = 2000
	heartbeat.Capabilities = map[string]bool{msb.WorkerCapabilityAllocationExcludesStoppedCompute: true}
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_known", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.ReleaseReservation(ctx, "msb_known", 1))

	// The new worker omits msb_known because it is stopped, but reports one
	// running guest that has no controller placement row.
	heartbeat.Allocated = msb.WorkerCapacity{
		CPUMillis: 1000, MemoryBytes: 512 * 1024 * 1024,
		// Both the known stopped guest and unknown running guest retain disks.
		DiskBytes: 2 * testRootDiskBytes, VMs: 1,
	}
	heartbeat.Inventory = []msb.WorkerInventoryItem{
		{SandboxID: "msb_known", Generation: 1, State: "stopped"},
		{SandboxID: "msb_unknown", Generation: 1, State: "running"},
	}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	_, err = store.Allocate(ctx, "msb_one_free_slot", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	_, err = store.Allocate(ctx, "msb_would_overcommit", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	assert.ErrorIs(t, err, ErrNoCapacity, "the unknown running guest must remain in the observed safety net")
}

// Microsandbox suspends guests on its own idle timer, so the common case never
// reaches the controller's stop/suspend routes at all — the only signal is the
// guest turning up 'stopped' in the heartbeat inventory. That is precisely how
// the production worker wedged at 7000/7000 with every guest asleep.
func TestHeartbeatReleasesReservationsForWorkerSideIdleSuspend(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	heartbeat := heartbeatForTest("worker-idle", "https://worker-idle.internal")
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)
	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	_, err = store.Allocate(ctx, "msb_idle", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	require.Equal(t, int64(1000), readHostAllocation(t, store, "worker-idle").CPUMillis)

	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_idle", Generation: 1, State: "running"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	heartbeat.Inventory = []msb.WorkerInventoryItem{{SandboxID: "msb_idle", Generation: 1, State: "stopped"}}
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	// The settle guard holds the release back while the transition is fresh, so
	// an in-flight resume can never be robbed of the slot it just took.
	assert.True(t, reservationHeld(t, store, "msb_idle"))
	assert.Equal(t, int64(1000), readHostAllocation(t, store, "worker-idle").CPUMillis)

	_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET updated_at=now()-interval '5 minutes' WHERE id='msb_idle'`)
	require.NoError(t, err)
	_, err = store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	assert.False(t, reservationHeld(t, store, "msb_idle"))
	assert.Equal(t, retainedDiskAllocation(1), readHostAllocation(t, store, "worker-idle"),
		"an idle-suspended guest releases compute but not its retained disk")
}

// A stopped persistent guest still owns its root disk. Compute is reusable,
// but a fresh VM may not consume those same physical bytes; resuming the owner
// needs no second disk charge and must still succeed.
func TestSuspendRetainsDiskHeadroomWithoutDoubleChargingResume(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	heartbeat := heartbeatForTest("worker-disk", "https://worker-disk.internal")
	heartbeat.Capacity.CPUMillis = 2000
	heartbeat.Capacity.DiskBytes = testRootDiskBytes
	_, err := store.Heartbeat(ctx, heartbeat)
	require.NoError(t, err)

	create := sandbox.CreateRequest{Image: "image@sha256:one"}
	placement, err := store.Allocate(ctx, "msb_disk_owner", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	require.NoError(t, err)
	require.NoError(t, store.SetState(ctx, placement.SandboxID, placement.Generation, "stopped", "stopped", ""))
	require.NoError(t, store.ReleaseReservation(ctx, placement.SandboxID, placement.Generation))

	_, err = store.Allocate(ctx, "msb_disk_overcommit", create, msb.SanitizeCreateRequest(create), ResourceOwner{})
	assert.ErrorIs(t, err, ErrNoCapacity, "retained disk must remain in fresh-placement admission")

	acquired, err := store.AcquireReservation(ctx, placement.SandboxID, placement.Generation)
	require.NoError(t, err, "resume reuses its retained disk rather than charging it twice")
	assert.True(t, acquired)
	assert.Equal(t, hostAllocation{CPUMillis: 1000, MemoryBytes: 512 * 1024 * 1024,
		DiskBytes: testRootDiskBytes, VMs: 1}, readHostAllocation(t, store, "worker-disk"))
}

// Regression (2026-08-10 prod): the release and recovery-rehome host updates
// subtract the placement's reservation inside CASE WHEN $5 THEN $n ELSE 0 END.
// PostgreSQL resolves the unknown parameter against the untyped integer
// literal 0, so the driver is told the parameter is int4 — and a guest whose
// memory request exceeds math.MaxInt32 bytes (any MemSizeMB > 2047, exactly
// what the 2 GiB gateway sizing introduced) can no longer be encoded:
// "unable to encode 2147483648 into binary format for int4". Every delete of
// such a guest failed, its placement wedged in desired=deleted, and the
// reconcile pass aborted on the same error every cycle — recovery starved and
// the leaked reservation shrank the pool. The ELSE literal is now 0::bigint.
func TestReleaseAndRehomeHandleMemoryAboveInt4(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	store := NewPGStore(pool)

	_, err := store.Heartbeat(ctx, heartbeatForTest("worker-wide-a", "https://worker-wide-a.internal"))
	require.NoError(t, err)
	_, err = store.Heartbeat(ctx, heartbeatForTest("worker-wide-b", "https://worker-wide-b.internal"))
	require.NoError(t, err)

	mem := int32(2048)
	create := sandbox.CreateRequest{
		Image:       "image@sha256:gateway",
		Persistence: &sandbox.PersistencePolicy{Type: sandbox.PersistencePersistent},
		MemSizeMB:   &mem,
	}
	placement, err := store.Allocate(ctx, "msb_wide_gateway", create, msb.SanitizeCreateRequest(create),
		ResourceOwner{Kind: "repo_gateway", ID: "gateway-wide"})
	require.NoError(t, err)
	require.Equal(t, int64(2048)*1024*1024, placement.Requested.MemoryBytes)
	require.NoError(t, store.SetState(ctx, "msb_wide_gateway", placement.Generation, "running", "running", ""))

	// The delete-time release is the path prod wedge proved: cleanup claims the
	// row, the worker delete completes, and Release must retire the row and
	// hand the reservation back.
	require.NoError(t, store.BeginDelete(ctx, "msb_wide_gateway", placement.Generation))
	require.NoError(t, store.Release(ctx, "msb_wide_gateway", placement.Generation))
	assert.Equal(t, hostAllocation{}, readHostAllocation(t, store, placement.WorkerID),
		"a deleted 2 GiB guest returns its full reservation to the worker")

	// The recovery re-home carries the same CASE expression when it releases
	// the lost worker's held reservation.
	rehomeCreate := create
	rehome, err := store.Allocate(ctx, "msb_wide_rehome", rehomeCreate, msb.SanitizeCreateRequest(rehomeCreate),
		ResourceOwner{Kind: "repo_gateway", ID: "gateway-rehome"})
	require.NoError(t, err)
	lostWorker := rehome.WorkerID
	require.NoError(t, store.SetState(ctx, "msb_wide_rehome", rehome.Generation, "running", "running", ""))
	_, err = store.CreateSnapshot(ctx, "msbs_wide_rehome", "msb_wide_rehome", "msb_wide_rehome-local", true)
	require.NoError(t, err)
	require.NoError(t, store.SetSnapshotState(ctx, "msbs_wide_rehome", "exported", "gs://bucket/wide", "digest", nil))
	_, err = store.SetRecoverySnapshot(ctx, "msb_wide_rehome", rehome.Generation, "msbs_wide_rehome")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET state='stale' WHERE id=$1`, lostWorker)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE sandbox_instances SET observed_state='degraded', recovery_reason='worker_lost' WHERE id=$1`,
		"msb_wide_rehome")
	require.NoError(t, err)
	claim, err := store.ClaimRecovery(ctx, "controller-test", 0)
	require.NoError(t, err)
	assert.NotEqual(t, lostWorker, claim.Placement.WorkerID)
	assert.Equal(t, hostAllocation{}, readHostAllocation(t, store, lostWorker),
		"the re-home release must clear the lost worker's 2 GiB reservation")
}
