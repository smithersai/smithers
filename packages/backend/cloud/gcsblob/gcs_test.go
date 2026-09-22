package gcsblob

import (
	"context"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGCSStore_SignedUploadURL_GeneratesValidURL(t *testing.T) {
	t.Parallel()
	var gotBucket, gotObject string
	var gotOpts *storage.SignedURLOptions
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotBucket, gotObject, gotOpts = bucket, object, opts
		return "https://example.test/upload", nil
	}, nil, nil, nil)
	url, err := store.SignedUploadURL(context.Background(), "path/object.bin", "application/octet-stream", 0, 5*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "https://example.test/upload", url)
	assert.Equal(t, "smithers-blobs", gotBucket)
	assert.Equal(t, "path/object.bin", gotObject)
	require.NotNil(t, gotOpts)
	assert.Equal(t, storage.SigningSchemeV4, gotOpts.Scheme)
	assert.Equal(t, "PUT", gotOpts.Method)
	assert.Equal(t, "application/octet-stream", gotOpts.ContentType)
	assert.Empty(t, gotOpts.Headers, "no size limit requested, so no content-length-range header")
}

// TestGCSStore_SignedUploadURL_EnforcesMaxSize covers issue 153: a positive
// maxSizeBytes must be baked into the signed URL as a
// x-goog-content-length-range header so the storage layer rejects uploads
// larger than the caller declared.
func TestGCSStore_SignedUploadURL_EnforcesMaxSize(t *testing.T) {
	t.Parallel()
	var gotOpts *storage.SignedURLOptions
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotOpts = opts
		return "https://example.test/upload", nil
	}, nil, nil, nil)
	_, err := store.SignedUploadURL(context.Background(), "path/object.bin", "application/octet-stream", 42, 5*time.Minute)
	require.NoError(t, err)
	require.NotNil(t, gotOpts)
	assert.Equal(t, []string{"x-goog-content-length-range:0,42"}, gotOpts.Headers)
}

func TestGCSStore_SignedUploadURL_RespectsExpiry(t *testing.T) {
	t.Parallel()
	before := time.Now()
	var gotExpiry time.Time
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotExpiry = opts.Expires
		return "https://example.test/upload", nil
	}, nil, nil, nil)
	_, err := store.SignedUploadURL(context.Background(), "path/object.bin", "application/octet-stream", 0, 2*time.Minute)
	require.NoError(t, err)
	assert.WithinDuration(t, before.Add(2*time.Minute), gotExpiry, 2*time.Second)
}

func TestGCSStore_SignedUploadURL_PropagatesError(t *testing.T) {
	t.Parallel()
	expectedErr := errors.New("signer failed")
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		return "", expectedErr
	}, nil, nil, nil)
	_, err := store.SignedUploadURL(context.Background(), "path/object.bin", "application/octet-stream", 0, time.Minute)
	require.Error(t, err)
	assert.ErrorIs(t, err, expectedErr)
}

func TestGCSStore_SignedDownloadURL_GeneratesValidURL(t *testing.T) {
	t.Parallel()
	var gotOpts *storage.SignedURLOptions
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotOpts = opts
		return "https://example.test/download", nil
	}, nil, nil, nil)
	url, err := store.SignedDownloadURL(context.Background(), "path/object.bin", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "https://example.test/download", url)
	require.NotNil(t, gotOpts)
	assert.Equal(t, storage.SigningSchemeV4, gotOpts.Scheme)
	assert.Equal(t, "GET", gotOpts.Method)
}

func TestGCSStore_SignedDownloadURL_RespectsExpiry(t *testing.T) {
	t.Parallel()
	before := time.Now()
	var gotExpiry time.Time
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotExpiry = opts.Expires
		return "https://example.test/download", nil
	}, nil, nil, nil)
	_, err := store.SignedDownloadURL(context.Background(), "path/object.bin", 7*time.Minute)
	require.NoError(t, err)
	assert.WithinDuration(t, before.Add(7*time.Minute), gotExpiry, 2*time.Second)
}

func TestGCSStore_Delete_RemovesObject(t *testing.T) {
	t.Parallel()
	var gotBucket, gotObject string
	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, func(ctx context.Context, bucket, object string) error {
		gotBucket, gotObject = bucket, object
		return nil
	}, nil)
	err := store.Delete(context.Background(), "path/object.bin")
	require.NoError(t, err)
	assert.Equal(t, "smithers-blobs", gotBucket)
	assert.Equal(t, "path/object.bin", gotObject)
}

func TestGCSStore_Delete_PropagatesError(t *testing.T) {
	t.Parallel()
	expectedErr := errors.New("delete failed")
	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, func(ctx context.Context, bucket, object string) error { return expectedErr }, nil)
	err := store.Delete(context.Background(), "path/object.bin")
	require.Error(t, err)
	assert.ErrorIs(t, err, expectedErr)
}

func TestGCSStore_Exists_ReturnsTrueForExisting(t *testing.T) {
	t.Parallel()
	store := NewGCSStoreWithHooks("smithers-blobs", nil, func(ctx context.Context, bucket, object string) (bool, error) { return true, nil }, nil, nil)
	exists, err := store.Exists(context.Background(), "path/object.bin")
	require.NoError(t, err)
	assert.True(t, exists)
}

func TestGCSStore_Exists_ReturnsFalseForMissing(t *testing.T) {
	t.Parallel()
	store := NewGCSStoreWithHooks("smithers-blobs", nil, func(ctx context.Context, bucket, object string) (bool, error) { return false, nil }, nil, nil)
	exists, err := store.Exists(context.Background(), "path/object.bin")
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestGCSStore_Exists_PropagatesError(t *testing.T) {
	t.Parallel()
	expectedErr := errors.New("exists failed")
	store := NewGCSStoreWithHooks("smithers-blobs", nil, func(ctx context.Context, bucket, object string) (bool, error) { return false, expectedErr }, nil, nil)
	_, err := store.Exists(context.Background(), "path/object.bin")
	require.Error(t, err)
	assert.ErrorIs(t, err, expectedErr)
}

func TestGCSStore_Stat_ReturnsSize(t *testing.T) {
	t.Parallel()

	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, nil, func(ctx context.Context, bucket, object string) (blob.ObjectAttrs, error) {
		assert.Equal(t, "smithers-blobs", bucket)
		assert.Equal(t, "path/object.bin", object)
		return blob.ObjectAttrs{Size: 123}, nil
	})

	attrs, err := store.Stat(context.Background(), "path/object.bin")
	require.NoError(t, err)
	assert.Equal(t, int64(123), attrs.Size)
}
