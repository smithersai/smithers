package blob

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMemoryStorePromoteCreateOnlyMovesPayload(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	require.NoError(t, store.Put(ctx, "pending/a", "text/plain", strings.NewReader("payload")))

	require.NoError(t, store.PromoteCreateOnly(ctx, "pending/a", "final/a"))

	reader, err := store.NewReader(ctx, "final/a")
	require.NoError(t, err)
	got, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.Equal(t, "payload", string(got))
	_, err = store.NewReader(ctx, "pending/a")
	require.ErrorIs(t, err, ErrObjectNotFound)
}
