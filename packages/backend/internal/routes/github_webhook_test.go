package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockGitHubWebhookRouteService struct {
	handleFn func(ctx context.Context, deliveryID, eventType, signature string, payload []byte) error
}

func (m *mockGitHubWebhookRouteService) HandleGitHubWebhook(ctx context.Context, deliveryID, eventType, signature string, payload []byte) error {
	if m.handleFn != nil {
		return m.handleFn(ctx, deliveryID, eventType, signature, payload)
	}
	return nil
}

func TestGitHubWebhookHandler_PostGitHubWebhook_Success(t *testing.T) {
	t.Parallel()

	payload := `{"zen":"keep it logically awesome"}`
	handler := &GitHubWebhookHandler{
		Service: &mockGitHubWebhookRouteService{
			handleFn: func(ctx context.Context, deliveryID, eventType, signature string, body []byte) error {
				assert.Equal(t, "10f1a174-8f9f-4434-a5bf-0f0b7f4f00aa", deliveryID)
				assert.Equal(t, "push", eventType)
				assert.Equal(t, "sha256=deadbeef", signature)
				assert.Equal(t, payload, string(body))
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(payload))
	req.Header.Set(gitHubWebhookEventHeader, "push")
	req.Header.Set(gitHubWebhookDeliveryHeader, "10f1a174-8f9f-4434-a5bf-0f0b7f4f00aa")
	req.Header.Set(gitHubWebhookSignatureHeader, "sha256=deadbeef")
	rec := httptest.NewRecorder()

	handler.PostGitHubWebhook(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestGitHubWebhookHandler_PostGitHubWebhook_MissingEventHeader(t *testing.T) {
	t.Parallel()

	handler := &GitHubWebhookHandler{Service: &mockGitHubWebhookRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(`{}`))
	req.Header.Set(gitHubWebhookDeliveryHeader, "10f1a174-8f9f-4434-a5bf-0f0b7f4f00aa")
	rec := httptest.NewRecorder()

	handler.PostGitHubWebhook(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGitHubWebhookHandler_PostGitHubWebhook_MissingDeliveryID(t *testing.T) {
	t.Parallel()

	handler := &GitHubWebhookHandler{Service: &mockGitHubWebhookRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(`{}`))
	req.Header.Set(gitHubWebhookEventHeader, "push")
	rec := httptest.NewRecorder()

	handler.PostGitHubWebhook(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGitHubWebhookHandler_PostGitHubWebhook_ServiceUnauthorized(t *testing.T) {
	t.Parallel()

	handler := &GitHubWebhookHandler{
		Service: &mockGitHubWebhookRouteService{
			handleFn: func(ctx context.Context, deliveryID, eventType, signature string, payload []byte) error {
				return pkgerrors.Unauthorized("invalid github webhook signature")
			},
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(`{}`))
	req.Header.Set(gitHubWebhookEventHeader, "push")
	req.Header.Set(gitHubWebhookDeliveryHeader, "10f1a174-8f9f-4434-a5bf-0f0b7f4f00aa")
	rec := httptest.NewRecorder()

	handler.PostGitHubWebhook(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestGitHubWebhookHandler_PostGitHubWebhook_AppliesProcessingDeadline(t *testing.T) {
	t.Parallel()

	handler := &GitHubWebhookHandler{
		Service: &mockGitHubWebhookRouteService{
			handleFn: func(ctx context.Context, deliveryID, eventType, signature string, payload []byte) error {
				deadline, ok := ctx.Deadline()
				require.True(t, ok, "webhook context should include a processing deadline")
				remaining := time.Until(deadline)
				assert.LessOrEqual(t, remaining, gitHubWebhookProcessingTimeout)
				assert.Greater(t, remaining, 8*time.Second)
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(`{}`))
	req.Header.Set(gitHubWebhookEventHeader, "push")
	req.Header.Set(gitHubWebhookDeliveryHeader, "10f1a174-8f9f-4434-a5bf-0f0b7f4f00aa")
	req.Header.Set(gitHubWebhookSignatureHeader, "sha256=deadbeef")
	rec := httptest.NewRecorder()

	handler.PostGitHubWebhook(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestGitHubWebhookHandler_PostGitHubWebhook_DeadlineExceeded(t *testing.T) {
	t.Parallel()

	handler := &GitHubWebhookHandler{
		Service: &mockGitHubWebhookRouteService{
			handleFn: func(ctx context.Context, deliveryID, eventType, signature string, payload []byte) error {
				return context.DeadlineExceeded
			},
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(`{}`))
	req.Header.Set(gitHubWebhookEventHeader, "push")
	req.Header.Set(gitHubWebhookDeliveryHeader, "10f1a174-8f9f-4434-a5bf-0f0b7f4f00aa")
	req.Header.Set(gitHubWebhookSignatureHeader, "sha256=deadbeef")
	rec := httptest.NewRecorder()

	handler.PostGitHubWebhook(rec, req)

	require.Equal(t, http.StatusGatewayTimeout, rec.Code)
}
