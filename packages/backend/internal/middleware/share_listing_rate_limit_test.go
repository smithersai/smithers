package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func shareListingEventRequest(userID int64) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/share/listings/2dd9630b-d96d-4d30-90b0-075ec7b06382/events", nil)
	ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{
		User:        &db.User{ID: userID, Username: "consumer"},
		IsTokenAuth: false,
	})
	return req.WithContext(ctx)
}

func TestShareListingEventRateLimit_IsDurableAndPerUser(t *testing.T) {
	store := &mockRateLimitStore{}
	handler := ShareListingEventRateLimit(store, 1)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, shareListingEventRequest(11))
	require.Equal(t, http.StatusNoContent, first.Code)
	assert.Equal(t, "1", first.Header().Get("X-RateLimit-Limit"))

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, shareListingEventRequest(11))
	require.Equal(t, http.StatusTooManyRequests, second.Code)
	assert.NotEmpty(t, second.Header().Get("Retry-After"))
	assert.Contains(t, store.keysSeen, "share_listing_event|user:11")

	otherUser := httptest.NewRecorder()
	handler.ServeHTTP(otherUser, shareListingEventRequest(12))
	require.Equal(t, http.StatusNoContent, otherUser.Code)
	assert.Contains(t, store.keysSeen, "share_listing_event|user:12")
}
