package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type Allocation struct {
	Generation        int64              `json:"generation"`
	Capacity          msb.WorkerCapacity `json:"capacity"`
	ObservedState     string             `json:"observed_state"`
	BootstrapComplete bool               `json:"bootstrap_complete"`
	CreatorBootID     string             `json:"creator_boot_id"`
	UpdatedAt         time.Time          `json:"updated_at"`
}

type State struct {
	path           string
	mu             sync.RWMutex
	allocations    map[string]Allocation
	startupPending map[string]struct{}
	mutations      keyedMutex
	bootID         string
	// indexUnverified is set when the state file was absent at load. An
	// absent index is not proof of an empty host, so unindexed guests are
	// not deleted until a refresh sees a runtime with none.
	indexUnverified bool
}

// ErrStateIndexMissing refuses to delete unindexed guests when the worker
// state file was absent at load: a remounted or removed index would otherwise
// make the first refresh delete every guest on the host. The worker should
// fence and page an operator; writing an empty index confirms the deletion.
var ErrStateIndexMissing = errors.New("worker state index is missing")

func LoadState(path string) (*State, error) {
	state := &State{
		path: path, allocations: map[string]Allocation{},
		startupPending: map[string]struct{}{}, bootID: uuid.NewString(),
	}
	payload, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		state.indexUnverified = true
		return state, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read worker state: %w", err)
	}
	if err := json.Unmarshal(payload, &state.allocations); err != nil {
		return nil, fmt.Errorf("decode worker state: %w", err)
	}
	// State files written before bootstrap fencing did not carry the explicit
	// marker. Those versions only persisted non-starting states after bootstrap
	// completed, so migrate them in place without destroying healthy guests.
	migrated := false
	for id, allocation := range state.allocations {
		if !allocation.BootstrapComplete && allocation.ObservedState != "" &&
			allocation.ObservedState != string(sandbox.StateStarting) {
			allocation.BootstrapComplete = true
			state.allocations[id] = allocation
			migrated = true
		}
	}
	if migrated {
		if err := state.persistLocked(); err != nil {
			return nil, fmt.Errorf("migrate worker state: %w", err)
		}
	}
	for id, allocation := range state.allocations {
		if allocation.BootstrapComplete && allocation.ObservedState == string(sandbox.StateRunning) {
			state.startupPending[id] = struct{}{}
		}
	}
	return state, nil
}

func (s *State) Register(id string, allocation Allocation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.allocations[id]; ok && current.Generation > allocation.Generation {
		return fmt.Errorf("stale placement generation: have %d, got %d", current.Generation, allocation.Generation)
	}
	if allocation.ObservedState == "" {
		allocation.ObservedState = string(sandbox.StateStarting)
	}
	if allocation.ObservedState != string(sandbox.StateStarting) {
		allocation.BootstrapComplete = true
	}
	allocation.CreatorBootID = s.bootID
	allocation.UpdatedAt = time.Now().UTC()
	s.allocations[id] = allocation
	delete(s.startupPending, id)
	return s.persistLocked()
}

func (s *State) SetObserved(id string, generation int64, observed string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	allocation, ok := s.allocations[id]
	if !ok {
		return os.ErrNotExist
	}
	if allocation.Generation != generation {
		return fmt.Errorf("stale placement generation: have %d, got %d", allocation.Generation, generation)
	}
	allocation.ObservedState = observed
	if observed == string(sandbox.StateRunning) {
		allocation.BootstrapComplete = true
	}
	allocation.UpdatedAt = time.Now().UTC()
	s.allocations[id] = allocation
	return s.persistLocked()
}

func (s *State) Check(id string, generation int64) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	allocation, ok := s.allocations[id]
	if !ok {
		return os.ErrNotExist
	}
	if allocation.Generation != generation {
		return fmt.Errorf("stale placement generation: have %d, got %d", allocation.Generation, generation)
	}
	return nil
}

func (s *State) Allocation(id string, generation int64) (Allocation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	allocation, ok := s.allocations[id]
	if !ok {
		return Allocation{}, os.ErrNotExist
	}
	if allocation.Generation != generation {
		return Allocation{}, fmt.Errorf("stale placement generation: have %d, got %d", allocation.Generation, generation)
	}
	return allocation, nil
}

