// Package credits owns exact, transactional platform credit accounting.
//
// Amounts are integer USD nanos. Every spendable amount is a grant with an
// optional expiry. A platform-funded model call reserves a bound before it
// reaches the provider and settles exactly once. Every writer locks the
// account row first, so concurrent reservations cannot overspend.
package credits

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NanosPerCent converts integer cents to nanos.
const NanosPerCent int64 = 10_000_000

// DefaultAbandonAfter is how long a reservation may stay open before the
// next reservation on the same account settles it at its full bound.
const DefaultAbandonAfter = 6 * time.Hour

var (
	ErrInsufficient   = errors.New("credits: insufficient credit")
	ErrConflict       = errors.New("credits: key reused with different values")
	ErrSealed         = errors.New("credits: account has no verified owner")
	ErrNotFound       = errors.New("credits: not found")
	ErrInFlight       = errors.New("credits: reservation is still open")
	ErrFinished       = errors.New("credits: reservation already finished")
	ErrOutcomeUnknown = errors.New("credits: model outcome unknown; charged the reserved bound")
)

// Ledger is the exact credit ledger over the product database.
type Ledger struct {
	DB *pgxpool.Pool
	// AbandonAfter bounds an open reservation. Reserve settles the account's
	// older open reservations at their full bound: the provider may have
	// charged for a call whose settlement was lost. Zero means DefaultAbandonAfter.
	AbandonAfter time.Duration
}

// Reservation is one request key's hold on credit.
type Reservation struct {
	ID            int64
	AccountID     int64
	ReservedNanos int64
	ChargedNanos  int64
	// Status is reserved, settled or released.
	Status string
	// Fresh is true only for the call that created the reservation.
	Fresh bool
}

func (l Ledger) transaction(ctx context.Context, fn func(pgx.Tx) error) error {
	if l.DB == nil {
		return errors.New("credits: PostgreSQL pool required")
	}
	tx, err := l.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validOwner(ownerType string, ownerID int64) bool {
	return (ownerType == "user" || ownerType == "org") && ownerID > 0
}

// EnsureAccount returns the owner's credit account, creating it once.
func (l Ledger) EnsureAccount(ctx context.Context, ownerType string, ownerID int64) (int64, error) {
	if !validOwner(ownerType, ownerID) {
		return 0, errors.New("credits: owner type user or org and a positive owner id required")
	}
	var id int64
	err := l.transaction(ctx, func(tx pgx.Tx) error {
		var e error
		id, e = ensureAccount(ctx, tx, ownerType, ownerID)
		return e
	})
	return id, err
}

func ensureAccount(ctx context.Context, tx pgx.Tx, ownerType string, ownerID int64) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO credit_accounts (owner_type, owner_id) VALUES ($1, $2)
		ON CONFLICT (owner_type, owner_id) DO NOTHING RETURNING id`, ownerType, ownerID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT id FROM credit_accounts WHERE owner_type = $1 AND owner_id = $2`, ownerType, ownerID).Scan(&id)
	}
	return id, err
}

type lockedAccount struct {
	id          int64
	disposition string
	debt        int64
	now         time.Time
}

func lockAccount(ctx context.Context, tx pgx.Tx, id int64) (lockedAccount, error) {
	a := lockedAccount{id: id}
	err := tx.QueryRow(ctx, `SELECT disposition, debt_nanos, now() FROM credit_accounts WHERE id = $1 FOR UPDATE`, id).
		Scan(&a.disposition, &a.debt, &a.now)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, fmt.Errorf("credit account %d: %w", id, ErrNotFound)
	}
	return a, err
}

// Grant adds one immutable source grant to an owned account. Replaying the
// same key with the same amount and expiry is a no-op. New credit repays any
// debt first.
func (l Ledger) Grant(ctx context.Context, accountID int64, key string, nanos int64, expiresAt *time.Time) error {
	if key == "" || nanos < 0 {
		return errors.New("credits: grant key and a non-negative amount required")
	}
	expiresAt = storedTime(expiresAt)
	return l.transaction(ctx, func(tx pgx.Tx) error {
		a, err := lockAccount(ctx, tx, accountID)
		if err != nil {
			return err
		}
		if a.disposition != "owned" {
			return ErrSealed
		}
		inserted, err := insertGrant(ctx, tx, a, key, nanos, expiresAt, "grant")
		if err != nil || !inserted {
			return err
		}
		return repayDebt(ctx, tx, a.id)
	})
}

