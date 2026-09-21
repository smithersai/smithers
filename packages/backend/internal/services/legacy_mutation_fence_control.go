package services

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// LegacyMutationFenceState is the database-authoritative phase of the
// one-release mutation-protocol rollout. Both fences move together only after
// the deploy gate has proved that every previous-version API pod is gone.
type LegacyMutationFenceState struct {
	RepositoryStorageEnforced bool
	ReleaseDeletionEnabled    bool
}

// ConfigureLegacyMutationFences reads the rollout state and, when explicitly
// requested by the post-drain deployment phase, contracts both compatibility
// paths irreversibly. Passing false is read-only: an ordinary restart or a
// stale environment value must never weaken a fleet that has already moved to
// the durable protocols.
func ConfigureLegacyMutationFences(
	ctx context.Context,
	pool *pgxpool.Pool,
	enable bool,
) (LegacyMutationFenceState, error) {
	if pool == nil {
		return LegacyMutationFenceState{}, fmt.Errorf("legacy mutation fences require a database pool")
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return LegacyMutationFenceState{}, fmt.Errorf("begin legacy mutation fence transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var state LegacyMutationFenceState
	if err := tx.QueryRow(ctx, `
		SELECT enforce_repository_storage, enforce_release_deletion
		FROM legacy_mutation_fence_control
		WHERE singleton
		FOR UPDATE
	`).Scan(&state.RepositoryStorageEnforced, &state.ReleaseDeletionEnabled); err != nil {
		return LegacyMutationFenceState{}, fmt.Errorf("read legacy mutation fence state: %w", err)
	}

	if enable && (!state.RepositoryStorageEnforced || !state.ReleaseDeletionEnabled) {
		if err := tx.QueryRow(ctx, `
			UPDATE legacy_mutation_fence_control
			SET enforce_repository_storage = TRUE,
			    enforce_release_deletion = TRUE,
			    updated_at = NOW()
			WHERE singleton
			RETURNING enforce_repository_storage, enforce_release_deletion
		`).Scan(&state.RepositoryStorageEnforced, &state.ReleaseDeletionEnabled); err != nil {
			return LegacyMutationFenceState{}, fmt.Errorf("enable legacy mutation fences: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return LegacyMutationFenceState{}, fmt.Errorf("commit legacy mutation fence transition: %w", err)
	}
	return state, nil
}
