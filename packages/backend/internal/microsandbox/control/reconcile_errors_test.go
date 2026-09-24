package control

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

var (
	errReleaseDeferred = errors.New("release deferred")
	errClaimDB         = errors.New("claim database unavailable")
)

// reconcileErrorsStore defers one cleanup release, then fails the claim of
// the phase named by failPhase.
type reconcileErrorsStore struct {
	drainBudgetTestStore
	failPhase     string
	cleanupClaims int
}

func (s *reconcileErrorsStore) ClaimCleanup(context.Context, string, time.Duration) (Placement, error) {
	s.cleanupClaims++
	switch {
	case s.cleanupClaims == 1:
		return Placement{SandboxID: "msb_deferred", Generation: 1}, nil
	case s.failPhase == "cleanup":
		return Placement{}, errClaimDB
	default:
		return Placement{}, ErrNotFound
	}
}

func (s *reconcileErrorsStore) Release(context.Context, string, int64) error {
	return errReleaseDeferred
}

func (s *reconcileErrorsStore) ClaimRestart(context.Context, string, time.Duration) (Placement, error) {
	if s.failPhase == "restart" {
		return Placement{}, errClaimDB
	}
	return Placement{}, ErrNotFound
}

// A claim failure must not erase the errors the pass already collected:
// every phase reports errors.Join(recoveryErrors, claimErr).
func TestReconcileKeepsCollectedErrorsWhenAClaimFails(t *testing.T) {
	for _, phase := range []string{"cleanup", "restart"} {
		t.Run(phase, func(t *testing.T) {
			controller := New(&reconcileErrorsStore{failPhase: phase}, Config{AllowInsecureDev: true})
			_, err := controller.Reconcile(context.Background(), time.Now())
			require.ErrorIs(t, err, errClaimDB)
			require.ErrorIs(t, err, errReleaseDeferred, "the deferred cleanup error was dropped")
		})
	}
}
