package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

type Handler func(context.Context, *Lease) error

type WorkerConfig struct {
	WorkerID     string
	Capacity     int
	Lease        time.Duration
	PollInterval time.Duration
	RetryDelay   time.Duration
	// SettlementTimeout bounds receipt writes and cleanup after handler cancellation.
	SettlementTimeout time.Duration
	// Operations is an exact allowlist. Empty means every product operation.
	Operations       []string
	RecoveryInterval time.Duration
	RecoveryLimit    int
	OnError          func(error)
}

// Lease exposes only fenced mutations to a handler. StartExternal must be
// called immediately before a provider call, not after it returns.
type Lease struct {
	store             *Store
	claim             Claim
	released          atomic.Bool
	settlementTimeout time.Duration
}

func (lease *Lease) Claim() Claim { return lease.claim }

func (lease *Lease) StartExternal(ctx context.Context, observation json.RawMessage) error {
	attempt, err := lease.store.BeginExternal(ctx, lease.claim, observation)
	if err == nil {
		lease.claim.ExternalAttempt = attempt
	}
	return err
}

// DeliveryAttempt returns the stable external attempt after StartExternal.
func (lease *Lease) DeliveryAttempt() int { return lease.claim.DeliveryAttempt() }

func (lease *Lease) Waiting(ctx context.Context, reason json.RawMessage) error {
	return lease.store.MarkWaiting(ctx, lease.claim, reason)
}

func (lease *Lease) Checkpoint(ctx context.Context, receipt json.RawMessage) (bool, error) {
	return lease.store.Checkpoint(ctx, lease.claim, receipt)
}

// Park saves a non-terminal checkpoint and releases this claim so another
// process can reconcile the external operation after retryAfter.
func (lease *Lease) Park(ctx context.Context, receipt json.RawMessage, retryAfter time.Duration) error {
	if err := lease.store.Park(ctx, lease.claim, receipt, retryAfter); err != nil {
		return err
	}
	lease.released.Store(true)
	return nil
}

// Defer durably parks an external operation and returns ErrDeferred so a
// handler can directly return the result. RunWorker consumes the sentinel.
func (lease *Lease) Defer(ctx context.Context, receipt json.RawMessage, retryAfter time.Duration) error {
	ctx, cancel := settlementContext(ctx, lease.settlementTimeout)
	defer cancel()
	if err := lease.Park(ctx, receipt, retryAfter); err != nil {
		return err
	}
	return ErrDeferred
}

func (lease *Lease) Complete(ctx context.Context, receipt json.RawMessage) error {
	return lease.release(lease.store.Complete(ctx, lease.claim, receipt))
}

func (lease *Lease) Fail(ctx context.Context, receipt json.RawMessage) error {
	return lease.release(lease.store.Fail(ctx, lease.claim, receipt))
}

func (lease *Lease) Cancelled(ctx context.Context, receipt json.RawMessage) error {
	// The handler learns about cancellation through ctx, so the receipt write
	// itself must remain usable after ctx becomes done.
	ctx, cancel := settlementContext(ctx, lease.settlementTimeout)
	defer cancel()
	return lease.release(lease.store.AcknowledgeCancellation(ctx, lease.claim, receipt))
}

// CancelledObserved records cancellation reported by the external authority.
// Unlike Cancelled, it does not require a preceding product cancel request.
func (lease *Lease) CancelledObserved(ctx context.Context, receipt json.RawMessage) error {
	return lease.release(lease.store.RecordExternalCancellation(ctx, lease.claim, receipt))
}

func (lease *Lease) ExternalCancelled(ctx context.Context, receipt json.RawMessage) error {
	ctx, cancel := settlementContext(ctx, lease.settlementTimeout)
	defer cancel()
	return lease.release(lease.store.ExternalCancelled(ctx, lease.claim, receipt))
}

func (lease *Lease) release(err error) error {
	if err == nil {
		lease.released.Store(true)
	}
	return err
}

