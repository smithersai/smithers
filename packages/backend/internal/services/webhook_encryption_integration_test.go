package services

import (
	"context"
	"encoding/base64"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func createWebhookEncryptionIntegrationRepoAndActor(t *testing.T, pool db.DBTX) (owner, repo string, actor *db.User) {
	t.Helper()

	ctx := context.Background()
	seq := time.Now().UnixNano()
	owner = fmt.Sprintf("webhookintowner%d", seq)
	repo = fmt.Sprintf("webhookintrepo%d", seq)
	email := fmt.Sprintf("%s@example.com", owner)

	var userID int64
	err := pool.QueryRow(
		ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		owner,
		owner,
		email,
		email,
		"Webhook Integration User",
	).Scan(&userID)
	require.NoError(t, err)

	_, err = pool.Exec(
		ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number)
		 VALUES ($1, $2, $3, '', TRUE, 'main', 1, 1)`,
		userID,
		repo,
		repo,
	)
	require.NoError(t, err)

	return owner, repo, &db.User{ID: userID, Username: owner}
}

func TestWebhookService_Integration_EncryptsAtRestAndRedactsListResponses(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	owner, repo, actor := createWebhookEncryptionIntegrationRepoAndActor(t, pool)

	codec, err := webhook.NewSecretCodec("integration-webhook-master-key")
	require.NoError(t, err)

	svc := NewWebhookService(queries, codec)
	const plaintextSecret = "integration-webhook-secret"

	created, err := svc.CreateWebhook(context.Background(), actor, owner, repo, CreateWebhookInput{
		URL:      "https://example.com/webhook",
		Secret:   plaintextSecret,
		Events:   []string{"push"},
		IsActive: true,
	})
	require.NoError(t, err)
	assert.Equal(t, plaintextSecret, created.Secret)

	var rawStoredSecret string
	err = pool.QueryRow(context.Background(), `SELECT secret FROM webhooks WHERE id = $1`, created.ID).Scan(&rawStoredSecret)
	require.NoError(t, err)
	assert.NotEqual(t, plaintextSecret, rawStoredSecret)
	_, decodeErr := base64.StdEncoding.DecodeString(rawStoredSecret)
	assert.NoError(t, decodeErr)

	loaded, err := svc.GetWebhook(context.Background(), actor, owner, repo, created.ID)
	require.NoError(t, err)
	assert.Equal(t, plaintextSecret, loaded.Secret)

	hooks, err := svc.ListWebhooks(context.Background(), actor, owner, repo)
	require.NoError(t, err)
	require.Len(t, hooks, 1)
	assert.Equal(t, redactedWebhookSecret, hooks[0].Secret)
}