// insertGrant inserts a grant or proves an identical one exists.
func insertGrant(ctx context.Context, tx pgx.Tx, a lockedAccount, key string, nanos int64, expiresAt *time.Time, kind string) (bool, error) {
	var existing int64
	var existingExpiry *time.Time
	err := tx.QueryRow(ctx, `SELECT original_nanos, expires_at FROM credit_grants WHERE account_id = $1 AND source_key = $2`, a.id, key).
		Scan(&existing, &existingExpiry)
	if err == nil {
		if existing != nanos || !sameTime(existingExpiry, expiresAt) {
			return false, ErrConflict
		}
		return false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	var id int64
	if err = tx.QueryRow(ctx, `INSERT INTO credit_grants (account_id, source_key, original_nanos, available_nanos, expires_at)
		VALUES ($1, $2, $3, $3, $4) RETURNING id`, a.id, key, nanos, expiresAt).Scan(&id); err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO credit_events (account_id, grant_id, kind, available_delta_nanos) VALUES ($1, $2, $3, $4)`,
		a.id, id, kind, nanos)
	return true, err
}

// storedTime is t at PostgreSQL's microsecond precision.
func storedTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := t.Truncate(time.Microsecond)
	return &v
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}

// Balance is the spendable amount: unexpired available grants less debt.
// Credit held by open reservations is not spendable and is excluded.
func (l Ledger) Balance(ctx context.Context, accountID int64) (int64, error) {
	var n int64
	err := l.DB.QueryRow(ctx, `SELECT COALESCE((SELECT sum(available_nanos) FROM credit_grants
			WHERE account_id = a.id AND (expires_at IS NULL OR expires_at > now())), 0)::bigint - a.debt_nanos
		FROM credit_accounts a WHERE a.id = $1`, accountID).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("credit account %d: %w", accountID, ErrNotFound)
	}
	return n, err
}

// OwnerBalance reads an owner's balance without creating an account.
func (l Ledger) OwnerBalance(ctx context.Context, ownerType string, ownerID int64) (int64, error) {
	var id int64
	err := l.DB.QueryRow(ctx, `SELECT id FROM credit_accounts WHERE owner_type = $1 AND owner_id = $2`, ownerType, ownerID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return l.Balance(ctx, id)
}

// allotment is an id (grant or reservation) and an amount.
type allotment struct{ id, nanos int64 }

func collect(rows pgx.Rows) ([]allotment, error) {
	defer rows.Close()
	var out []allotment
	for rows.Next() {
		var a allotment
		if err := rows.Scan(&a.id, &a.nanos); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// spendable lists unexpired grants with credit, soonest expiry first.
func spendable(ctx context.Context, tx pgx.Tx, accountID int64) ([]allotment, error) {
	rows, err := tx.Query(ctx, `SELECT id, available_nanos FROM credit_grants
		WHERE account_id = $1 AND available_nanos > 0 AND (expires_at IS NULL OR expires_at > now())
		ORDER BY expires_at ASC NULLS LAST, id`, accountID)
	if err != nil {
		return nil, err
	}
	return collect(rows)
}

// Reserve atomically holds bound nanos for key, drawing from the grants that
// expire first. A retry with the same key and bound returns the existing
// reservation with Fresh false; a different bound is ErrConflict.
func (l Ledger) Reserve(ctx context.Context, accountID int64, key string, bound int64) (Reservation, error) {
	out := Reservation{AccountID: accountID}
	if key == "" || bound <= 0 {
		return out, errors.New("credits: reservation key and a positive bound required")
	}
	err := l.transaction(ctx, func(tx pgx.Tx) error {
		a, err := lockAccount(ctx, tx, accountID)
		if err != nil {
			return err
		}
		found, err := loadReservation(ctx, tx, accountID, key, &out)
		if err != nil {
			return err
		}
		if found {
			if out.ReservedNanos != bound {
				return ErrConflict
			}
			return nil
		}
		if a.disposition != "owned" {
			return ErrSealed
		}
		if err = l.settleAbandoned(ctx, tx, a); err != nil {
			return err
		}
		if err = expire(ctx, tx, accountID); err != nil {
			return err
		}
		if err = repayDebt(ctx, tx, accountID); err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `SELECT debt_nanos FROM credit_accounts WHERE id = $1`, accountID).Scan(&a.debt); err != nil {
			return err
		}
		if a.debt > 0 {
			return ErrInsufficient
		}
		grants, err := spendable(ctx, tx, accountID)
		if err != nil {
			return err
		}
		var available int64
		for _, g := range grants {
			available += g.nanos
		}
		if available < bound {
			return ErrInsufficient
		}
		if err = tx.QueryRow(ctx, `INSERT INTO credit_reservations (account_id, request_key, reserved_nanos) VALUES ($1, $2, $3) RETURNING id`,
			accountID, key, bound).Scan(&out.ID); err != nil {
			return err
		}
		out.ReservedNanos, out.Status, out.Fresh = bound, "reserved", true
		left := bound
		for _, g := range grants {
			if left == 0 {
				break
			}
			n := min(left, g.nanos)
			if _, err = tx.Exec(ctx, `UPDATE credit_grants SET available_nanos = available_nanos - $2 WHERE id = $1`, g.id, n); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO credit_reservation_grants (reservation_id, grant_id, reserved_nanos) VALUES ($1, $2, $3)`, out.ID, g.id, n); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO credit_events (account_id, grant_id, reservation_id, kind, available_delta_nanos) VALUES ($1, $2, $3, 'reserve', $4)`,
				accountID, g.id, out.ID, -n); err != nil {
				return err
			}
			left -= n
		}
		return nil
	})
	if err != nil {
		return Reservation{AccountID: accountID}, err
	}
	return out, nil
}

func loadReservation(ctx context.Context, tx pgx.Tx, accountID int64, key string, out *Reservation) (bool, error) {
	err := tx.QueryRow(ctx, `SELECT id, reserved_nanos, status, COALESCE(charged_nanos, 0) FROM credit_reservations
		WHERE account_id = $1 AND request_key = $2`, accountID, key).Scan(&out.ID, &out.ReservedNanos, &out.Status, &out.ChargedNanos)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (l Ledger) settleAbandoned(ctx context.Context, tx pgx.Tx, a lockedAccount) error {
	after := l.AbandonAfter
	if after <= 0 {
		after = DefaultAbandonAfter
	}
	rows, err := tx.Query(ctx, `SELECT id, reserved_nanos FROM credit_reservations
		WHERE account_id = $1 AND status = 'reserved' AND created_at < $2 ORDER BY id`, a.id, a.now.Add(-after))
	if err != nil {
		return err
	}
	open, err := collect(rows)
	if err != nil {
		return err
	}
	for _, r := range open {
		res := Reservation{ID: r.id, AccountID: a.id, ReservedNanos: r.nanos, Status: "reserved"}
		if err = settleLocked(ctx, tx, &res, r.nanos); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE credit_reservations SET abandoned = true WHERE id = $1`, r.id); err != nil {
			return err
		}
	}
	return nil
}

