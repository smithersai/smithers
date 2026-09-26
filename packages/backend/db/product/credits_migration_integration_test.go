package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Migration 0027 carries integer-cent balances into the exact ledger without
// losing or inventing value, keeps granted months idempotent, and retires the
// cent balance table.
func TestExactCreditsMigrationCarriesCentBalances(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var err error

	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `CREATE TABLE public.smithers_product_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, m := range registered {
		if m.version >= 27 {
			break
		}
		if _, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration %d: %v", m.version, err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO public.smithers_product_migrations (version, checksum) VALUES ($1, $2)`, m.version, m.checksum); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO billing_accounts (id, owner_type, owner_id, stripe_customer_id) VALUES
			(1, 'user', 10, 'cus_a'), (2, 'user', 11, 'cus_b'), (3, 'org', 12, 'cus_c'), (4, 'user', 13, 'cus_d');
		INSERT INTO billing_credit_balances (billing_account_id, balance_cents) VALUES (1, 1234), (2, -56), (3, 0);
		INSERT INTO billing_credit_ledger (billing_account_id, amount_cents, balance_after_cents, category, idempotency_key) VALUES
			(1, 1000, 1000, 'monthly_grant', 'monthly_grant:2026-08'),
			(1, 1000, 2000, 'monthly_grant', 'monthly_grant:2026-09'),
			(1, -766, 1234, 'deduction', 'model_usage:1'),
			(4, 1000, 1000, 'monthly_grant', 'monthly_grant:2026-09');`); err != nil {
		t.Fatal(err)
	}
	if err = Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}

	balance := func(ownerType string, ownerID int64) (available, debt int64) {
		t.Helper()
		if err := pool.QueryRow(ctx, `SELECT COALESCE((SELECT sum(available_nanos) FROM credit_grants WHERE account_id = a.id), 0)::bigint, a.debt_nanos
			FROM credit_accounts a WHERE owner_type = $1 AND owner_id = $2`, ownerType, ownerID).Scan(&available, &debt); err != nil {
			t.Fatalf("%s:%d: %v", ownerType, ownerID, err)
		}
		return available, debt
	}
	if a, d := balance("user", 10); a != 1234*10_000_000 || d != 0 {
		t.Fatalf("positive carry available=%d debt=%d", a, d)
	}
	if a, d := balance("user", 11); a != 0 || d != 56*10_000_000 {
		t.Fatalf("negative carry available=%d debt=%d", a, d)
	}
	if a, d := balance("org", 12); a != 0 || d != 0 {
		t.Fatalf("zero carry available=%d debt=%d", a, d)
	}
	var markers int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM credit_grants WHERE source_key LIKE 'monthly_grant:%' AND original_nanos = 10000000000 AND available_nanos = 0`).Scan(&markers); err != nil || markers != 3 {
		t.Fatalf("monthly markers=%d err=%v", markers, err)
	}
	var retired bool
	if err = pool.QueryRow(ctx, `SELECT to_regclass('public.billing_credit_balances') IS NULL AND to_regclass('pg_temp.carried_cents') IS NULL`).Scan(&retired); err != nil || !retired {
		t.Fatalf("cent balance table retired=%v err=%v", retired, err)
	}
	var history int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM billing_credit_ledger`).Scan(&history); err != nil || history != 4 {
		t.Fatalf("audit history rows=%d err=%v", history, err)
	}
}
