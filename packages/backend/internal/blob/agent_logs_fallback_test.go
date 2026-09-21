package blob

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGCSAgentLogStoreWithReadFallback_GetFallsBackToLegacyBucket(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const primary = "h-agent-logs-retention"
	const legacy = "h-blobs-legacy"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStoreWithReadFallback(client, primary, legacy)

	payload := []byte(`{"archived":"before-cutover"}`)
	fake.putObject(legacy, AgentLogObjectKey(42, "session-legacy"), payload, "application/json")

	got, err := store.GetSessionLog(ctx, 42, "session-legacy")
	require.NoError(t, err)
	assert.Equal(t, payload, got)
}

func TestGCSAgentLogStoreWithReadFallback_PrimaryWinsOverLegacy(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const primary = "h-agent-logs-retention"
	const legacy = "h-blobs-legacy"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStoreWithReadFallback(client, primary, legacy)

	key := AgentLogObjectKey(7, "session-both")
	fresh := []byte(`{"archived":"after-cutover"}`)
	stale := []byte(`{"archived":"before-cutover"}`)
	fake.putObject(primary, key, fresh, "application/json")
	fake.putObject(legacy, key, stale, "application/json")

	got, err := store.GetSessionLog(ctx, 7, "session-both")
	require.NoError(t, err)
	assert.Equal(t, fresh, got)
}

func TestGCSAgentLogStoreWithReadFallback_PutWritesPrimaryOnly(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const primary = "h-agent-logs-retention"
	const legacy = "h-blobs-legacy"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStoreWithReadFallback(client, primary, legacy)

	payload := []byte(`{"steps":[{"status":"ok"}]}`)
	require.NoError(t, store.PutSessionLog(ctx, 9, "session-write", payload))

	key := AgentLogObjectKey(9, "session-write")
	stored, ok := fake.object(primary, key)
	require.True(t, ok, "transcript must land in the retention bucket")
	assert.Equal(t, payload, stored.body)

	_, ok = fake.object(legacy, key)
	assert.False(t, ok, "transcript must not be written to the legacy blob bucket")
}

func TestGCSAgentLogStoreWithReadFallback_MissEverywhereErrors(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStoreWithReadFallback(client, "h-agent-logs-retention", "h-blobs-legacy")

	_, err := store.GetSessionLog(ctx, 11, "session-missing")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "open agent log")
}

func TestGCSAgentLogStoreWithReadFallback_PrimaryServerErrorDoesNotFallBack(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const primary = "h-agent-logs-retention"
	const legacy = "h-blobs-legacy"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStoreWithReadFallback(client, primary, legacy)

	key := AgentLogObjectKey(13, "session-500")
	fake.putObject(legacy, key, []byte(`{"archived":"legacy"}`), "application/json")
	fake.setDownloadStatus(primary, key, http.StatusInternalServerError)

	_, err := store.GetSessionLog(ctx, 13, "session-500")
	require.Error(t, err, "a non-not-found primary error must surface, not silently read stale legacy data")
}
