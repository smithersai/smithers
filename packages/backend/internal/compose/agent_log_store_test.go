package compose

import (
	"context"
	"testing"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/option"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
)

// newOfflineGCSClient builds a storage client that never dials anything —
// initializeAgentLogStore only inspects nil-ness and configuration.
func newOfflineGCSClient(t *testing.T) *storage.Client {
	t.Helper()
	client, err := storage.NewClient(
		context.Background(),
		option.WithoutAuthentication(),
		option.WithEndpoint("http://127.0.0.1:1/storage/v1/"),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestInitializeAgentLogStore_MemoryWithoutGCSClient(t *testing.T) {
	store := initializeAgentLogStore(nil, config.BlobConfig{GCSBucket: "smithers-blobs"})
	_, isMemory := store.(*blob.MemoryAgentLogStore)
	assert.True(t, isMemory, "no GCS client must fall back to the in-memory store")
}

func TestInitializeAgentLogStore_FilesystemWithoutGCSClient(t *testing.T) {
	filesystem, err := blob.NewFilesystemStore(blob.FilesystemConfig{
		Root: t.TempDir(), PublicBaseURL: "https://smithers.test", SigningKey: make([]byte, 32),
	})
	require.NoError(t, err)
	store := initializeAgentLogStore(nil, config.BlobConfig{}, filesystem)
	_, ok := store.(*blob.FilesystemAgentLogStore)
	assert.True(t, ok)
}

func TestInitializeAgentLogStore_DedicatedRetentionBucketWithLegacyReadFallback(t *testing.T) {
	client := newOfflineGCSClient(t)
	store := initializeAgentLogStore(client, config.BlobConfig{
		GCSBucket:          "smithers-blobs",
		AgentLogsGCSBucket: "smithers-agent-logs",
	})

	gcsStore, ok := store.(*blob.GCSAgentLogStore)
	require.True(t, ok)
	assert.Equal(t, "smithers-agent-logs", gcsStore.Bucket(),
		"transcripts must be written to the retention-limited agent-logs bucket")
	assert.Equal(t, "smithers-blobs", gcsStore.ReadFallbackBucket(),
		"transcripts archived to the blob bucket before the cutover must stay readable")
}

func TestInitializeAgentLogStore_FallsBackToBlobBucketWhenUnset(t *testing.T) {
	client := newOfflineGCSClient(t)
	store := initializeAgentLogStore(client, config.BlobConfig{GCSBucket: "smithers-blobs"})

	gcsStore, ok := store.(*blob.GCSAgentLogStore)
	require.True(t, ok)
	assert.Equal(t, "smithers-blobs", gcsStore.Bucket())
	assert.Empty(t, gcsStore.ReadFallbackBucket(),
		"no fallback needed when writes already target the blob bucket")
}

func TestInitializeAgentLogStore_SameBucketConfiguredExplicitly(t *testing.T) {
	client := newOfflineGCSClient(t)
	store := initializeAgentLogStore(client, config.BlobConfig{
		GCSBucket:          "smithers-blobs",
		AgentLogsGCSBucket: "smithers-blobs",
	})

	gcsStore, ok := store.(*blob.GCSAgentLogStore)
	require.True(t, ok)
	assert.Equal(t, "smithers-blobs", gcsStore.Bucket())
	assert.Empty(t, gcsStore.ReadFallbackBucket())
}