// Settle records the actual charge for key once. A replay with the same
// charge returns the finished reservation; a different charge is ErrConflict.
// A charge above the bound spends other available credit and records any
// remainder as debt, which blocks new reservations until repaid.
func (l Ledger) Settle(ctx context.Context, accountID int64, key string, charge int64) (Reservation, error) {
	out := Reservation{AccountID: accountID}
	if key == "" || charge < 0 {
		return out, errors.New("credits: settlement key and a non-negative charge required")
	}
	err := l.transaction(ctx, func(tx pgx.Tx) error {
		if _, err := lockAccount(ctx, tx, accountID); err != nil {
			return err
		}
		found, err := loadReservation(ctx, tx, accountID, key, &out)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("reservation %q: %w", key, ErrNotFound)
		}
		if out.Status != "reserved" {
			if out.ChargedNanos == charge {
				return nil
			}
			var abandoned bool
			if err = tx.QueryRow(ctx, `SELECT abandoned FROM credit_reservations WHERE id = $1`, out.ID).Scan(&abandoned); err != nil {
				return err
			}
			if !abandoned {
				return ErrConflict
			}
			if charge < out.ChargedNanos {
				// An abandoned call stays charged its bound.
				return nil
			}
			// The call outlived AbandonAfter and cost more than its bound.
			if err = addDebt(ctx, tx, accountID, &out.ID, "overage", charge-out.ChargedNanos); err != nil {
				return err
			}
			out.ChargedNanos = charge
			_, err = tx.Exec(ctx, `UPDATE credit_reservations SET charged_nanos = $2, abandoned = false WHERE id = $1`, out.ID, charge)
			return err
		}
		return settleLocked(ctx, tx, &out, charge)
	})
	return out, err
}

// Release returns a reservation whose provider call never charged.
func (l Ledger) Release(ctx context.Context, accountID int64, key string) (Reservation, error) {
	return l.Settle(ctx, accountID, key, 0)
}

