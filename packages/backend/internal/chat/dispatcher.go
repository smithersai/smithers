package chat

import (
	"context"
	"errors"
	"sync"
	"time"
)

type Host interface {
	RunTurn(context.Context, ProducerGrant) error
}

type runningTurn struct {
	generation int64
	cancel     context.CancelFunc
}

type Dispatcher struct {
	store   *Store
	host    Host
	lease   time.Duration
	queue   chan Candidate
	mu      sync.Mutex
	running map[string]runningTurn
}

func NewDispatcher(store *Store, host Host, queueSize int, lease time.Duration) (*Dispatcher, error) {
	if store == nil || host == nil || queueSize <= 0 || lease <= 0 {
		return nil, errors.New("invalid chat dispatcher configuration")
	}
	return &Dispatcher{store: store, host: host, lease: lease, queue: make(chan Candidate, queueSize), running: map[string]runningTurn{}}, nil
}

// Enqueue never waits for host launch. PostgreSQL recovery picks up a full queue.
func (d *Dispatcher) Enqueue(candidate Candidate) bool {
	select {
	case d.queue <- candidate:
		return true
	default:
		return false
	}
}

func (d *Dispatcher) CancelRunning(turnID string) {
	d.mu.Lock()
	running, ok := d.running[turnID]
	d.mu.Unlock()
	if ok {
		running.cancel()
	}
}

func (d *Dispatcher) runOne(parent context.Context, candidate Candidate) {
	grant, err := d.store.Claim(parent, candidate.Scope, candidate.TurnID, d.lease)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	d.mu.Lock()
	d.running[candidate.TurnID] = runningTurn{generation: grant.Generation, cancel: cancel}
	d.mu.Unlock()
	defer func() {
		cancel()
		d.mu.Lock()
		if current, ok := d.running[candidate.TurnID]; ok && current.generation == grant.Generation {
			delete(d.running, candidate.TurnID)
		}
		d.mu.Unlock()
	}()
	err = d.host.RunTurn(ctx, grant)
	if err != nil {
		// Lifecycle shutdown is not a user cancellation or a terminal provider
		// fact. Leave the lease for restart recovery. An explicit user cancel
		// has already committed its terminal batch before interrupting this host.
		if parent.Err() == nil {
			_ = d.store.FailProducer(context.WithoutCancel(parent), grant, "host_failed")
		}
		return
	}
	_, terminal, getErr := d.store.GetState(context.WithoutCancel(parent), candidate.Scope, candidate.TurnID)
	if getErr == nil && !terminal {
		_ = d.store.FailProducer(context.WithoutCancel(parent), grant, "host_returned_without_receipt")
	}
}

func (d *Dispatcher) Run(ctx context.Context, concurrency int) error {
	if concurrency <= 0 {
		return errors.New("chat dispatcher concurrency must be positive")
	}
	work := make(chan Candidate)
	var workers sync.WaitGroup
	for range concurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for candidate := range work {
				d.runOne(ctx, candidate)
			}
		}()
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer func() {
		close(work)
		workers.Wait()
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case candidate := <-d.queue:
			select {
			case work <- candidate:
			case <-ctx.Done():
				return nil
			}
		case <-ticker.C:
			candidates, err := d.store.RecoveryCandidates(ctx, 100)
			if err != nil {
				continue
			}
			for _, candidate := range candidates {
				select {
				case work <- candidate:
				case <-ctx.Done():
					return nil
				}
			}
		}
	}
}
