package blob

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestAgentLogs_Cover_NewGCSAgentLogStore covers the constructor, which simply
// wires the client and bucket into the store struct.
func TestAgentLogs_Cover_NewGCSAgentLogStore(t *testing.T) {
	t.Parallel()
	store := NewGCSAgentLogStore(nil, "agent-log-bucket")
	require.NotNil(t, store)
	assert.Nil(t, store.client)
	assert.Equal(t, "agent-log-bucket", store.bucket)
}

// TestAgentLogs_Cover_PutSessionLog_RejectsOversized covers the GCS-backed
// PutSessionLog size-validation branch, which returns before any GCS client
// access — so it runs deterministically without a client/emulator/network.
func TestAgentLogs_Cover_PutSessionLog_RejectsOversized(t *testing.T) {
	t.Parallel()
	store := NewGCSAgentLogStore(nil, "agent-log-bucket")
	err := store.PutSessionLog(context.Background(), 77, "sess-oversized", make([]byte, MaxAgentSessionLogBytes+1))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "validate agent log")
	assert.Contains(t, err.Error(), "payload exceeds")
	assert.Contains(t, err.Error(), AgentLogObjectKey(77, "sess-oversized"))
}