// RunWorker runs a bounded worker pool. It is intended to be attached to the
// shared app lifecycle; HTTP admission never waits on this loop or a handler.
func (store *Store) RunWorker(ctx context.Context, config WorkerConfig, handler Handler) error {
	if config.WorkerID == "" {
		return errors.New("jobs: worker ID is required")
	}
	if config.Capacity <= 0 {
		return errors.New("jobs: worker capacity must be positive")
	}
	if config.Lease <= 0 {
		return errors.New("jobs: worker lease must be positive")
	}
	if config.SettlementTimeout < 0 {
		return errors.New("jobs: settlement timeout cannot be negative")
	}
	if handler == nil {
		return errors.New("jobs: worker handler is required")
	}
	if config.PollInterval <= 0 {
		config.PollInterval = 250 * time.Millisecond
	}
	if config.Operations != nil && len(config.Operations) == 0 {
		return errors.New("jobs: worker operations cannot be empty")
	}
	operations, err := normalizeOperationFilter(config.Operations)
	if err != nil {
		return err
	}
	config.Operations = operations
	if config.RecoveryInterval <= 0 {
		config.RecoveryInterval = config.Lease / 2
		if config.RecoveryInterval <= 0 {
			config.RecoveryInterval = time.Millisecond
		}
	}
	if config.RecoveryLimit <= 0 {
		config.RecoveryLimit = config.Capacity * 4
	}
	heartbeatInterval := config.Lease / 3
	if heartbeatInterval <= 0 {
		heartbeatInterval = time.Millisecond
	}
	capacity := make(chan struct{}, config.Capacity)
	var workers sync.WaitGroup
	report := func(err error) {
		if err != nil && config.OnError != nil {
			config.OnError(err)
		}
	}

	nextRecovery := time.Time{}
	for ctx.Err() == nil {
		if !time.Now().Before(nextRecovery) {
			if _, err := store.RecoverExpiredForOperations(ctx, config.Operations, config.RecoveryLimit); err != nil && ctx.Err() == nil {
				report(err)
			}
			nextRecovery = time.Now().Add(config.RecoveryInterval)
		}
		select {
		case capacity <- struct{}{}:
		case <-ctx.Done():
			break
		}
		if ctx.Err() != nil {
			break
		}
		claim, err := store.ClaimForOperations(ctx, config.WorkerID, config.Lease, config.Operations)
		if errors.Is(err, ErrNoWork) {
			<-capacity
			timer := time.NewTimer(config.PollInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
			case <-timer.C:
			}
			continue
		}
		if err != nil {
			<-capacity
			if ctx.Err() != nil && errors.Is(err, ctx.Err()) {
				break
			}
			report(err)
			timer := time.NewTimer(config.PollInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
			case <-timer.C:
			}
			continue
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-capacity }()
			report(store.runClaim(ctx, claim, config.Lease, heartbeatInterval, config.RetryDelay, config.SettlementTimeout, handler))
		}()
	}
	workers.Wait()
	return nil
}

func (store *Store) runClaim(parent context.Context, claim Claim, leaseDuration, heartbeatInterval, retryDelay, settlementTimeout time.Duration, handler Handler) error {
	handlerContext, cancel := context.WithCancel(parent)
	defer cancel()
	result := make(chan error, 1)
	lease := &Lease{store: store, claim: claim, settlementTimeout: settlementTimeout}
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				result <- fmt.Errorf("job handler panic: %v", recovered)
			}
		}()
		result <- handler(handlerContext, lease)
	}()
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	cancellationRequested := false
	claimLost := false
	var handlerErr error
	for {
		select {
		case handlerErr = <-result:
			goto settled
		case <-ticker.C:
			if lease.released.Load() {
				continue
			}
			requested, err := store.Heartbeat(parent, claim, leaseDuration)
			if errors.Is(err, ErrClaimLost) {
				if lease.released.Load() {
					continue
				}
				claimLost = true
				cancel()
				continue
			}
			if err != nil {
				cancel()
				handlerErr = <-result
				if parent.Err() != nil && errors.Is(err, parent.Err()) {
					goto settled
				}
				return err
			}
			if requested {
				cancellationRequested = true
				cancel()
			}
		case <-parent.Done():
			cancel()
			handlerErr = <-result
			goto settled
		}
	}

settled:
	if lease.released.Load() {
		if errors.Is(handlerErr, ErrDeferred) {
			return nil
		}
		return handlerErr
	}
	if claimLost {
		return ErrClaimLost
	}
	settlement, stopSettlement := settlementContext(parent, settlementTimeout)
	defer stopSettlement()
	operation, err := store.Get(settlement, claim.Scope, claim.OperationID)
	if err != nil {
		return err
	}
	if operation.State.Terminal() {
		return handlerErr
	}
	if operation.CancellationRequested || cancellationRequested {
		if handlerErr == nil {
			handlerErr = errors.New("job handler returned without a cancellation receipt")
		}
		return store.Abandon(settlement, claim, handlerErr, retryDelay)
	}
	if handlerErr == nil {
		handlerErr = errors.New("job handler returned without a terminal receipt")
	}
	return store.Abandon(settlement, claim, handlerErr, retryDelay)
}
