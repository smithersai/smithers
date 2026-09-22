package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

type Handler func(context.Context, *Lease) error

type WorkerConfig struct {
	WorkerID     string
	Capacity     int
	Lease        time.Duration
	PollInterval time.Duration
	RetryDelay   time.Duration
	OnError      func(error)
}

// Lease exposes only fenced mutations to a handler. StartExternal must be
// called immediately before a provider call, not after it returns.
type Lease struct {
	store *Store
	claim Claim
}

func (lease *Lease) Claim() Claim { return lease.claim }

func (lease *Lease) StartExternal(ctx context.Context, observation json.RawMessage) error {
	return lease.store.MarkExternalStarted(ctx, lease.claim, observation)
}

func (lease *Lease) Waiting(ctx context.Context, reason json.RawMessage) error {
	return lease.store.MarkWaiting(ctx, lease.claim, reason)
}

func (lease *Lease) Complete(ctx context.Context, receipt json.RawMessage) error {
	return lease.store.Complete(ctx, lease.claim, receipt)
}

func (lease *Lease) Fail(ctx context.Context, receipt json.RawMessage) error {
	return lease.store.Fail(ctx, lease.claim, receipt)
}

func (lease *Lease) Cancelled(ctx context.Context, receipt json.RawMessage) error {
	// The handler learns about cancellation through ctx, so the receipt write
	// itself must remain usable after ctx becomes done.
	return lease.store.AcknowledgeCancellation(context.WithoutCancel(ctx), lease.claim, receipt)
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
	if handler == nil {
		return errors.New("jobs: worker handler is required")
	}
	if config.PollInterval <= 0 {
		config.PollInterval = 250 * time.Millisecond
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

	for ctx.Err() == nil {
		select {
		case capacity <- struct{}{}:
		case <-ctx.Done():
			break
		}
		if ctx.Err() != nil {
			break
		}
		claim, err := store.Claim(ctx, config.WorkerID, config.Lease)
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
			report(store.runClaim(ctx, claim, config.Lease, heartbeatInterval, config.RetryDelay, handler))
		}()
	}
	workers.Wait()
	return nil
}

func (store *Store) runClaim(parent context.Context, claim Claim, leaseDuration, heartbeatInterval, retryDelay time.Duration, handler Handler) error {
	handlerContext, cancel := context.WithCancel(parent)
	defer cancel()
	result := make(chan error, 1)
	lease := &Lease{store: store, claim: claim}
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
			requested, err := store.Heartbeat(parent, claim, leaseDuration)
			if errors.Is(err, ErrClaimLost) {
				claimLost = true
				cancel()
				continue
			}
			if err != nil {
				cancel()
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
	if claimLost {
		return ErrClaimLost
	}
	operation, err := store.Get(context.WithoutCancel(parent), claim.Scope, claim.OperationID)
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
		return store.Abandon(context.WithoutCancel(parent), claim, handlerErr, retryDelay)
	}
	if handlerErr == nil {
		handlerErr = errors.New("job handler returned without a terminal receipt")
	}
	return store.Abandon(context.WithoutCancel(parent), claim, handlerErr, retryDelay)
}
