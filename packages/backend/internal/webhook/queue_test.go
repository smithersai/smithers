package webhook

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// webhookSuite is this test binary's own product database.
var webhookSuite = postgresfixture.Suite{MaxConns: 5}

func TestMain(m *testing.M) {
	os.Exit(webhookSuite.Run(m))
}

func TestPollQueue_SkipsLockedRows(t *testing.T) {
	q, pool := newWebhookQueries(t)

	ownerID := mustCreateWebhookUser(t, pool, "queue-owner")
	repoID := mustCreateWebhookRepo(t, pool, ownerID, "queue-repo")
	webhookID := mustCreateWebhook(t, q, repoID)
	first := mustCreateDelivery(t, q, webhookID)
	second := mustCreateDelivery(t, q, webhookID)

	tx, err := pool.Begin(context.Background())
	require.NoError(t, err)
	defer tx.Rollback(context.Background())

	var lockedID int64
	err = tx.QueryRow(context.Background(), `SELECT id FROM webhook_deliveries WHERE id = $1 FOR UPDATE`, first.ID).Scan(&lockedID)
	require.NoError(t, err)

	tasks, err := PollQueue(context.Background(), q, 2)
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	assert.Equal(t, second.ID, tasks[0].Delivery.ID)
	assert.Equal(t, webhookID, tasks[0].Webhook.ID)

	var firstAttempts int32
	err = pool.QueryRow(context.Background(), `SELECT attempts FROM webhook_deliveries WHERE id = $1`, first.ID).Scan(&firstAttempts)
	require.NoError(t, err)
	assert.Equal(t, int32(0), firstAttempts)

	var secondAttempts int32
	err = pool.QueryRow(context.Background(), `SELECT attempts FROM webhook_deliveries WHERE id = $1`, second.ID).Scan(&secondAttempts)
	require.NoError(t, err)
	assert.Equal(t, int32(1), secondAttempts)
}

// A backlog for one webhook must not monopolize a claim: the claim takes the
// oldest due delivery of every webhook before a second delivery of any one
// webhook, so a burst to a slow receiver cannot starve other tenants.
func TestPollQueue_ClaimsRoundRobinAcrossWebhooks(t *testing.T) {
	q, pool := newWebhookQueries(t)

	ownerID := mustCreateWebhookUser(t, pool, "fair-owner")
	repoID := mustCreateWebhookRepo(t, pool, ownerID, "fair-repo")
	burstWebhookID := mustCreateWebhook(t, q, repoID)
	otherWebhookID := mustCreateWebhook(t, q, repoID)
	thirdWebhookID := mustCreateWebhook(t, q, repoID)

	burst := make([]db.WebhookDelivery, 0, 5)
	for i := 0; i < 5; i++ {
		burst = append(burst, mustCreateDelivery(t, q, burstWebhookID))
	}
	other := mustCreateDelivery(t, q, otherWebhookID)
	third := mustCreateDelivery(t, q, thirdWebhookID)

	tasks, err := PollQueue(context.Background(), q, 4)
	require.NoError(t, err)

	claimed := make([]int64, 0, len(tasks))
	for _, task := range tasks {
		claimed = append(claimed, task.Delivery.ID)
	}
	assert.ElementsMatch(t, []int64{burst[0].ID, burst[1].ID, other.ID, third.ID}, claimed)
}

