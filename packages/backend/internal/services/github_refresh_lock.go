package services

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// githubRefreshLockSQL serializes GitHub user-token refreshes for ONE oauth
// account across every API replica.
//
// Why an advisory lock and not a row lock: the refresh critical section performs
// an outbound call to GitHub, and the writes inside it go through the ordinary
// pool connection (so they commit and become visible to the next lock holder
// immediately). A `SELECT ... FOR UPDATE` on oauth_accounts would instead hold
// the row inside a transaction whose writes stay invisible until commit, which
// is exactly the wrong shape here.
//
// The key is (provider, provider_user_id) — the pair the oauth_accounts CAS
// statements match on — rather than the numeric user id, so the lock and the
// compare-and-swap protect the same row. Parameters are cast to text inside the
// statement so pgx infers text parameters for both.
const githubRefreshLockSQL = "SELECT pg_advisory_xact_lock(hashtextextended('github_oauth_refresh:' || $1::text || ':' || $2::text, 0))"

// githubRefreshLockBeginner is the narrow slice of *pgxpool.Pool this needs.
type githubRefreshLockBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// PgGitHubRefreshLocker implements GitHubRefreshLocker on Postgres advisory
// locks, extending AuthService's in-process per-user mutex across replicas so
// two pods cannot both spend the same single-use GitHub refresh token.
type PgGitHubRefreshLocker struct {
	pool githubRefreshLockBeginner
}

func NewPgGitHubRefreshLocker(pool githubRefreshLockBeginner) *PgGitHubRefreshLocker {
	return &PgGitHubRefreshLocker{pool: pool}
}

// WithUserRefreshLock runs fn while holding the per-account advisory lock. The
// lock is transaction-scoped, so it is released by the deferred rollback (and by
// the backend dying) — it can never be leaked by a panicking or cancelled
// caller.
//
// It DEGRADES OPEN on purpose: if the lock cannot be taken, fn still runs. A
// refresh that is merely un-serialized is recoverable (the CAS plus the
// heal-on-cleared-refresh path in refreshUserGitHubTokenLocked converge on the
// correct row), whereas refusing to refresh would sign the user out. Correctness
// never depends on this lock; it only avoids a wasted, doomed GitHub call.
func (l *PgGitHubRefreshLocker) WithUserRefreshLock(ctx context.Context, provider, providerUserID string, fn func(context.Context) error) error {
	if l == nil || l.pool == nil || fn == nil {
		if fn == nil {
			return nil
		}
		return fn(ctx)
	}
	tx, err := l.pool.Begin(ctx)
	if err != nil {
		return fn(ctx)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, githubRefreshLockSQL, provider, providerUserID); err != nil {
		return fn(ctx)
	}
	return fn(ctx)
}
