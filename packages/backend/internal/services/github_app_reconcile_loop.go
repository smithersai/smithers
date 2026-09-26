package services

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// GitHubAppInstallationReconcileInterval is how often the installation
// reconcile repairs mappings that missed a webhook.
const GitHubAppInstallationReconcileInterval = time.Hour

// githubAppReconcileLockSQL elects one worker replica per reconcile tick. The
// reconcile is idempotent, so the lock only avoids N replicas repeating the
// same GitHub walk; correctness never depends on it.
const githubAppReconcileLockSQL = "SELECT pg_try_advisory_xact_lock(hashtextextended('github_app_installation_reconcile', 0))"

// GitHubAppReconcileLocker runs fn only when this process wins the reconcile
// lock. ran reports whether fn was called.
type GitHubAppReconcileLocker interface {
	TryWithLock(ctx context.Context, fn func(context.Context) error) (ran bool, err error)
}

// githubAppReconcileLockBeginner is the narrow slice of *pgxpool.Pool this needs.
type githubAppReconcileLockBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// PgGitHubAppReconcileLocker implements GitHubAppReconcileLocker with a
// transaction-scoped Postgres advisory lock. The reconcile's own writes go
// through the ordinary pool, so they commit independently of the lock
// transaction, and the deferred rollback (or a dead backend) always releases it.
type PgGitHubAppReconcileLocker struct {
	pool githubAppReconcileLockBeginner
}

func NewPgGitHubAppReconcileLocker(pool githubAppReconcileLockBeginner) *PgGitHubAppReconcileLocker {
	return &PgGitHubAppReconcileLocker{pool: pool}
}

func (l *PgGitHubAppReconcileLocker) TryWithLock(ctx context.Context, fn func(context.Context) error) (bool, error) {
	tx, err := l.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var acquired bool
	if err := tx.QueryRow(ctx, githubAppReconcileLockSQL).Scan(&acquired); err != nil {
		return false, err
	}
	if !acquired {
		return false, nil
	}
	return true, fn(ctx)
}

// StartGitHubAppInstallationReconciler reconciles GitHub App installations now
// and then every interval until ctx is done. Webhooks are hints; this sweep is
// the only repair for a missed one. Run it as a goroutine.
func (s *RepoConnectionService) StartGitHubAppInstallationReconciler(ctx context.Context, locker GitHubAppReconcileLocker, interval time.Duration) {
	runGitHubAppInstallationReconcileLoop(ctx, locker, interval, s.ReconcileGitHubAppInstallations)
}

func runGitHubAppInstallationReconcileLoop(
	ctx context.Context,
	locker GitHubAppReconcileLocker,
	interval time.Duration,
	reconcile func(context.Context) error,
) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		runGitHubAppInstallationReconcileOnce(ctx, locker, reconcile)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runGitHubAppInstallationReconcileOnce(
	ctx context.Context,
	locker GitHubAppReconcileLocker,
	reconcile func(context.Context) error,
) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("github_app.reconcile.panic", "panic", r)
		}
	}()
	if ctx.Err() != nil {
		return
	}
	var err error
	if locker == nil {
		err = reconcile(ctx)
	} else {
		var ran bool
		ran, err = locker.TryWithLock(ctx, reconcile)
		if err == nil && !ran {
			slog.Debug("github_app.reconcile.skipped", "reason", "another replica holds the reconcile lock")
			return
		}
	}
	if err != nil && ctx.Err() == nil {
		slog.Error("github_app.reconcile.failed", "error", err)
	}
}
