package services

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

const legacyImportRolloutFailure = "legacy import requires operator review after durable provisioning rollout; remove any partial local repository, then retry"

// ConfigureRepositoryProvisioningEnforcement reads the database-scoped
// expand/contract switch and, when explicitly requested by a post-drain
// deployment, enables it irreversibly for that startup. Compatibility mode is
// never enabled here: emergency rollback is an explicit operator SQL action.
func ConfigureRepositoryProvisioningEnforcement(
	ctx context.Context,
	pool *pgxpool.Pool,
	enable bool,
) (bool, error) {
	if pool == nil {
		return false, fmt.Errorf("repository provisioning enforcement requires a database pool")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin repository provisioning control transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var enabled bool
	if err := tx.QueryRow(ctx, `
		SELECT enforce_insert_fence
		FROM repository_provisioning_control
		WHERE singleton
		FOR UPDATE
	`).Scan(&enabled); err != nil {
		return false, fmt.Errorf("read repository provisioning insert fence: %w", err)
	}
	if enable && !enabled {
		// Pre-20260718000900 detached imports have no durable provisioning binding. A
		// crashed legacy worker may nevertheless have created DB/storage state,
		// so adopting one as a fresh durable job can synthesize a duplicate. The
		// phase-two transition is the only safe cutoff: after legacy pods drain,
		// terminalize every ambiguous job before the durable worker can start.
		if _, err := tx.Exec(ctx, `
			UPDATE import_jobs
			SET status = 'failed', stage = '', error = $1,
			    claim_token = NULL, claimed_at = NULL, updated_at = NOW()
			WHERE status = 'cloning'
			  AND provisioning_repository_id IS NULL
			  AND provisioning_token IS NULL
		`, legacyImportRolloutFailure); err != nil {
			return false, fmt.Errorf("terminalize ambiguous legacy import jobs: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE repository_provisioning_control
			SET enforce_insert_fence = TRUE, updated_at = NOW()
			WHERE singleton
		`); err != nil {
			return false, fmt.Errorf("enable repository provisioning insert fence: %w", err)
		}
		enabled = true
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit repository provisioning control transition: %w", err)
	}
	return enabled, nil
}
