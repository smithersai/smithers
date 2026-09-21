package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestCanaryWebhook_H_NowDefaultUTC(t *testing.T) {
	var h *CanaryWebhookHandler
	before := time.Now().UTC().Add(-time.Second)

	got := h.now()

	after := time.Now().UTC().Add(time.Second)
	assert.True(t, got.After(before))
	assert.True(t, got.Before(after))
	assert.Equal(t, time.UTC, got.Location())
}
