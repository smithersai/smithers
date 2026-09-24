package worker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type refreshTestRuntime struct {
	Runtime
	states  map[string]sandbox.State
	missing map[string]bool
	fail    map[string]error
	listed  []string
	listErr error
	deleted []string
}

func (r *refreshTestRuntime) List(context.Context) ([]string, error) {
	if r.listErr != nil {
		return nil, r.listErr
	}
	if r.listed != nil {
		return append([]string(nil), r.listed...), nil
	}
	ids := make([]string, 0, len(r.states))
	for id := range r.states {
		ids = append(ids, id)
	}
	return ids, nil
}

func (r *refreshTestRuntime) Get(_ context.Context, id string) (sandbox.Sandbox, error) {
	if r.fail[id] != nil {
		return sandbox.Sandbox{}, r.fail[id]
	}
	if r.missing[id] {
		return sandbox.Sandbox{}, errors.New("sandbox not found")
	}
	return sandbox.Sandbox{ID: id, State: r.states[id]}, nil
}

func (r *refreshTestRuntime) Delete(_ context.Context, id string) error {
	r.deleted = append(r.deleted, id)
	if r.missing[id] {
		return errors.New("sandbox not found")
	}
	return nil
}

func TestStateRefreshUsesActualRuntimeAfterWorkerRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker-state.json")
	state, err := LoadState(path)
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_stopped", Allocation{Generation: 1, ObservedState: "running"}))
	require.NoError(t, state.Register("msb_missing", Allocation{Generation: 2, ObservedState: "running"}))

	// Reload the durable file to model a replacement worker pod.
	state, err = LoadState(path)
	require.NoError(t, err)
	runtime := &refreshTestRuntime{
		states:  map[string]sandbox.State{"msb_stopped": sandbox.StateStopped},
		missing: map[string]bool{"msb_missing": true},
	}
	require.NoError(t, state.RefreshRuntime(context.Background(), runtime))
	inventory := state.Inventory()
	require.Len(t, inventory, 1)
	assert.Equal(t, "msb_stopped", inventory[0].SandboxID)
	assert.Equal(t, "restart_pending", inventory[0].State)
	assert.Error(t, state.Check("msb_missing", 2))
}

func TestStateRefreshLeavesRuntimeIdleStopStoppedAfterStartup(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "worker-state.json"))
	require.NoError(t, err)
	// Consume the startup reconciliation before this placement is created.
	require.NoError(t, state.RefreshRuntime(context.Background(), &refreshTestRuntime{
		states: map[string]sandbox.State{}, missing: map[string]bool{},
	}))
	require.NoError(t, state.Register("msb_idle", Allocation{Generation: 1, ObservedState: "running"}))
	require.NoError(t, state.RefreshRuntime(context.Background(), &refreshTestRuntime{
		states: map[string]sandbox.State{"msb_idle": sandbox.StateStopped}, missing: map[string]bool{},
	}))
	inventory := state.Inventory()
	require.Len(t, inventory, 1)
	assert.Equal(t, "stopped", inventory[0].State)
}

func TestStateRefreshTracksStartupReconciliationPerSandbox(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker-state.json")
	state, err := LoadState(path)
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_flaky", Allocation{Generation: 1, ObservedState: "running"}))
	require.NoError(t, state.Register("msb_idle", Allocation{Generation: 1, ObservedState: "running"}))
	state, err = LoadState(path)
	require.NoError(t, err)

	first := &refreshTestRuntime{
		states: map[string]sandbox.State{"msb_idle": sandbox.StateRunning},
		fail:   map[string]error{"msb_flaky": errors.New("temporary runtime inspection failure")},
	}
	assert.Error(t, state.RefreshRuntime(context.Background(), first))
	second := &refreshTestRuntime{
		states: map[string]sandbox.State{"msb_idle": sandbox.StateStopped},
		fail:   map[string]error{"msb_flaky": errors.New("persistent runtime inspection failure")},
	}
	assert.Error(t, state.RefreshRuntime(context.Background(), second))

	states := map[string]string{}
	for _, item := range state.Inventory() {
		states[item.SandboxID] = item.State
	}
	assert.Equal(t, "stopped", states["msb_idle"], "an unrelated refresh failure must not keep a reconciled guest in startup mode")
	assert.Equal(t, "running", states["msb_flaky"])
}

func TestStateRefreshDoesNotDeleteAnInFlightCreate(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "worker-state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_starting", Allocation{Generation: 1}))
	runtime := &refreshTestRuntime{missing: map[string]bool{"msb_starting": true}}
	require.NoError(t, state.RefreshRuntime(context.Background(), runtime))
	assert.NoError(t, state.Check("msb_starting", 1))
	assert.Empty(t, runtime.deleted)
}

func TestStateRefreshDeletesInterruptedCreateAfterWorkerRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker-state.json")
	state, err := LoadState(path)
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_interrupted", Allocation{Generation: 1}))

	state, err = LoadState(path)
	require.NoError(t, err)
	runtime := &refreshTestRuntime{states: map[string]sandbox.State{
		"msb_interrupted": sandbox.StateRunning,
	}, missing: map[string]bool{}}
	require.NoError(t, state.RefreshRuntime(context.Background(), runtime))
	assert.Equal(t, []string{"msb_interrupted"}, runtime.deleted)
	assert.Error(t, state.Check("msb_interrupted", 1))
}

