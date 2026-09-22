package compose

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
)

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
