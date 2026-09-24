package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestWebhookService_RejectsEventsThatNeverFire(t *testing.T) {
	t.Parallel()

	_, actor := ownerRepo()
	mock := webhookQuerier()
	svc := newWebhookService(t, mock)
	_, err := svc.CreateWebhook(context.Background(), actor, "alice", "demo", CreateWebhookInput{
		URL:    "https://example.com/hook",
		Events: []string{"push", "release"},
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)

	mock.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return sampleWebhook(), nil
	}
	events := []string{"agent.session"}
	_, err = svc.UpdateWebhook(context.Background(), actor, "alice", "demo", 1, UpdateWebhookInput{Events: &events})
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}
