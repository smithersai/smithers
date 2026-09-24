package chat

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Verify is a test oracle. It rebuilds the complete journal projection, including its recorded byte
// total, from the immutable batches. Normal reads verify the requested boundary,
// every returned edge, and the sealed head.
func (s *Store) Verify(ctx context.Context, scope Scope, runID string, journal JournalRequest) error {
	if !validIdentity(runID) || !validJournal(journal) {
		return ErrInvalidRequest
	}
	ownerHash, accessHash, err := authHashes(scope, journal.Token)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	turn, err := scanTurn(tx.QueryRow(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3 FOR SHARE`, scope.UserID, runID, journal.LegID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err = authorize(turn, ownerHash, accessHash); err != nil {
		return err
	}
	acceptance, head, err := checkHead(turn)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT batch_number,from_position,previous_hash,frames,hash,canonical_bytes FROM chat_turn_batches WHERE turn_id=$1 ORDER BY batch_number`, turn.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	next := initialCursor(acceptance)
	var outputBytes int64
	terminal := false
	for rows.Next() {
		if terminal {
			return ErrCorrupt
		}
		batch, storedBytes, scanErr := loadBatch(rows)
		if scanErr != nil {
			return scanErr
		}
		batch, meta, verifyErr := verifyStoredBatch(turn, next.Batch+1, batch, storedBytes)
		if verifyErr != nil || batch.From != next.Position+1 || !equalSecret(batch.PreviousHash, next.Hash) {
			return ErrCorrupt
		}
		next = cursorAfter(batch)
		outputBytes += int64(storedBytes)
		terminal = meta.Type == "done"
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if !sameCursor(next, head) || outputBytes != turn.OutputBytes || terminal != turn.Terminal {
		return ErrCorrupt
	}
	return tx.Commit(ctx)
}
