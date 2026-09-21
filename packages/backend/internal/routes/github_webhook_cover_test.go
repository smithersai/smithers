package routes

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type githubWebhookCovBadReader struct{}

func (githubWebhookCovBadReader) Read(p []byte) (int, error) {
	return 0, errors.New("read failed")
}

func TestGitHubWebhook_Cov_ErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("nil service is internal error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()

		(&GitHubWebhookHandler{}).PostGitHubWebhook(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "service not configured")
	})

	t.Run("body read failure is bad request", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/webhooks/github", io.NopCloser(githubWebhookCovBadReader{}))
		rec := httptest.NewRecorder()

		(&GitHubWebhookHandler{Service: &mockGitHubWebhookRouteService{}}).PostGitHubWebhook(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "invalid github webhook payload")
	})

	t.Run("generic service error is hidden", func(t *testing.T) {
		h := &GitHubWebhookHandler{Service: &mockGitHubWebhookRouteService{
			handleFn: func(ctx context.Context, deliveryID, eventType, signature string, payload []byte) error {
				return errors.New("database password leaked")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(`{}`))
		req.Header.Set(gitHubWebhookEventHeader, "push")
		req.Header.Set(gitHubWebhookDeliveryHeader, "delivery-1")
		rec := httptest.NewRecorder()

		h.PostGitHubWebhook(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "internal server error")
		assert.NotContains(t, rec.Body.String(), "password")
	})

	t.Run("route error preserves api status", func(t *testing.T) {
		rec := httptest.NewRecorder()

		writeGitHubWebhookRouteError(rec, pkgerrors.Forbidden("signature rejected"))

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "signature rejected")
	})
}
