package sse

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestServeBrokerSSE_Returns429WhenUserStreamCapReached(t *testing.T) {
	t.Parallel()

	const userID int64 = 42
	broker := NewBroker(nil)
	broker.MaxStreamsPerUser = 1
	broker.userCounts[userID] = 1

	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	rec := httptest.NewRecorder()

	ServeBrokerSSE(rec, req, BrokerStreamConfig{
		Broker:  broker,
		Channel: "agent_session_abc123",
		UserID:  userID,
	})

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, rec.Body.String(), "too many SSE streams")
}
