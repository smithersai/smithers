package credits

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/smithersai/smithers/packages/backend/modelprice"
)

// ModelOutcome is what the caller knows about a provider call's charge.
type ModelOutcome string

const (
	// ModelSucceeded: the provider reported usage; ActualNanos is its cost.
	ModelSucceeded ModelOutcome = "succeeded"
	// ModelFailed: the provider refused or was never reached; nothing is owed.
	ModelFailed ModelOutcome = "failed"
	// ModelUnknown: the call may have been charged but reported no usage.
	// The full bound is charged, so an unreadable response is never free.
	ModelUnknown ModelOutcome = "unknown"
)

type ModelResult struct {
	Outcome     ModelOutcome
	ActualNanos int64
}

// settleTimeout bounds the settlement write after the provider returns, even
// when the request context has been cancelled.
const settleTimeout = 10 * time.Second

// ExecuteModelCall is the mandatory boundary around a platform-funded call.
// key identifies the logical call: a retry with the same key never reaches
// the provider again. It returns ErrInFlight while another attempt holds the
// key and ErrFinished once the key has settled. If the settlement write
// fails, the reservation stays open and is later charged at its bound.
func (l Ledger) ExecuteModelCall(ctx context.Context, accountID int64, key string, bound int64, spend func(context.Context) (ModelResult, error)) (Reservation, error) {
	r, err := l.Reserve(ctx, accountID, key, bound)
	if err != nil {
		return r, err
	}
	if !r.Fresh {
		if r.Status == "reserved" {
			return r, ErrInFlight
		}
		return r, ErrFinished
	}
	result, callErr := spend(ctx)
	charge := bound
	switch result.Outcome {
	case ModelFailed:
		charge = 0
	case ModelSucceeded:
		if result.ActualNanos >= 0 {
			charge = result.ActualNanos
		} else {
			result.Outcome = ModelUnknown
		}
	default:
		result.Outcome = ModelUnknown
	}
	settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), settleTimeout)
	defer cancel()
	settled, err := l.Settle(settleCtx, accountID, key, charge)
	if err != nil {
		return r, errors.Join(fmt.Errorf("credits: settle %q: %w", key, err), callErr)
	}
	if result.Outcome == ModelUnknown {
		return settled, errors.Join(ErrOutcomeUnknown, callErr)
	}
	return settled, callErr
}

// ExecutePricedModelCall bounds the reservation by the model's list price at
// the provider-enforced token ceilings in maximum, and settles the reported
// usage at the same price.
func (l Ledger) ExecutePricedModelCall(ctx context.Context, accountID int64, key, model string, maximum modelprice.Usage, spend func(context.Context) (ModelOutcome, modelprice.Usage, error)) (Reservation, error) {
	price, ok := modelprice.Lookup(model)
	if !ok {
		return Reservation{AccountID: accountID}, fmt.Errorf("credits: model %q is not offered on platform keys", model)
	}
	bound, err := modelprice.CostNanos(price, maximum)
	if err != nil {
		return Reservation{AccountID: accountID}, err
	}
	if bound <= 0 {
		return Reservation{AccountID: accountID}, errors.New("credits: model call bound must be positive")
	}
	return l.ExecuteModelCall(ctx, accountID, key, bound, func(ctx context.Context) (ModelResult, error) {
		outcome, usage, callErr := spend(ctx)
		if outcome != ModelSucceeded {
			return ModelResult{Outcome: outcome}, callErr
		}
		actual, costErr := modelprice.CostNanos(price, usage)
		if costErr != nil {
			return ModelResult{Outcome: ModelUnknown}, errors.Join(callErr, costErr)
		}
		return ModelResult{Outcome: ModelSucceeded, ActualNanos: actual}, callErr
	})
}