func (s *State) CurrentAllocation(id string) (Allocation, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	allocation, ok := s.allocations[id]
	return allocation, ok
}

func (s *State) Remove(id string, generation int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	allocation, ok := s.allocations[id]
	if !ok {
		return nil
	}
	if allocation.Generation != generation {
		return fmt.Errorf("stale placement generation: have %d, got %d", allocation.Generation, generation)
	}
	delete(s.allocations, id)
	delete(s.startupPending, id)
	return s.persistLocked()
}

// Lock serializes every runtime mutation and runtime/state reconciliation for
// one provider-local sandbox ID. Server requests and the heartbeat refresh
// must share this lock: separate lock maps allow a stale refresh snapshot to
// delete a guest that a concurrent create just finished replacing.
func (s *State) Lock(id string) func() {
	return s.mutations.Lock(id)
}

// TryLock is used only by best-effort heartbeat reconciliation. A long guest
// operation must never block the next worker heartbeat and expire the host's
// authorization lease; a busy sandbox is safely reported from persisted state
// and inspected on a later pass.
func (s *State) TryLock(id string) (func(), bool) {
	return s.mutations.TryLock(id)
}

// Allocated is the observed half of the controller's admission rule, which
// places against GREATEST(allocated, observed_allocated) per resource. A guest
// the worker has powered off holds no vCPU and no guest memory, so counting it
// here would re-assert the very reservation the controller just released on
// suspend and leave an idle pool permanently full — the observer would silently
// undo the fix. Retained (stopped) guests are therefore excluded from compute
// and active-VM totals, while their physical disk bytes remain observed.
// Resuming re-charges compute through AcquireReservation, which fails cleanly
// when the pool filled up meanwhile.
func (s *State) Allocated() msb.WorkerCapacity {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var allocated msb.WorkerCapacity
	for _, allocation := range s.allocations {
		if allocation.ObservedState == string(sandbox.StateStopped) {
			// Stop retains the root disk. Keep reporting those bytes so physical
			// storage headroom cannot be reused while the guest is asleep.
			allocated.DiskBytes += allocation.Capacity.DiskBytes
			continue
		}
		allocated.CPUMillis += allocation.Capacity.CPUMillis
		allocated.MemoryBytes += allocation.Capacity.MemoryBytes
		allocated.DiskBytes += allocation.Capacity.DiskBytes
		allocated.VMs++
	}
	return allocated
}

func (s *State) Inventory() []msb.WorkerInventoryItem {
	s.mu.RLock()
	defer s.mu.RUnlock()
	inventory := make([]msb.WorkerInventoryItem, 0, len(s.allocations))
	for id, allocation := range s.allocations {
		inventory = append(inventory, msb.WorkerInventoryItem{
			SandboxID: id, Generation: allocation.Generation, State: allocation.ObservedState,
		})
	}
	return inventory
}

