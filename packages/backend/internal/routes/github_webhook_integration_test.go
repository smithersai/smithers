package routes

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const defaultGitHubWebhookRouteTestDatabaseURL = "postgres://smithers:smithers@127.0.0.1:5432/smithers_test_routes?sslmode=disable"

func TestGitHubWebhookHandler_PostGitHubWebhook_EndToEnd(t *testing.T) {
	pool := setupGitHubWebhookRouteTestPool(t)
	secret := "github-route-test-secret"
	handler := &GitHubWebhookHandler{
		Service: services.NewGitHubWebhookService(pool, secret),
	}

	pushBody := []byte(`{
		"ref":"refs/heads/main",
		"installation":{"id":9001},
		"repository":{"id":8001,"name":"demo","owner":{"login":"acme"}}
	}`)
	pushDeliveryID := "9f8c9f51-b3e4-47e7-bd2a-473f5f57ff31"

	// 1) Send a mock push webhook with valid signature -> 200 OK.
	rec := postGitHubWebhookForRouteTest(t, handler, "push", pushDeliveryID, pushBody, secret, "")
	require.Equal(t, http.StatusOK, rec.Code)

	// 2) Send a mock webhook with invalid signature -> 401.
	invalidSigDeliveryID := "7dbf1020-df6d-4680-8a6f-1585e36cd663"
	rec = postGitHubWebhookForRouteTest(t, handler, "push", invalidSigDeliveryID, pushBody, secret, "sha256=deadbeef")
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	installationCreatedBody := []byte(`{
		"action":"created",
		"installation":{
			"id":7777,
			"repository_selection":"selected",
			"account":{"login":"acme","type":"User"}
		},
		"repositories":[
			{"id":8001,"name":"demo","full_name":"acme/demo","private":false,"owner":{"login":"acme"}}
		]
	}`)
	rec = postGitHubWebhookForRouteTest(
		t,
		handler,
		"installation",
		"27ca2a43-599a-4311-bf7c-f3ebf2f0f5e2",
		installationCreatedBody,
		secret,
		"",
	)
	require.Equal(t, http.StatusOK, rec.Code)

	// 3) Send installation.created webhook -> installation stored in DB.
	var installationCount int
	err := pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM github_app_installations WHERE installation_id = 7777`).Scan(&installationCount)
	require.NoError(t, err)
	assert.Equal(t, 1, installationCount)

	var installationRepoCount int
	err = pool.QueryRow(
		context.Background(),
		`SELECT COUNT(*) FROM github_app_installation_repositories WHERE installation_id = 7777 AND github_repository_id = 8001`,
	).Scan(&installationRepoCount)
	require.NoError(t, err)
	assert.Equal(t, 1, installationRepoCount)

	installationDeletedBody := []byte(`{
		"action":"deleted",
		"installation":{"id":7777,"account":{"login":"acme","type":"User"}}
	}`)
	rec = postGitHubWebhookForRouteTest(
		t,
		handler,
		"installation",
		"15eb3cb6-f844-4df0-aa47-7f34fc56f2e9",
		installationDeletedBody,
		secret,
		"",
	)
	require.Equal(t, http.StatusOK, rec.Code)

	// 4) Send installation.deleted webhook -> installation removed.
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM github_app_installations WHERE installation_id = 7777`).Scan(&installationCount)
	require.NoError(t, err)
	assert.Equal(t, 0, installationCount)
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM github_app_installation_repositories WHERE installation_id = 7777`).Scan(&installationRepoCount)
	require.NoError(t, err)
	assert.Equal(t, 0, installationRepoCount)

	featurePushBody := []byte(`{
		"ref":"refs/heads/feature",
		"installation":{"id":9001},
		"repository":{"id":8001,"name":"demo","owner":{"login":"acme"}}
	}`)
	rec = postGitHubWebhookForRouteTest(t, handler, "push", "0f76ee7f-a95e-4f4a-b3f3-318d4cccf868", featurePushBody, secret, "")
	require.Equal(t, http.StatusOK, rec.Code)

	// 5) Send push webhook -> event appears in job queue. Jobs are keyed by a
	// dedup id derived from the HMAC-signed body (not the unsigned
	// X-GitHub-Delivery header), so look the job up by its payload.
	pushJobCountByRef := func(ref string) int {
		t.Helper()
		var count int
		err := pool.QueryRow(
			context.Background(),
			`SELECT COUNT(*)
			 FROM github_webhook_jobs
			 WHERE event_type = 'push'
			   AND payload->>'ref' = $1`,
			ref,
		).Scan(&count)
		require.NoError(t, err)
		return count
	}
	assert.Equal(t, 1, pushJobCountByRef("refs/heads/feature"))

	// 6) Replaying the same signed payload under a fresh delivery id is
	// detected as a duplicate: 200 OK, but no second job row.
	rec = postGitHubWebhookForRouteTest(t, handler, "push", "b7d5f0aa-1d0e-4a3c-9a5f-2c6f0d9e4b11", featurePushBody, secret, "")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, pushJobCountByRef("refs/heads/feature"))
}

func postGitHubWebhookForRouteTest(
	t *testing.T,
	handler *GitHubWebhookHandler,
	eventType string,
	deliveryID string,
	body []byte,
	secret string,
	overrideSignature string,
) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", bytes.NewReader(body))
	req.Header.Set(gitHubWebhookEventHeader, eventType)
	req.Header.Set(gitHubWebhookDeliveryHeader, deliveryID)

	signature := overrideSignature
	if strings.TrimSpace(signature) == "" {
		signature = signRouteGitHubWebhookBody(body, secret)
	}
	req.Header.Set(gitHubWebhookSignatureHeader, signature)

	rec := httptest.NewRecorder()
	handler.PostGitHubWebhook(rec, req)
	return rec
}

func setupGitHubWebhookRouteTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	if testing.Short() {
		t.Skip("skipping DB integration test in short mode")
	}

	pool, err := resetGitHubWebhookRouteTestDatabase(gitHubWebhookRouteTestDatabaseURL())
	if err != nil {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatalf("required routes database unavailable: %v", err)
		}
		t.Skipf("skipping DB integration test: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

func gitHubWebhookRouteTestDatabaseURL() string {
	if v := strings.TrimSpace(os.Getenv("SMITHERS_ROUTES_TEST_DATABASE_URL")); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("SMITHERS_TEST_DATABASE_URL")); v != "" {
		return v
	}
	return defaultGitHubWebhookRouteTestDatabaseURL
}

func resetGitHubWebhookRouteTestDatabase(databaseURL string) (*pgxpool.Pool, error) {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("bad database URL: %w", err)
	}

	dbName := strings.TrimPrefix(parsed.Path, "/")
	adminURL := *parsed
	adminURL.Path = "/postgres"

	adminConn, err := pgx.Connect(context.Background(), adminURL.String())
	if err != nil {
		return nil, fmt.Errorf("cannot connect to admin database: %w", err)
	}
	defer adminConn.Close(context.Background())

	var exists bool
	if err := adminConn.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, dbName).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check database existence: %w", err)
	}
	if !exists {
		if _, err := adminConn.Exec(context.Background(), `CREATE DATABASE "`+strings.ReplaceAll(dbName, `"`, `""`)+`"`); err != nil {
			return nil, fmt.Errorf("create database: %w", err)
		}
	}

	schemaBytes, err := os.ReadFile(findGitHubWebhookRouteSchemaPath())
	if err != nil {
		return nil, fmt.Errorf("read schema: %w", err)
	}

	schemaConn, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect to test database: %w", err)
	}
	defer schemaConn.Close(context.Background())

	if _, err := schemaConn.Exec(context.Background(), `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`); err != nil {
		return nil, fmt.Errorf("terminate existing connections: %w", err)
	}

	combined := `DROP SCHEMA IF EXISTS plue_storage CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;` + "\n" + string(schemaBytes)
	if _, err := schemaConn.Exec(context.Background(), combined); err != nil {
		return nil, fmt.Errorf("reset schema: %w", err)
	}

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("bad pool config: %w", err)
	}

	return pgxpool.NewWithConfig(context.Background(), cfg)
}

func findGitHubWebhookRouteSchemaPath() string {
	candidates := []string{
		filepath.Join("..", "..", "db", "cluster", "sqlc_schema.sql"),
		filepath.Join("db", "cluster", "sqlc_schema.sql"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return candidates[0]
}

func signRouteGitHubWebhookBody(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
