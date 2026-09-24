package compose

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/stretchr/testify/require"
)

func TestSelectAgentLogStore_RequiresAdapterForInjectedBlobs(t *testing.T) {
	store, err := selectAgentLogStore(blob.NewMemoryStore(), nil)
	require.ErrorContains(t, err, "requires an injected agent-log adapter")
	require.Nil(t, store)
}
func TestSelectAgentLogStore_PreservesInjectedAdapter(t *testing.T) {
	provided := blob.NewMemoryAgentLogStore()
	store, err := selectAgentLogStore(blob.NewMemoryStore(), provided)
	require.NoError(t, err)
	require.Same(t, provided, store)
}
func TestSelectAgentLogStore_DurableFilesystem(t *testing.T) {
	filesystem, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "https://smithers.test", SigningKey: make([]byte, 32)})
	require.NoError(t, err)
	store, err := selectAgentLogStore(filesystem, nil)
	require.NoError(t, err)
	require.IsType(t, &blob.FilesystemAgentLogStore{}, store)
}
