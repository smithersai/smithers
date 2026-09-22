package gcsblob

import (
	"context"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"io"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/option"
)

// TestGCS_Cover_NewGCSStore_NilClient exercises the branch of NewGCSStore where
// the client is nil: every hook stays nil and the store surfaces the
// "not configured" errors on use.
func TestGCS_Cover_NewGCSStore_NilClient(t *testing.T) {
	t.Parallel()
	store := NewGCSStore(nil, "smithers-blobs")
	require.NotNil(t, store)
	assert.Equal(t, "smithers-blobs", store.bucket)
	assert.Nil(t, store.signerFn)
	assert.Nil(t, store.existsFn)
	assert.Nil(t, store.deleteFn)
	assert.Nil(t, store.statFn)
	assert.Nil(t, store.newReaderFn)
}

// TestGCS_Cover_NewGCSStore_WithClient exercises the client != nil branch of
// NewGCSStore. It uses an unauthenticated client (constructed offline, no
// network) and drives the signer closure, whose signing attempt fails locally
// because no GoogleAccessID/private key is available — no network is required.
func TestGCS_Cover_NewGCSStore_WithClient(t *testing.T) {
	t.Parallel()
	client, err := storage.NewClient(context.Background(), option.WithoutAuthentication())
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Close() })

	store := NewGCSStore(client, "smithers-blobs")
	require.NotNil(t, store)
	assert.Equal(t, "smithers-blobs", store.bucket)
	require.NotNil(t, store.signerFn)
	require.NotNil(t, store.existsFn)
	require.NotNil(t, store.deleteFn)
	require.NotNil(t, store.statFn)
	require.NotNil(t, store.newReaderFn)

	// Invoke the signer closure via both signed-URL methods. Signing fails
	// locally (no signing credentials), which drives the closure body without
	// any network egress.
	up, err := store.SignedUploadURL(context.Background(), "objects/x", "text/plain", 0, time.Minute)
	require.Error(t, err)
	assert.Empty(t, up)

	down, err := store.SignedDownloadURL(context.Background(), "objects/x", time.Minute)
	require.Error(t, err)
	assert.Empty(t, down)
}

// TestGCS_Cover_UnconfiguredHooks covers the "not configured" guard branch of
// every GCSStore method when its backing hook is nil.
func TestGCS_Cover_UnconfiguredHooks(t *testing.T) {
	t.Parallel()
	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, nil, nil)
	ctx := context.Background()

	_, err := store.SignedUploadURL(ctx, "k", "text/plain", 0, time.Minute)
	require.EqualError(t, err, "gcs signer is not configured")

	_, err = store.SignedDownloadURL(ctx, "k", time.Minute)
	require.EqualError(t, err, "gcs signer is not configured")

	err = store.Delete(ctx, "k")
	require.EqualError(t, err, "gcs delete is not configured")

	_, err = store.Exists(ctx, "k")
	require.EqualError(t, err, "gcs exists is not configured")

	_, err = store.Stat(ctx, "k")
	require.EqualError(t, err, "gcs stat is not configured")

	_, err = store.NewReader(ctx, "k")
	require.EqualError(t, err, "gcs reader is not configured")
}

// TestGCS_Cover_NewGCSStoreWithHooks_ReaderVariadic covers the branch that wires
// a supplied newReaderFn, and the NewReader success path.
func TestGCS_Cover_NewGCSStoreWithHooks_ReaderVariadic(t *testing.T) {
	t.Parallel()
	var gotBucket, gotObject string
	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, nil, nil,
		func(_ context.Context, bucket, object string) (io.ReadCloser, error) {
			gotBucket, gotObject = bucket, object
			return io.NopCloser(strings.NewReader("payload-bytes")), nil
		})
	require.NotNil(t, store.newReaderFn)

	r, err := store.NewReader(context.Background(), "objects/read.bin")
	require.NoError(t, err)
	t.Cleanup(func() { _ = r.Close() })
	data, err := io.ReadAll(r)
	require.NoError(t, err)
	assert.Equal(t, "payload-bytes", string(data))
	assert.Equal(t, "smithers-blobs", gotBucket)
	assert.Equal(t, "objects/read.bin", gotObject)
}

// TestGCS_Cover_NewReader_PropagatesError covers the configured NewReader hook
// returning an error.
func TestGCS_Cover_NewReader_PropagatesError(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("gcs-cover reader failed")
	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, nil, nil,
		func(context.Context, string, string) (io.ReadCloser, error) {
			return nil, sentinel
		})
	r, err := store.NewReader(context.Background(), "objects/bad.bin")
	require.Error(t, err)
	assert.ErrorIs(t, err, sentinel)
	assert.Nil(t, r)
}

// TestGCS_Cover_Stat_PropagatesError covers the configured Stat hook returning
// an error (the success path is covered by the sibling gcs_test.go).
func TestGCS_Cover_Stat_PropagatesError(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("gcs-cover stat failed")
	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, nil,
		func(context.Context, string, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{}, sentinel
		})
	_, err := store.Stat(context.Background(), "objects/x")
	require.Error(t, err)
	assert.ErrorIs(t, err, sentinel)
}
