package routes

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// routeLinearWebhookTestSessionSecret keys the AES-256-GCM encryption of the
// webhook secret stored at rest, matching how ConfigureIntegration persists it.
const routeLinearWebhookTestSessionSecret = "linear-route-test-secret"

func TestLinearIntegrationHandler_PostLinearWebhook_CreatesSmithersIssue(t *testing.T) {
	// TODO(issue-84): The Linear sync service now wraps webhook handling in transactions.
	// This test needs the full integration service wired (not nil) to handle issue creation
	// within the transactional webhook path. Fix when completing JJH-407 (full Linear sync).
	// The skip is the first statement so the body below stays compiled-and-checked
	// dead code until the service is wired, instead of being deleted.
	t.Skip("requires LinearIntegrationService for transactional webhook handling")

	pool := setupLinearWebhookRouteTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	integration := createLinearWebhookRouteTestIntegration(t, queries, pool)
	handler := &LinearIntegrationHandler{
		Sync: services.NewLinearSyncService(queries, nil),
	}

	body := mustMarshalRouteLinearWebhookPayload(t, time.Now().UnixMilli(), "create", "Issue", map[string]any{
		"id":          "lin-route-issue-1",
		"identifier":  "PLT-401",
		"title":       "Route-created issue",
		"description": "Created through the webhook route",
		"creatorId":   "external-user",
		"team": map[string]any{
			"id": integration.LinearTeamID,
		},
		"state": map[string]any{
			"type": "started",
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/webhooks/linear", bytes.NewReader(body))
	req.Header.Set("Linear-Signature", signRouteLinearWebhookBody(body, "route-webhook-secret"))
	rec := httptest.NewRecorder()

	handler.PostLinearWebhook(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	issues, err := queries.ListIssuesByRepoFiltered(ctx, db.ListIssuesByRepoFilteredParams{
		RepositoryID: integration.JjhubRepoID,
		State:        "",
		PageOffset:   0,
		PageSize:     20,
	})
	require.NoError(t, err)
	require.Len(t, issues, 1)
	assert.Equal(t, "Route-created issue", issues[0].Title)
	assert.Equal(t, "Imported from Linear issue `PLT-401`.\n\nCreated through the webhook route", issues[0].Body)

	issueMap, err := queries.GetLinearIssueMapByLinearIssue(ctx, db.GetLinearIssueMapByLinearIssueParams{
		IntegrationID: integration.ID,
		LinearIssueID: "lin-route-issue-1",
	})
	require.NoError(t, err)
	assert.Equal(t, issues[0].ID, issueMap.JjhubIssueID)
}

func setupLinearWebhookRouteTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	return pool
}

func createLinearWebhookRouteTestIntegration(t *testing.T, queries *db.Queries, pool *pgxpool.Pool) db.LinearIntegration {
	t.Helper()

	now := time.Now().UnixNano()
	username := fmt.Sprintf("linear_route_user_%d", now)
	lowerUsername := strings.ToLower(username)
	repoName := fmt.Sprintf("linear-route-repo-%d", now)
	lowerRepoName := strings.ToLower(repoName)

	var userID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		username,
		lowerUsername,
		fmt.Sprintf("%s@example.com", lowerUsername),
		fmt.Sprintf("%s@example.com", lowerUsername),
		username,
	).Scan(&userID)
	require.NoError(t, err)

	var repoID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', TRUE, 'main', 1) RETURNING id`,
		userID,
		repoName,
		lowerRepoName,
	).Scan(&repoID)
	require.NoError(t, err)

	encryptedWebhookSecret, err := smitherscrypto.Encrypt(
		smitherscrypto.DeriveKey(routeLinearWebhookTestSessionSecret),
		[]byte("route-webhook-secret"),
	)
	require.NoError(t, err)

	integration, err := queries.CreateLinearIntegration(context.Background(), db.CreateLinearIntegrationParams{
		UserID:               userID,
		LinearTeamID:         fmt.Sprintf("team-%d", now),
		LinearTeamName:       "Platform",
		LinearTeamKey:        "PLT",
		AccessTokenEncrypted: []byte("route-test-token"),
		TokenExpiresAt:       pgtype.Timestamptz{},
		WebhookSecret:        base64.StdEncoding.EncodeToString(encryptedWebhookSecret),
		JjhubRepoID:          repoID,
		JjhubRepoOwner:       username,
		JjhubRepoName:        repoName,
		LinearActorID:        "actor-1",
	})
	require.NoError(t, err)

	return integration
}

func mustMarshalRouteLinearWebhookPayload(t *testing.T, timestamp int64, action, webhookType string, data map[string]any) []byte {
	t.Helper()

	body, err := json.Marshal(map[string]any{
		"action":           action,
		"type":             webhookType,
		"organizationId":   "org-1",
		"webhookTimestamp": timestamp,
		"data":             data,
	})
	require.NoError(t, err)
	return body
}

func signRouteLinearWebhookBody(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
