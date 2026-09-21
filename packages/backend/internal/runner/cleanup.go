package runner

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
)

func (p *RunnerPool) cleanupStaleRunners(ctx context.Context) (int, error) {
	cutoff := p.now().Add(-p.heartbeatTimeout)
	staleRunners, err := p.store.ListStaleRunners(ctx, pgtype.Timestamptz{
		Time:  cutoff,
		Valid: true,
	})
	if err != nil {
		return 0, err
	}

	cleaned := 0
	var errs []error
	for _, stale := range staleRunners {
		if err := p.terminateRunner(ctx, stale.ID); err != nil {
			errs = append(errs, fmt.Errorf("terminate stale runner %d: %w", stale.ID, err))
			continue
		}
		cleaned++
	}

	return cleaned, errors.Join(errs...)
}
