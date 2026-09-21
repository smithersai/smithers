package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type alertWebhookCovReceiver struct {
	incidentErr error
}

func (r *alertWebhookCovReceiver) HandleAlertIncident(context.Context, services.MonitoringAlertIncident) error {
	return r.incidentErr
}

func TestAlertWebhook_Cov_BasicAuthValidationEdges(t *testing.T) {
	t.Parallel()

	assert.True(t, ValidateAlertWebhookBasicAuth("  route-secret  ", AlertWebhookBasicAuthUsername, "route-secret"))
	assert.False(t, ValidateAlertWebhookBasicAuth("", AlertWebhookBasicAuthUsername, "route-secret"))
	assert.False(t, ValidateAlertWebhookBasicAuth("route-secret", "wrong-user", "route-secret"))
}

func TestAlertWebhook_Cov_ReceiveReadAndReceiverErrors(t *testing.T) {
	t.Parallel()

	t.Run("nil handler is not configured", func(t *testing.T) {
		t.Parallel()

		var h *AlertWebhookHandler
		req := httptest.NewRequest(http.MethodPost, "/alerts", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()

		h.Receive(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("body read failure", func(t *testing.T) {
		t.Parallel()

		h := NewAlertWebhookHandler("route-secret")
		require.NotNil(t, h)
		req := httptest.NewRequest(http.MethodPost, "/alerts", alertWebhookCovErrReader{})
		req.SetBasicAuth(AlertWebhookBasicAuthUsername, "route-secret")
		rec := httptest.NewRecorder()

		h.Receive(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "failed to read alert webhook payload")
	})

	t.Run("receiver failure", func(t *testing.T) {
		t.Parallel()

		h := NewAlertWebhookHandler("route-secret")
		require.NotNil(t, h)
		h.Receiver = &alertWebhookCovReceiver{incidentErr: errors.New("downstream")}
		req := httptest.NewRequest(http.MethodPost, "/alerts", strings.NewReader(`{"incident":{"incident_id":" inc-1 ","state":"OPEN"}}`))
		req.SetBasicAuth(AlertWebhookBasicAuthUsername, "route-secret")
		rec := httptest.NewRecorder()

		h.Receive(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "failed to process alert incident")
	})
}

type alertWebhookCovErrReader struct{}

func (alertWebhookCovErrReader) Read([]byte) (int, error) {
	return 0, errors.New("read failed")
}
