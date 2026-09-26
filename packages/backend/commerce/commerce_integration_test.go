package commerce_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

var _ routes.BillingRouteService = (commerce.Routes)(nil)
var _ commerce.Routes = (routes.BillingRouteService)(nil)

func database(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	// Concurrent admission cases hold more connections than the default pool.
	pool, err := postgresfixture.Open(ctx, testdb.New(t).URL, 8)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
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