func TestUpdateTaskStatus_SetsRetryAndFinalFailure(t *testing.T) {
	q, pool := newWebhookQueries(t)
	ctx := context.Background()

	ownerID := mustCreateWebhookUser(t, pool, "status-owner")
	repoID := mustCreateWebhookRepo(t, pool, ownerID, "status-repo")
	webhookID := mustCreateWebhook(t, q, repoID)

	retryDelivery := mustCreateDelivery(t, q, webhookID)
	mustSetDeliveryAttempts(t, pool, retryDelivery.ID, 1)

	err := UpdateTaskStatus(ctx, q, Task{
		Delivery: db.WebhookDelivery{ID: retryDelivery.ID, WebhookID: webhookID, Attempts: 1},
		Webhook:  db.Webhook{ID: webhookID},
	}, DeliveryResult{StatusCode: 500, ResponseBody: "boom", Err: assert.AnError}, time.Date(2026, time.February, 22, 9, 0, 0, 0, time.UTC), nil)
	require.NoError(t, err)

	var status string
	var responseStatus pgtype.Int4
	var responseBody string
	var nextRetryAt pgtype.Timestamptz
	err = pool.QueryRow(ctx, `SELECT status, response_status, response_body, next_retry_at FROM webhook_deliveries WHERE id = $1`, retryDelivery.ID).
		Scan(&status, &responseStatus, &responseBody, &nextRetryAt)
	require.NoError(t, err)
	assert.Equal(t, "pending", status)
	assert.True(t, responseStatus.Valid)
	assert.Equal(t, int32(500), responseStatus.Int32)
	assert.Equal(t, "boom", responseBody)
	assert.True(t, nextRetryAt.Valid)
	assert.Equal(t, time.Date(2026, time.February, 22, 9, 0, 1, 0, time.UTC), nextRetryAt.Time.UTC())

	for i := 0; i < 9; i++ {
		d := mustCreateDelivery(t, q, webhookID)
		mustMarkDeliveryFailed(t, pool, d.ID)
	}
	finalDelivery := mustCreateDelivery(t, q, webhookID)
	mustSetDeliveryAttempts(t, pool, finalDelivery.ID, 4)

	err = UpdateTaskStatus(ctx, q, Task{
		Delivery: db.WebhookDelivery{ID: finalDelivery.ID, WebhookID: webhookID, Attempts: 4},
		Webhook:  db.Webhook{ID: webhookID},
	}, DeliveryResult{StatusCode: 502, ResponseBody: "bad gateway", Err: assert.AnError}, time.Now().UTC(), nil)
	require.NoError(t, err)

	err = pool.QueryRow(ctx, `SELECT status FROM webhook_deliveries WHERE id = $1`, finalDelivery.ID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "failed", status)

	var isActive bool
	err = pool.QueryRow(ctx, `SELECT is_active FROM webhooks WHERE id = $1`, webhookID).Scan(&isActive)
	require.NoError(t, err)
	assert.False(t, isActive)
}

func newWebhookQueries(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	pool := webhookSuite.Pool(t)
	truncateWebhookTables(t, pool)
	return db.New(pool), pool
}

func truncateWebhookTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	_, err := pool.Exec(context.Background(), `
		TRUNCATE
			webhook_deliveries,
			webhooks,
			repositories,
			users
		RESTART IDENTITY CASCADE
	`)
	require.NoError(t, err)
}

func mustCreateWebhookUser(t *testing.T, pool *pgxpool.Pool, username string) int64 {
	t.Helper()

	lowerUsername := strings.ToLower(username)
	lowerEmail := lowerUsername + "@example.com"

	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		username,
		lowerUsername,
		username+"@example.com",
		lowerEmail,
		username,
	).Scan(&id)
	require.NoError(t, err)

	return id
}

func mustCreateWebhookRepo(t *testing.T, pool *pgxpool.Pool, userID int64, name string) int64 {
	t.Helper()

	lowerName := strings.ToLower(name)

	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', TRUE, 'main', 1) RETURNING id`,
		userID,
		name,
		lowerName,
	).Scan(&id)
	require.NoError(t, err)

	return id
}

func mustCreateWebhook(t *testing.T, q *db.Queries, repoID int64) int64 {
	t.Helper()

	hook, err := q.CreateWebhook(context.Background(), db.CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/hook",
		Secret:       "secret",
		Events:       []string{"landing_request"},
		IsActive:     true,
	})
	require.NoError(t, err)
	return hook.ID
}

func mustCreateDelivery(t *testing.T, q *db.Queries, webhookID int64) db.WebhookDelivery {
	t.Helper()

	d, err := q.CreateWebhookDelivery(context.Background(), db.CreateWebhookDeliveryParams{
		WebhookID: webhookID,
		EventType: "landing_request",
		Payload:   []byte(`{"action":"opened"}`),
		Status:    "pending",
	})
	require.NoError(t, err)
	return d
}

func mustSetDeliveryAttempts(t *testing.T, pool *pgxpool.Pool, deliveryID int64, attempts int32) {
	t.Helper()

	_, err := pool.Exec(context.Background(), `UPDATE webhook_deliveries SET attempts = $2 WHERE id = $1`, deliveryID, attempts)
	require.NoError(t, err)
}

func mustMarkDeliveryFailed(t *testing.T, pool *pgxpool.Pool, deliveryID int64) {
	t.Helper()

	_, err := pool.Exec(context.Background(), `
		UPDATE webhook_deliveries
		SET status = 'failed', response_status = 500, response_body = 'boom', delivered_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, deliveryID)
	require.NoError(t, err)
}
