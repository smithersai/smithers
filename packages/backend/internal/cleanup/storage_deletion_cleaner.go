package cleanup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const (
	defaultStorageDeletionInterval = time.Minute
	storageDeletionClaimLease      = 5 * time.Minute
	storageDeletionPurgeTimeout    = 2 * time.Minute
)

type storageDeletionCoordinator interface {
	Claim(ctx context.Context, token string, lease time.Duration, limit int32) ([]clusterdb.StorageDeletionQueue, error)
	Process(ctx context.Context, row clusterdb.StorageDeletionQueue, purge func(context.Context, string) error) (bool, error)
}

// postgresStorageDeletionCoordinator keeps the queue row locked across the
// physical object-store call. LFS re-admission triggers delete the same row,
// so they either win before this lock (and cancel the purge) or wait until old
// generations are gone before a new upload capability can be issued.
type postgresStorageDeletionCoordinator struct {
	pool *pgxpool.Pool
}

func (c *postgresStorageDeletionCoordinator) Claim(ctx context.Context, token string, lease time.Duration, limit int32) ([]clusterdb.StorageDeletionQueue, error) {
	leaseSeconds := int32(lease / time.Second)
	if leaseSeconds < 1 {
		leaseSeconds = 1
	}
	return deploymentdb.New(c.pool).ClaimStorageDeletions(ctx, clusterdb.ClaimStorageDeletionsParams{
		LeaseSeconds: leaseSeconds,
		LimitRows:    limit,
		ClaimToken:   pgtype.Text{String: token, Valid: true},
	})
}

func (c *postgresStorageDeletionCoordinator) Process(
	ctx context.Context,
	row clusterdb.StorageDeletionQueue,
	purge func(context.Context, string) error,
) (processed bool, retErr error) {
	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin storage deletion transaction: %w", err)
	}
	defer func() {
		rollbackErr := tx.Rollback(context.Background())
		if rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) && retErr == nil {
			retErr = fmt.Errorf("rollback storage deletion transaction: %w", rollbackErr)
		}
	}()

	queries := deploymentdb.New(tx)
	locked, err := queries.LockClaimedStorageDeletion(ctx, clusterdb.LockClaimedStorageDeletionParams{
		ID:         row.ID,
		ClaimToken: row.ClaimToken,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Re-admission or a newer worker resolved/reclaimed this row.
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("lock storage deletion %d: %w", row.ID, err)
	}

	active, err := queries.IsStorageDeletionObjectActive(ctx, db.IsStorageDeletionObjectActiveParams{
		RepositoryID:  locked.RepositoryID,
		AllocationKey: locked.AllocationKey,
	})
	if err != nil {
		return false, fmt.Errorf("check active storage key %q: %w", locked.ObjectKey, err)
	}
	if active {
		if err := deleteClaimedStorageDeletion(ctx, queries, locked); err != nil {
			return false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return false, fmt.Errorf("commit active storage-key resolution: %w", err)
		}
		return true, nil
	}

	if err := purge(ctx, locked.ObjectKey); err != nil {
		purgeErr := fmt.Errorf("purge storage key %q: %w", locked.ObjectKey, err)
		released, releaseErr := queries.ReleaseClaimedStorageDeletion(ctx, clusterdb.ReleaseClaimedStorageDeletionParams{
			ID:         locked.ID,
			ClaimToken: locked.ClaimToken,
			LastError:  purgeErr.Error(),
		})
		if releaseErr != nil {
			return false, errors.Join(purgeErr, fmt.Errorf("release storage deletion claim: %w", releaseErr))
		}
		if released != 1 {
			return false, errors.Join(purgeErr, fmt.Errorf("release storage deletion claim: expected 1 row, got %d", released))
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return false, errors.Join(purgeErr, fmt.Errorf("commit storage deletion retry: %w", commitErr))
		}
		return false, purgeErr
	}

	if err := deleteClaimedStorageDeletion(ctx, queries, locked); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit storage deletion: %w", err)
	}
	return true, nil
}

type storageDeletionTxQueries interface {
	DeleteClaimedStorageDeletion(context.Context, clusterdb.DeleteClaimedStorageDeletionParams) (int64, error)
}

func deleteClaimedStorageDeletion(ctx context.Context, queries storageDeletionTxQueries, row clusterdb.StorageDeletionQueue) error {
	deleted, err := queries.DeleteClaimedStorageDeletion(ctx, clusterdb.DeleteClaimedStorageDeletionParams{
		ID:         row.ID,
		ClaimToken: row.ClaimToken,
	})
	if err != nil {
		return fmt.Errorf("delete claimed storage deletion %d: %w", row.ID, err)
	}
	if deleted != 1 {
		return fmt.Errorf("delete claimed storage deletion %d: expected 1 row, got %d", row.ID, deleted)
	}
	return nil
}

// StorageDeletionCleaner drains exact object keys that metadata/repository
// deletion triggers durably enqueued. A row remains metered until every key in
// its allocation has been permanently purged.
type StorageDeletionCleaner struct {
	periodicRunner
	coordinator  storageDeletionCoordinator
	store        blob.Store
	batchSize    int32
	purgeTimeout time.Duration
}

func NewStorageDeletionCleaner(pool *pgxpool.Pool, store blob.Store, interval time.Duration, batchSize int32) *StorageDeletionCleaner {
	return newStorageDeletionCleaner(&postgresStorageDeletionCoordinator{pool: pool}, store, interval, batchSize)
}

func newStorageDeletionCleaner(coordinator storageDeletionCoordinator, store blob.Store, interval time.Duration, batchSize int32) *StorageDeletionCleaner {
	if batchSize <= 0 {
		batchSize = 250
	}
	c := &StorageDeletionCleaner{
		coordinator:  coordinator,
		store:        store,
		batchSize:    batchSize,
		purgeTimeout: storageDeletionPurgeTimeout,
	}
	c.init("storage_deletion", interval, defaultStorageDeletionInterval)
	return c
}

func (c *StorageDeletionCleaner) Start(ctx context.Context) {
	c.start(ctx, func(ctx context.Context) error {
		processed, err := c.sweep(ctx)
		if err != nil {
			return fmt.Errorf("processed %d: %w", processed, err)
		}
		if processed > 0 {
			slog.Info("storage deletion cleanup completed", "processed", processed)
		}
		return nil
	})
}

func (c *StorageDeletionCleaner) sweep(ctx context.Context) (int, error) {
	if c.coordinator == nil || c.store == nil {
		return 0, nil
	}
	token := uuid.NewString()
	rows, err := c.coordinator.Claim(ctx, token, storageDeletionClaimLease, c.batchSize)
	if err != nil {
		return 0, fmt.Errorf("claim storage deletions: %w", err)
	}

	processed := 0
	var errs []error
	for _, row := range rows {
		done, processErr := c.coordinator.Process(ctx, row, func(ctx context.Context, key string) error {
			purgeTimeout := c.purgeTimeout
			if purgeTimeout <= 0 {
				purgeTimeout = storageDeletionPurgeTimeout
			}
			purgeCtx, cancel := context.WithTimeout(ctx, purgeTimeout)
			defer cancel()
			return blob.PurgeAllGenerations(purgeCtx, c.store, key)
		})
		if done {
			processed++
		}
		if processErr != nil {
			errs = append(errs, processErr)
		}
	}
	return processed, errors.Join(errs...)
}
