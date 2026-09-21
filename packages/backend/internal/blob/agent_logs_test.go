package blob

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAgentLogObjectKey(t *testing.T) {
	t.Parallel()
	key := AgentLogObjectKey(42, "sess-abc-123")
	assert.Equal(t, "agent-logs/42/sess-abc-123.json", key)
}

func TestAgentLogObjectKey_DifferentRepos(t *testing.T) {
	t.Parallel()
	key1 := AgentLogObjectKey(1, "session-1")
	key2 := AgentLogObjectKey(2, "session-1")
	assert.NotEqual(t, key1, key2)
	assert.Equal(t, "agent-logs/1/session-1.json", key1)
	assert.Equal(t, "agent-logs/2/session-1.json", key2)
}

func TestAgentLogObjectKey_DifferentSessions(t *testing.T) {
	t.Parallel()
	key1 := AgentLogObjectKey(1, "session-a")
	key2 := AgentLogObjectKey(1, "session-b")
	assert.NotEqual(t, key1, key2)
	assert.Equal(t, "agent-logs/1/session-a.json", key1)
	assert.Equal(t, "agent-logs/1/session-b.json", key2)
}

func TestMemoryAgentLogStore_PutAndGet(t *testing.T) {
	t.Parallel()
	store := NewMemoryAgentLogStore()
	ctx := context.Background()
	payload := []byte(`{"steps":[{"action":"clone","status":"ok"}]}`)

	err := store.PutSessionLog(ctx, 10, "sess-001", payload)
	require.NoError(t, err)

	got, err := store.GetSessionLog(ctx, 10, "sess-001")
	require.NoError(t, err)
	assert.Equal(t, payload, got)
}

func TestMemoryAgentLogStore_GetNotFound(t *testing.T) {
	t.Parallel()
	store := NewMemoryAgentLogStore()
	ctx := context.Background()

	_, err := store.GetSessionLog(ctx, 99, "nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "agent log not found")
}

func TestMemoryAgentLogStore_PutOverwrites(t *testing.T) {
	t.Parallel()
	store := NewMemoryAgentLogStore()
	ctx := context.Background()

	first := []byte(`{"version":1}`)
	second := []byte(`{"version":2}`)

	err := store.PutSessionLog(ctx, 5, "sess-overwrite", first)
	require.NoError(t, err)

	err = store.PutSessionLog(ctx, 5, "sess-overwrite", second)
	require.NoError(t, err)

	got, err := store.GetSessionLog(ctx, 5, "sess-overwrite")
	require.NoError(t, err)
	assert.Equal(t, second, got)
}

func TestMemoryAgentLogStore_PutRejectsOversizedPayload(t *testing.T) {
	t.Parallel()
	store := NewMemoryAgentLogStore()
	ctx := context.Background()

	err := store.PutSessionLog(ctx, 7, "sess-too-large", make([]byte, MaxAgentSessionLogBytes+1))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "payload exceeds")
}

func TestMemoryAgentLogStore_GetReturnsCopy(t *testing.T) {
	t.Parallel()
	store := NewMemoryAgentLogStore()
	ctx := context.Background()

	payload := []byte(`{"session":"immutable"}`)
	require.NoError(t, store.PutSessionLog(ctx, 12, "sess-copy", payload))

	got, err := store.GetSessionLog(ctx, 12, "sess-copy")
	require.NoError(t, err)
	got[0] = 'X'

	again, err := store.GetSessionLog(ctx, 12, "sess-copy")
	require.NoError(t, err)
	assert.Equal(t, payload, again)
}
