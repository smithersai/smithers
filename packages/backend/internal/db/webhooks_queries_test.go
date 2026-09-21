package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateAndUpdateWebhookDelivery(t *testing.T) {
	q, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "webhook-owner")
	repoID := mustCreateRepo(t, pool, ownerID, "webhook-repo")

	hook, err := q.CreateWebhook(context.Background(), CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/hook",
		Secret:       "secret",
		Events:       []string{"landing_request", "workflow_run"},
		IsActive:     true,
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, hook.RepositoryID)

	delivery, err := q.CreateWebhookDelivery(context.Background(), CreateWebhookDeliveryParams{
		WebhookID: hook.ID,
		EventType: "landing_request",
		Payload:   []byte(`{"action":"opened"}`),
		Status:    "pending",
	})
	require.NoError(t, err)

	err = q.UpdateWebhookDeliveryResult(context.Background(), UpdateWebhookDeliveryResultParams{
		ID:             delivery.ID,
		Status:         "success",
		ResponseStatus: pgtype.Int4{Int32: 200, Valid: true},
		ResponseBody:   "ok",
	})
	require.NoError(t, err)

	var status string
	err = pool.QueryRow(context.Background(), `SELECT status FROM webhook_deliveries WHERE id = $1`, delivery.ID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "success", status)
}

func TestListAndUpdateWebhooksByRepo(t *testing.T) {
	q, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "webhook-owner-two")
	repoID := mustCreateRepo(t, pool, ownerID, "webhook-repo-two")

	hook, err := q.CreateWebhook(context.Background(), CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/hook",
		Secret:       "secret",
		Events:       []string{"push"},
		IsActive:     false,
	})
	require.NoError(t, err)

	list, err := q.ListWebhooksByRepo(context.Background(), repoID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, hook.ID, list[0].ID)

	updated, err := q.UpdateWebhookByID(context.Background(), UpdateWebhookByIDParams{
		RepositoryID: repoID,
		ID:           hook.ID,
		Url:          hook.Url,
		Secret:       "updated-secret",
		Events:       []string{"push", "workflow_run"},
		IsActive:     true,
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"push", "workflow_run"}, updated.Events)
	assert.True(t, updated.IsActive)
	assert.Equal(t, "updated-secret", updated.Secret)
}
