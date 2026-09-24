package commerce_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
	"os"
	"strings"
	"testing"
	"time"
)

var _ routes.BillingRouteService = (commerce.Routes)(nil)
var _ commerce.Routes = (routes.BillingRouteService)(nil)

func database(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SMITHERS_ADMISSION_TEST_ADMIN_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_ADMISSION_TEST_ADMIN_URL is required")
		}
		t.Skip("SMITHERS_ADMISSION_TEST_ADMIN_URL is not configured")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	require.NoError(t, err)
	name := "admission_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err)
	cfg, err := pgxpool.ParseConfig(raw)
	require.NoError(t, err)
	cfg.ConnConfig.Database = name
	cfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(func() {
		pool.Close()
		_, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
		require.NoError(t, err)
		require.NoError(t, admin.Close(ctx))
	})
	require.NoError(t, product.Apply(ctx, pool))
	return pool
}

func user(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	var id int64
	name := "u" + strings.ReplaceAll(uuid.NewString(), "-", "")
	require.NoError(t, pool.QueryRow(context.Background(), `INSERT INTO users
		(username, lower_username, email, lower_email, display_name)
		VALUES ($1::text, $1::text, $1::text || '@example.test', $1::text || '@example.test', $1::text) RETURNING id`, name).Scan(&id))
	return id
}

// Only the external payment transport is substituted; projection, SQL, and
// worker admission below are the real shared implementation.
type payment struct {
	commerce.Client
	status string
	calls  int
}

func (p *payment) GetSubscription(context.Context, string) (commerce.SubscriptionSnapshot, error) {
	p.calls++
	return commerce.SubscriptionSnapshot{ID: "sub_test", CustomerID: "cus_test", PriceID: "price_pro", Interval: "monthly", Status: p.status, Quantity: 1, RawPayload: []byte(`{}`)}, nil
}

func TestCommerceProjectionChangesExistingKeyFreeWorkerPolicy(t *testing.T) {
	pool := database(t)
	ctx := context.Background()
	owner := user(t, pool)
	prices := admission.Prices{ProMonthly: "price_pro"}
	worker, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage, Prices: prices})
	require.NoError(t, err)
	before, err := worker.SandboxEntitlement(ctx, owner)
	require.NoError(t, err)
	require.Equal(t, int64(1), before.ConcurrentSandboxes)
	transport := &payment{status: "active"}
	const secret = "test-only-api-webhook-secret"
	api, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, Prices: prices, WebhookSecret: secret})
	require.NoError(t, err)
	require.True(t, api.Capabilities().Checkout)
	deliver := func(event string) {
		payload := []byte(fmt.Sprintf(`{"id":%q,"type":"customer.subscription.updated","data":{"object":{"id":"sub_test","customer":"cus_test","metadata":{"owner_type":"user","owner_id":%q}}}}`, event, fmt.Sprint(owner)))
		now := time.Now().Unix()
		mac := hmac.New(sha256.New, []byte(secret))
		fmt.Fprintf(mac, "%d.%s", now, payload)
		require.NoError(t, api.HandleStripeWebhook(ctx, payload, fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil))))
	}
	deliver("evt_paid")
	paid, err := worker.SandboxEntitlement(ctx, owner)
	require.NoError(t, err)
	require.Equal(t, "pro", paid.PlanKey)
	require.Equal(t, int64(3), paid.ConcurrentSandboxes)
	calls := transport.calls
	_, err = worker.SandboxEntitlement(ctx, owner)
	require.NoError(t, err)
	require.Equal(t, calls, transport.calls, "worker decisions never invoke the payment transport")
	transport.status = "canceled"
	deliver("evt_canceled")
	canceled, err := worker.SandboxEntitlement(ctx, owner)
	require.NoError(t, err)
	require.Equal(t, int64(1), canceled.ConcurrentSandboxes, "same worker policy must observe durable cancellation")
	noCheckout, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, WebhookSecret: secret})
	require.NoError(t, err)
	require.False(t, noCheckout.Capabilities().Checkout)
	require.True(t, noCheckout.Capabilities().Webhook)
}
