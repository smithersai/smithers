package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type WikiHistoryDatabase interface {
	db.DBTX
	Begin(context.Context) (pgx.Tx, error)
}

type WikiHistoryHost interface {
	ProjectWikiRevision(context.Context, string, string, repohost.WikiRevisionProjection) (string, error)
}

// ReconcileWikiHistory projects only the first unacknowledged revision per page.
// Native JJ receipt recovery makes a retry after API/DB acknowledgement loss safe.
func ReconcileWikiHistory(ctx context.Context, database WikiHistoryDatabase, host WikiHistoryHost) (int, error) {
	rows, err := db.New(database).ListWikiHistoryRecovery(ctx, 100)
	if err != nil {
		return 0, err
	}
	completed := 0
	var firstErr error
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return completed, err
		}
		attempt, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := projectWikiHistoryRevision(attempt, database, host, row)
		cancel()
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("wiki revision %d: %w", row.ID, err)
			}
			continue
		}
		completed++
	}
	return completed, firstErr
}

func projectWikiHistoryRevision(ctx context.Context, database WikiHistoryDatabase, host WikiHistoryHost, row db.ListWikiHistoryRecoveryRow) error {
	tx, err := database.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	q := db.New(tx)
	// Fence deletion AND rename/transfer while writing the owner/name-addressed
	// sidecar. FOR KEY SHARE would not fence ordinary owner/name updates. This
	// bounded background projection holds no page write lock; interactive CRDT
	// merges remain outside SQL transactions.
	repository, err := q.LockWikiHistoryRepository(ctx, row.RepositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	} // parent was deleted; history cascades
	if err != nil {
		return err
	}
	commit, err := host.ProjectWikiRevision(ctx, repository.OwnerName, repository.RepoName, repohost.WikiRevisionProjection{
		ID: row.ID, PageID: row.PageID, Revision: row.Revision, Slug: row.Slug, Title: row.Title,
		Body: row.Body, Author: row.AuthorUsername, Deleted: row.Deleted,
	})
	if err != nil {
		return err
	}
	if commit == "" {
		return fmt.Errorf("wiki projection returned empty commit")
	}
	if _, err = q.MarkWikiHistoryProjected(ctx, db.MarkWikiHistoryProjectedParams{ID: row.ID, HistoryCommitID: commit}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RunWikiHistory shares the API process lifetime and existing database/client;
// immutable revisions are the recovery source, not another job table or engine.
func RunWikiHistory(ctx context.Context, database WikiHistoryDatabase, host WikiHistoryHost) {
	for {
		count, err := ReconcileWikiHistory(ctx, database, host)
		if err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "wiki history projection pending", "error", err)
		}
		delay := 5 * time.Second
		if count > 0 && err == nil {
			delay = 10 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
