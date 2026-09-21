package blob

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMemory_Cover_NewReader_Unsupported covers MemoryStore.NewReader: an
// unknown key is ErrObjectNotFound, a key registered by a signed upload holds
// metadata only, and a key written through Put returns its bytes.
func TestMemory_Cover_NewReader_Unsupported(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	r, err := store.NewReader(context.Background(), "objects/anything")
	require.Error(t, err)
	assert.Nil(t, r)
	assert.ErrorIs(t, err, ErrObjectNotFound)

	_, err = store.SignedUploadURL(context.Background(), "objects/signed", "text/plain", 0, 0)
	require.NoError(t, err)
	r, err = store.NewReader(context.Background(), "objects/signed")
	require.Error(t, err)
	assert.Nil(t, r)
	assert.EqualError(t, err, `MemoryStore holds no content for "objects/signed"`)

	require.NoError(t, store.Put(context.Background(), "objects/put", "application/octet-stream", strings.NewReader("payload")))
	r, err = store.NewReader(context.Background(), "objects/put")
	require.NoError(t, err)
	defer r.Close()
	data, err := io.ReadAll(r)
	require.NoError(t, err)
	assert.Equal(t, "payload", string(data))
	attrs, err := store.Stat(context.Background(), "objects/put")
	require.NoError(t, err)
	assert.Equal(t, int64(7), attrs.Size)
}
