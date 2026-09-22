package webhook

import (
	"context"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const defaultWebhookTestDatabaseURL = "postgres://smithers:smithers@localhost:5432/smithers_test_webhook?sslmode=disable"

var webhookTestPool *pgxpool.Pool
var webhookDBUnavailableReason string

// resolveWebhookTestDatabaseURL returns the database URL for webhook package tests.
// Precedence: SMITHERS_TEST_WEBHOOK_DATABASE_URL -> SMITHERS_TEST_DATABASE_URL -> default.
func resolveWebhookTestDatabaseURL(getenv func(string) string) string {
	if v := getenv("SMITHERS_TEST_WEBHOOK_DATABASE_URL"); v != "" {
		return v
	}
	if v := getenv("SMITHERS_TEST_DATABASE_URL"); v != "" {
		return v
	}
	return defaultWebhookTestDatabaseURL
}

func TestMain(m *testing.M) {
	flag.Parse()
	// Unit tests must not create or reset a database just because a local
	// PostgreSQL server happens to be reachable.
	if testing.Short() {
		os.Exit(m.Run())
	}
	databaseURL := resolveWebhookTestDatabaseURL(os.Getenv)

	parsed, err := url.Parse(databaseURL)
	if err != nil {
		webhookDBUnavailableReason = fmt.Sprintf("bad database URL: %v", err)
		code := m.Run()
		os.Exit(code)
	}
	dbName := strings.TrimPrefix(parsed.Path, "/")
	adminURL := *parsed
	adminURL.Path = "/postgres"
	adminConn, err := pgx.Connect(context.Background(), adminURL.String())
	if err != nil {
		webhookDBUnavailableReason = fmt.Sprintf("cannot connect to admin database: %v", err)
		code := m.Run()
		os.Exit(code)
	}
	var exists bool
	_ = adminConn.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, dbName).Scan(&exists)
	if !exists {
		_, _ = adminConn.Exec(context.Background(), `CREATE DATABASE "`+strings.ReplaceAll(dbName, `"`, `""`)+`"`)
	}
	adminConn.Close(context.Background())

	schemaBytes, err := os.ReadFile(findSchemaPath())
	if err != nil {
		webhookDBUnavailableReason = fmt.Sprintf("cannot read schema: %v", err)
		code := m.Run()
		os.Exit(code)
	}
	schemaConn, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		webhookDBUnavailableReason = fmt.Sprintf("cannot connect to test db for schema setup: %v", err)
		code := m.Run()
		os.Exit(code)
	}
	combined := `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;` + "\n" + string(schemaBytes)
	if _, err := schemaConn.Exec(context.Background(), combined); err != nil {
		webhookDBUnavailableReason = fmt.Sprintf("schema setup failed: %v", err)
		code := m.Run()
		os.Exit(code)
	}
	schemaConn.Close(context.Background())

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		webhookDBUnavailableReason = fmt.Sprintf("bad pool config: %v", err)
		code := m.Run()
		os.Exit(code)
	}
	cfg.MaxConns = 5
	cfg.MinConns = 1
	webhookTestPool, err = pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		webhookDBUnavailableReason = fmt.Sprintf("cannot create pool: %v", err)
		code := m.Run()
		os.Exit(code)
	}

	code := m.Run()
	webhookTestPool.Close()
	os.Exit(code)
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

func findSchemaPath() string {
	candidates := []string{
		filepath.Join("..", "..", "db", "schema.sql"),
		filepath.Join("db", "schema.sql"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return candidates[0]
}

func newWebhookQueries(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	if webhookTestPool == nil {
		t.Skipf("webhook integration DB unavailable: %s", webhookDBUnavailableReason)
	}
	truncateWebhookTables(t, webhookTestPool)
	return db.New(webhookTestPool), webhookTestPool
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
