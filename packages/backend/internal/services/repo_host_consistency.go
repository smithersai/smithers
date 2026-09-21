package services

import (
	"context"
	"time"
)

// repoHostMutationConsistencyTimeout bounds the phase in which an API-side DB
// mutation and its repo-host storage mutation must reach one coordinated
// outcome. It deliberately exceeds repo-host's 30-second admission deadline:
// once repo-host starts irreversible work its timeout middleware waits for the
// real handler result rather than returning an ambiguous 504.
const repoHostMutationConsistencyTimeout = 10 * time.Minute

// beginRepoHostMutationConsistency preserves request cancellation until the
// last safe point before a coordinated mutation starts. Once called, it keeps
// request values (including tracing and request IDs) but detaches cancellation
// so a disconnected caller cannot interrupt storage and then cancel the DB
// commit or compensation that records the same outcome.
func beginRepoHostMutationConsistency(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if timeout <= 0 {
		timeout = repoHostMutationConsistencyTimeout
	}
	consistencyCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	return consistencyCtx, cancel, nil
}

func runRepoHostMutation(ctx context.Context, mutate func(context.Context) error) error {
	consistencyCtx, cancel, err := beginRepoHostMutationConsistency(ctx, repoHostMutationConsistencyTimeout)
	if err != nil {
		return err
	}
	defer cancel()
	return mutate(consistencyCtx)
}

// repoHostCompensationContext creates a fresh bounded budget for cleanup after
// a coordinated mutation failed. It intentionally does not re-check the dead
// request context: cleanup is required precisely when that request has already
// gone away or exhausted its own deadline.
func repoHostCompensationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), repoHostMutationConsistencyTimeout)
}
