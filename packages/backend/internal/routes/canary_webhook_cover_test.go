package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type canaryWebhookCovObserver struct {
	receivedAt time.Time
}

func (o *canaryWebhookCovObserver) ObserveCanaryWebhookReceipt(receivedAt time.Time) {
	o.receivedAt = receivedAt
}

func TestCanaryWebhook_Cov_NowAndReceiveBranches(t *testing.T) {
	t.Parallel()

	t.Run("now converts custom clock to utc", func(t *testing.T) {
		loc := time.FixedZone("offset", -5*60*60)
		h := &CanaryWebhookHandler{Clock: func() time.Time {
			return time.Date(2026, 7, 7, 9, 30, 0, 0, loc)
		}}

		got := h.now()

		assert.Equal(t, time.UTC, got.Location())
		assert.Equal(t, time.Date(2026, 7, 7, 14, 30, 0, 0, time.UTC), got)
	})

	t.Run("nil handler reports not configured", func(t *testing.T) {
		var h *CanaryWebhookHandler
		req := withRouteParams(httptest.NewRequest(http.MethodPost, "/canary/token", nil), map[string]string{"token": "anything"})
		rec := httptest.NewRecorder()

		h.Receive(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), "not configured")
	})

	t.Run("observer receives custom timestamp", func(t *testing.T) {
		h := NewCanaryWebhookHandler("cover-key")
		require.NotNil(t, h)
		observer := &canaryWebhookCovObserver{}
		want := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
		h.Observer = observer
		h.Clock = func() time.Time { return want }
		token, err := SignCanaryWebhookToken("cover-key")
		require.NoError(t, err)
		req := withRouteParams(httptest.NewRequest(http.MethodPost, "/canary/"+token, nil), map[string]string{"token": token})
		rec := httptest.NewRecorder()

		h.Receive(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, want, observer.receivedAt)
	})
}