func TestStateRefreshDeletesRuntimeMissingFromDurableIndex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker-state.json")
	require.NoError(t, os.WriteFile(path, []byte("{}"), 0o600))
	state, err := LoadState(path)
	require.NoError(t, err)
	runtime := &refreshTestRuntime{listed: []string{"msb_unindexed"}}
	require.NoError(t, state.RefreshRuntime(context.Background(), runtime))
	assert.Equal(t, []string{"msb_unindexed"}, runtime.deleted)
	assert.Empty(t, state.Inventory())
}

// A missing index is not an empty one. A remounted or deleted state file must
// not turn the first refresh into a delete of every guest on the host; the
// refresh refuses and names the hazard so the worker can fence.
func TestStateRefreshRefusesToDeleteGuestsWhenIndexFileIsMissing(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "worker-state.json"))
	require.NoError(t, err)
	runtime := &refreshTestRuntime{listed: []string{"msb_persistent_a", "msb_persistent_b"}}
	err = state.RefreshRuntime(context.Background(), runtime)
	require.ErrorIs(t, err, ErrStateIndexMissing)
	assert.Contains(t, err.Error(), "2 runtime guests")
	assert.Empty(t, runtime.deleted)
	// The refusal holds for the life of this process, not just one tick.
	require.ErrorIs(t, state.RefreshRuntime(context.Background(), runtime), ErrStateIndexMissing)
	assert.Empty(t, runtime.deleted)
}

// A fresh node has no index and no guests: the first clean refresh proves the
// index complete, and later leaked guests are reclaimed as usual.
func TestStateRefreshTrustsMissingIndexOnceRuntimeWasEmpty(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "worker-state.json"))
	require.NoError(t, err)
	runtime := &refreshTestRuntime{listed: []string{}}
	require.NoError(t, state.RefreshRuntime(context.Background(), runtime))
	runtime.listed = []string{"msb_leaked"}
	require.NoError(t, state.RefreshRuntime(context.Background(), runtime))
	assert.Equal(t, []string{"msb_leaked"}, runtime.deleted)
}

func TestStateRefreshSkipsBusySandboxWithoutStarvingHeartbeat(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "worker-state.json"))
	require.NoError(t, err)
	require.NoError(t, state.Register("msb_busy", Allocation{Generation: 1, ObservedState: "running"}))
	unlock := state.Lock("msb_busy")
	runtime := &refreshTestRuntime{
		listed: []string{"msb_busy"},
		states: map[string]sandbox.State{"msb_busy": sandbox.StateStopped},
	}
	done := make(chan error, 1)
	go func() { done <- state.RefreshRuntime(context.Background(), runtime) }()
	select {
	case refreshErr := <-done:
		require.NoError(t, refreshErr)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("runtime refresh blocked behind a guest mutation and would starve heartbeats")
	}
	unlock()
	assert.Equal(t, 0, state.mutations.count())
	allocation, err := state.Allocation("msb_busy", 1)
	require.NoError(t, err)
	assert.Equal(t, "running", allocation.ObservedState)
}

// The controller places against GREATEST(allocated, observed_allocated), so
// this reporter is the other half of the idle-suspend capacity leak: as long as
// the worker kept counting powered-off guests, releasing the controller-side
// reservation on suspend changed nothing — the observer re-asserted it on the
// very next heartbeat and an idle pool stayed 100% reserved.
func TestAllocatedExcludesStoppedGuestsSoSuspendActuallyFreesCapacity(t *testing.T) {
	state, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	capacity := msb.WorkerCapacity{
		CPUMillis: 1000, MemoryBytes: 512 * 1024 * 1024, DiskBytes: 10 * 1024 * 1024 * 1024, VMs: 1,
	}
	require.NoError(t, state.Register("msb_running", Allocation{
		Generation: 1, Capacity: capacity, ObservedState: string(sandbox.StateRunning),
	}))
	require.NoError(t, state.Register("msb_starting", Allocation{
		Generation: 1, Capacity: capacity, ObservedState: string(sandbox.StateStarting),
	}))
	require.NoError(t, state.Register("msb_idle", Allocation{
		Generation: 1, Capacity: capacity, ObservedState: string(sandbox.StateRunning),
	}))

	assert.Equal(t, int32(3), state.Allocated().VMs)

	require.NoError(t, state.SetObserved("msb_idle", 1, string(sandbox.StateStopped)))

	allocated := state.Allocated()
	assert.Equal(t, int32(2), allocated.VMs, "a powered-off guest reserves no vCPU and no guest memory")
	assert.Equal(t, int64(2000), allocated.CPUMillis)
	assert.Equal(t, int64(1024*1024*1024), allocated.MemoryBytes)
	assert.Equal(t, int64(30*1024*1024*1024), allocated.DiskBytes,
		"stopped guests retain physical root disks")
	// A stopped guest is still a placement the controller owns: it must keep
	// appearing in the inventory or the orphan quarantine would delete it.
	assert.Len(t, state.Inventory(), 3)
}