// RefreshRuntime prevents a durable worker-state file from claiming that a
// guest is running after the worker process (and its child VMM) restarted.
// New creates are left alone during their bounded controller operation lease;
// all older placements are checked against the actual Microsandbox runtime.
func (s *State) RefreshRuntime(ctx context.Context, runtime Runtime) error {
	s.mu.RLock()
	allocations := make(map[string]Allocation, len(s.allocations))
	for id, allocation := range s.allocations {
		allocations[id] = allocation
	}
	s.mu.RUnlock()

	var refreshErrors []error
	// The state file is an index, not the source of truth for processes on the
	// host. Enumerate the runtime first so a lost/corrupt index cannot leave live
	// microVMs permanently invisible. Unknown guests cannot be safely adopted
	// because bootstrap completion and capacity accounting are unprovable; fence
	// them by deletion so persistent placements recover from their checkpoint and
	// ephemeral placements converge through normal missing-runtime handling.
	// An index file that was absent at load is the exception: it proves
	// nothing, so deletion waits for a refresh whose runtime has no unindexed
	// guest (see ErrStateIndexMissing).
	runtimeIDs, listErr := runtime.List(ctx)
	if listErr != nil {
		refreshErrors = append(refreshErrors, fmt.Errorf("list Microsandbox runtimes: %w", listErr))
	} else {
		var unindexed []string
		for _, id := range runtimeIDs {
			if _, known := allocations[id]; !known {
				unindexed = append(unindexed, id)
			}
		}
		s.mu.Lock()
		if len(unindexed) == 0 {
			s.indexUnverified = false
		}
		refuse := s.indexUnverified
		s.mu.Unlock()
		if refuse {
			refreshErrors = append(refreshErrors, fmt.Errorf(
				"%w: refusing to delete %d runtime guests absent from %s", ErrStateIndexMissing, len(unindexed), s.path))
			unindexed = nil
		}
		for _, id := range unindexed {
			unlock, locked := s.TryLock(id)
			if !locked {
				continue
			}
			if _, appeared := s.CurrentAllocation(id); appeared {
				unlock()
				continue
			}
			if err := runtime.Delete(ctx, id); err != nil && !runtimeNotFound(err) {
				refreshErrors = append(refreshErrors, fmt.Errorf("delete unindexed runtime %s: %w", id, err))
			}
			unlock()
		}
	}
	for id, snapshot := range allocations {
		unlock, locked := s.TryLock(id)
		if !locked {
			continue
		}
		allocation, allocationErr := s.Allocation(id, snapshot.Generation)
		if allocationErr != nil {
			unlock()
			if !errors.Is(allocationErr, os.ErrNotExist) {
				refreshErrors = append(refreshErrors, fmt.Errorf("re-read runtime %s state: %w", id, allocationErr))
			}
			continue
		}
		s.mu.RLock()
		_, startup := s.startupPending[id]
		s.mu.RUnlock()
		if !allocation.BootstrapComplete {
			if allocation.CreatorBootID == s.bootID && !allocation.UpdatedAt.IsZero() &&
				time.Since(allocation.UpdatedAt) < 40*time.Minute {
				unlock()
				continue
			}
			if err := runtime.Delete(ctx, id); err != nil && !runtimeNotFound(err) {
				refreshErrors = append(refreshErrors, fmt.Errorf("delete interrupted runtime %s: %w", id, err))
				unlock()
				continue
			}
			if removeErr := s.Remove(id, allocation.Generation); removeErr != nil {
				refreshErrors = append(refreshErrors, fmt.Errorf("remove interrupted runtime %s: %w", id, removeErr))
			}
			unlock()
			continue
		}
		response, err := runtime.Get(ctx, id)
		if err != nil {
			if runtimeNotFound(err) {
				if removeErr := s.Remove(id, allocation.Generation); removeErr != nil {
					refreshErrors = append(refreshErrors, fmt.Errorf("remove missing runtime %s: %w", id, removeErr))
				}
				unlock()
				continue
			}
			refreshErrors = append(refreshErrors, fmt.Errorf("inspect runtime %s: %w", id, err))
			unlock()
			continue
		}
		var observed string
		switch response.State {
		case sandbox.StateRunning:
			observed = "running"
		case sandbox.StateStopped, sandbox.StateSuspending:
			if allocation.ObservedState == "restart_pending" ||
				(startup && allocation.ObservedState == "running") {
				observed = "restart_pending"
			} else {
				observed = "stopped"
			}
		default:
			unlock()
			continue
		}
		if observed != allocation.ObservedState {
			if err := s.SetObserved(id, allocation.Generation, observed); err != nil && !errors.Is(err, os.ErrNotExist) {
				refreshErrors = append(refreshErrors, fmt.Errorf("record runtime %s state: %w", id, err))
				unlock()
				continue
			}
		}
		s.mu.Lock()
		delete(s.startupPending, id)
		s.mu.Unlock()
		unlock()
	}
	return errors.Join(refreshErrors...)
}

func (s *State) persistLocked() error {
	payload, err := json.MarshalIndent(s.allocations, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	temporary := s.path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(temporary) }()
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	written, writeErr := file.Write(payload)
	if writeErr == nil && written != len(payload) {
		writeErr = io.ErrShortWrite
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return errors.Join(writeErr, syncErr, closeErr)
	}
	if err := os.Rename(temporary, s.path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return err
	}
	syncErr = directory.Sync()
	closeErr = directory.Close()
	return errors.Join(syncErr, closeErr)
}
