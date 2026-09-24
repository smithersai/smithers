package commerce_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/stretchr/testify/require"
)

func TestHostedBillingWebhookClaimAndProjectionBecomeVisibleTogether(t *testing.T) {
	pool := database(t)
	owner := user(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := pool.Exec(ctx, `INSERT INTO billing_accounts
		(owner_type, owner_id, stripe_customer_id, stripe_customer_email)
		VALUES ('user', $1, 'cus_test', 'before@example.test')`, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		CREATE FUNCTION hold_billing_projection() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			PERFORM pg_advisory_xact_lock(811122);
			RETURN NEW;
		END $$;
		CREATE TRIGGER hold_billing_projection BEFORE UPDATE ON billing_accounts
		FOR EACH ROW EXECUTE FUNCTION hold_billing_projection()`)
	require.NoError(t, err)
	gate, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer gate.Rollback(context.Background())
	_, err = gate.Exec(ctx, `SELECT pg_advisory_xact_lock(811122)`)
	require.NoError(t, err)

	const secret = "test-only-webhook-key"
	payload := []byte(`{"id":"evt_atomic","type":"customer.updated","data":{"object":{"id":"cus_test","email":"after@example.test","name":"After"}}}`)
	now := time.Now().Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", now, payload)
	signature := fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil))
	service, err := commerce.New(pool, &payment{}, commerce.Config{Usage: admission.ProductUsage, WebhookSecret: secret})
	require.NoError(t, err)
	result := make(chan error, 1)
	go func() { result <- service.HandleStripeWebhook(ctx, payload, signature) }()
	// Stop the real projection statement after event claim, then observe it
	// from a different connection. The old hosted wrapper committed the claim
	// before the projection; a process crash at this point loses the event.
	for {
		var waiting int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event='advisory'
			AND $1::integer = ANY(pg_blocking_pids(pid))`, gate.Conn().PgConn().PID()).Scan(&waiting))
		if waiting == 1 {
			break
		}
		select {
		case err := <-result:
			t.Fatalf("webhook did not reach projection gate: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	var claims int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stripe_processed_events WHERE event_id='evt_atomic'`).Scan(&claims))
	require.Zero(t, claims, "a claimed event must not become durable before its projection")
	require.NoError(t, gate.Rollback(ctx))
	require.NoError(t, <-result)
	var email string
	require.NoError(t, pool.QueryRow(ctx, `SELECT stripe_customer_email FROM billing_accounts WHERE owner_id=$1`, owner).Scan(&email))
	require.Equal(t, "after@example.test", email)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stripe_processed_events WHERE event_id='evt_atomic'`).Scan(&claims))
	require.Equal(t, 1, claims)
	require.NoError(t, service.HandleStripeWebhook(ctx, payload, signature))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stripe_processed_events WHERE event_id='evt_atomic'`).Scan(&claims))
	require.Equal(t, 1, claims)
}
