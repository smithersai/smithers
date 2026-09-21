package blob

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/googleapi"
)

func TestTranslateGCSPromoteErrorMapsHTTPNotFound(t *testing.T) {
	t.Parallel()

	notFound := fmt.Errorf("rewrite source: %w", &googleapi.Error{Code: http.StatusNotFound})
	assert.ErrorIs(t, translateGCSPromoteError(notFound), ErrObjectNotFound)

	precondition := &googleapi.Error{Code: http.StatusPreconditionFailed}
	assert.ErrorIs(t, translateGCSPromoteError(precondition), ErrObjectAlreadyExists)

	expected := errors.New("transient storage failure")
	assert.ErrorIs(t, translateGCSPromoteError(expected), expected)
}

func TestHardDeleteGCSObjectGenerationsRejectsSoftDeletedRemainder(t *testing.T) {
	t.Parallel()

	const key = "repos/42/lfs/object"
	live := []storage.ObjectAttrs{{Name: key, Generation: 7}}
	softDeleted := []storage.ObjectAttrs{}
	visit := func(_ context.Context, query *storage.Query, visitor func(*storage.ObjectAttrs) error) error {
		objects := live
		if query.SoftDeleted {
			objects = softDeleted
		}
		for i := range objects {
			if err := visitor(&objects[i]); err != nil {
				return err
			}
		}
		return nil
	}
	deleteGeneration := func(_ context.Context, generation int64) error {
		require.Equal(t, int64(7), generation)
		live = nil
		softDeleted = []storage.ObjectAttrs{{Name: key, Generation: generation}}
		return nil
	}

	err := hardDeleteGCSObjectGenerationsWithHooks(context.Background(), key, visit, deleteGeneration)
	require.Error(t, err)
	assert.ErrorContains(t, err, "soft-deleted generations retained by bucket policy")
}

func TestHardDeleteGCSObjectGenerationsIgnoresSoftDeletedPrefixSibling(t *testing.T) {
	t.Parallel()

	const key = "repos/42/lfs/object"
	visit := func(_ context.Context, query *storage.Query, visitor func(*storage.ObjectAttrs) error) error {
		if query.SoftDeleted {
			attrs := &storage.ObjectAttrs{Name: key + "-sibling", Generation: 9}
			return visitor(attrs)
		}
		return nil
	}

	require.NoError(t, hardDeleteGCSObjectGenerationsWithHooks(
		context.Background(), key, visit, func(context.Context, int64) error {
			t.Fatal("no exact live generation should be deleted")
			return nil
		},
	))
}

func TestGCSStore_PromoteCreateOnlyUsesConfiguredBucketAndKeys(t *testing.T) {
	t.Parallel()

	store := NewGCSStoreWithHooks("blobs", nil, nil, nil, nil)
	store.promoteFn = func(_ context.Context, bucket, source, destination string) error {
		assert.Equal(t, "blobs", bucket)
		assert.Equal(t, "lfs-pending/1/oid", source)
		assert.Equal(t, "repos/1/lfs/oid", destination)
		return nil
	}

	require.NoError(t, store.PromoteCreateOnly(context.Background(), "lfs-pending/1/oid", "repos/1/lfs/oid"))
}

func TestMemoryStore_PromoteCreateOnlyMovesWithoutOverwrite(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore()
	_, err := store.SignedUploadURL(context.Background(), "pending", "application/octet-stream", 1, 0)
	require.NoError(t, err)
	require.NoError(t, store.PromoteCreateOnly(context.Background(), "pending", "final"))
	pending, _ := store.Exists(context.Background(), "pending")
	final, _ := store.Exists(context.Background(), "final")
	assert.False(t, pending)
	assert.True(t, final)

	_, err = store.SignedUploadURL(context.Background(), "other", "application/octet-stream", 1, 0)
	require.NoError(t, err)
	assert.ErrorIs(t, store.PromoteCreateOnly(context.Background(), "other", "final"), ErrObjectAlreadyExists)
}
