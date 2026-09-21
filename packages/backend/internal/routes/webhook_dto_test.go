package routes

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestMaskWebhookSecret_NonEmpty(t *testing.T) {
	assert.Equal(t, "********", maskWebhookSecret("my-secret"))
}

func TestMaskWebhookSecret_AnyNonEmpty(t *testing.T) {
	cases := []string{"x", "short", "a-very-long-secret-value-1234567890"}
	for _, s := range cases {
		assert.Equal(t, "********", maskWebhookSecret(s), "secret %q should be masked", s)
	}
}

func TestMaskWebhookSecret_Empty(t *testing.T) {
	assert.Equal(t, "", maskWebhookSecret(""))
}

func TestToWebhookResponse_MasksSecret(t *testing.T) {
	now := time.Now()
	w := db.Webhook{
		ID:             1,
		RepositoryID:   10,
		Url:            "https://example.com/webhook",
		Secret:         "my-plaintext-secret",
		Events:         []string{"push", "issues"},
		IsActive:       true,
		LastDeliveryAt: pgtype.Timestamptz{Time: now, Valid: true},
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	resp := toWebhookResponse(w)

	assert.Equal(t, w.ID, resp.ID)
	assert.Equal(t, w.RepositoryID, resp.RepositoryID)
	assert.Equal(t, w.Url, resp.URL)
	assert.Equal(t, "********", resp.Secret, "non-empty secret must be masked")
	assert.Equal(t, w.Events, resp.Events)
	assert.Equal(t, w.IsActive, resp.IsActive)
	assert.Equal(t, w.LastDeliveryAt, resp.LastDeliveryAt)
	assert.Equal(t, w.CreatedAt, resp.CreatedAt)
	assert.Equal(t, w.UpdatedAt, resp.UpdatedAt)
}

func TestToWebhookResponse_EmptySecret(t *testing.T) {
	w := db.Webhook{
		ID:     2,
		Url:    "https://example.com/webhook",
		Secret: "",
	}

	resp := toWebhookResponse(w)

	assert.Equal(t, "", resp.Secret, "empty secret must stay empty (not masked)")
}

func TestToWebhookResponse_PreservesAllFields(t *testing.T) {
	now := time.Now()
	w := db.Webhook{
		ID:             42,
		RepositoryID:   99,
		Url:            "https://hooks.example.com/smithers",
		Secret:         "supersecret",
		Events:         []string{"push", "pull_request", "issues"},
		IsActive:       false,
		LastDeliveryAt: pgtype.Timestamptz{Time: now.Add(-time.Hour), Valid: true},
		CreatedAt:      now.Add(-24 * time.Hour),
		UpdatedAt:      now,
	}

	resp := toWebhookResponse(w)

	require.Equal(t, int64(42), resp.ID)
	require.Equal(t, int64(99), resp.RepositoryID)
	require.Equal(t, "https://hooks.example.com/smithers", resp.URL)
	require.Equal(t, "********", resp.Secret)
	require.Equal(t, []string{"push", "pull_request", "issues"}, resp.Events)
	require.False(t, resp.IsActive)
	require.Equal(t, w.LastDeliveryAt, resp.LastDeliveryAt)
	require.Equal(t, w.CreatedAt, resp.CreatedAt)
	require.Equal(t, w.UpdatedAt, resp.UpdatedAt)
}

func TestToWebhookResponseList_MasksAllSecrets(t *testing.T) {
	now := time.Now()
	webhooks := []db.Webhook{
		{ID: 1, RepositoryID: 10, Url: "https://a.com/hook", Secret: "secret-one", Events: []string{"push"}, IsActive: true, CreatedAt: now, UpdatedAt: now},
		{ID: 2, RepositoryID: 10, Url: "https://b.com/hook", Secret: "secret-two", Events: []string{"issues"}, IsActive: false, CreatedAt: now, UpdatedAt: now},
	}

	resps := toWebhookResponseList(webhooks)

	require.Len(t, resps, 2)
	assert.Equal(t, int64(1), resps[0].ID)
	assert.Equal(t, "********", resps[0].Secret)
	assert.Equal(t, int64(2), resps[1].ID)
	assert.Equal(t, "********", resps[1].Secret)
}

func TestToWebhookResponseList_EmptySlice(t *testing.T) {
	resps := toWebhookResponseList([]db.Webhook{})
	require.NotNil(t, resps, "result must not be nil for empty input")
	assert.Len(t, resps, 0)
}

func TestToWebhookResponseList_NilInput(t *testing.T) {
	resps := toWebhookResponseList(nil)
	// nil input → make([]WebhookResponse, 0) → len=0, not nil
	assert.Len(t, resps, 0)
}