// settleLocked finishes an open reservation. The caller holds the account lock.
func settleLocked(ctx context.Context, tx pgx.Tx, r *Reservation, charge int64) error {
	rows, err := tx.Query(ctx, `SELECT grant_id, reserved_nanos FROM credit_reservation_grants WHERE reservation_id = $1 ORDER BY grant_id`, r.ID)
	if err != nil {
		return err
	}
	held, err := collect(rows)
	if err != nil {
		return err
	}
	kind := "settle"
	if charge == 0 {
		kind = "release"
	}
	remaining := charge
	for _, g := range held {
		spent := min(remaining, g.nanos)
		refund := g.nanos - spent
		remaining -= spent
		if _, err = tx.Exec(ctx, `UPDATE credit_reservation_grants SET charged_nanos = $3 WHERE reservation_id = $1 AND grant_id = $2`, r.ID, g.id, spent); err != nil {
			return err
		}
		if refund > 0 {
			if _, err = tx.Exec(ctx, `UPDATE credit_grants SET available_nanos = available_nanos + $2 WHERE id = $1`, g.id, refund); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, `INSERT INTO credit_events (account_id, grant_id, reservation_id, kind, available_delta_nanos, spent_nanos)
			VALUES ($1, $2, $3, $4, $5, $6)`, r.AccountID, g.id, r.ID, kind, refund, spent); err != nil {
			return err
		}
	}
	if remaining > 0 {
		// Actual usage exceeded the bound: it is owed, never forgiven.
		if err = addDebt(ctx, tx, r.AccountID, &r.ID, "overage", remaining); err != nil {
			return err
		}
	}
	r.ChargedNanos, r.Status = charge, "settled"
	if charge == 0 {
		r.Status = "released"
	}
	if _, err = tx.Exec(ctx, `UPDATE credit_reservations SET charged_nanos = $2, status = $3, settled_at = now() WHERE id = $1`,
		r.ID, charge, r.Status); err != nil {
		return err
	}
	if err = expire(ctx, tx, r.AccountID); err != nil {
		return err
	}
	// A refund may land while earlier overage is owed.
	return repayDebt(ctx, tx, r.AccountID)
}

// addDebt records nanos owed and immediately repays what available credit covers.
func addDebt(ctx context.Context, tx pgx.Tx, accountID int64, reservationID *int64, kind string, nanos int64) error {
	if nanos <= 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE credit_accounts SET debt_nanos = debt_nanos + $2 WHERE id = $1`, accountID, nanos); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO credit_events (account_id, reservation_id, kind, available_delta_nanos, debt_delta_nanos)
		VALUES ($1, $2, $3, 0, $4)`, accountID, reservationID, kind, nanos); err != nil {
		return err
	}
	return repayDebt(ctx, tx, accountID)
}

// repayDebt spends unexpired available credit against debt, so debt and
// spendable credit never coexist. The caller holds the account lock.
func repayDebt(ctx context.Context, tx pgx.Tx, accountID int64) error {
	var debt int64
	if err := tx.QueryRow(ctx, `SELECT debt_nanos FROM credit_accounts WHERE id = $1`, accountID).Scan(&debt); err != nil || debt == 0 {
		return err
	}
	grants, err := spendable(ctx, tx, accountID)
	if err != nil {
		return err
	}
	for _, g := range grants {
		if debt == 0 {
			break
		}
		n := min(debt, g.nanos)
		if _, err = tx.Exec(ctx, `UPDATE credit_grants SET available_nanos = available_nanos - $2 WHERE id = $1`, g.id, n); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE credit_accounts SET debt_nanos = debt_nanos - $2 WHERE id = $1`, accountID, n); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO credit_events (account_id, grant_id, kind, available_delta_nanos, spent_nanos, debt_delta_nanos)
			VALUES ($1, $2, 'debt', $3, $4, $3)`, accountID, g.id, -n, n); err != nil {
			return err
		}
		debt -= n
	}
	return nil
}

// expire zeroes the account's expired grants. The caller holds the account lock.
func expire(ctx context.Context, tx pgx.Tx, accountID int64) error {
	rows, err := tx.Query(ctx, `SELECT id, available_nanos FROM credit_grants WHERE account_id = $1 AND expires_at <= now() AND available_nanos > 0`, accountID)
	if err != nil {
		return err
	}
	expired, err := collect(rows)
	if err != nil {
		return err
	}
	for _, g := range expired {
		if _, err = tx.Exec(ctx, `UPDATE credit_grants SET available_nanos = 0 WHERE id = $1`, g.id); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO credit_events (account_id, grant_id, kind, available_delta_nanos) VALUES ($1, $2, 'expire', $3)`,
			accountID, g.id, -g.nanos); err != nil {
			return err
		}
	}
	return nil
}
