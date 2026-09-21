package blob

import (
	"context"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseSignedURLExpiry_DefaultWhenEmpty(t *testing.T) {
	t.Parallel()
	expiry, err := ParseSignedURLExpiry("")
	require.NoError(t, err)
	assert.Equal(t, DefaultSignedURLExpiry, expiry)
}

func TestParseSignedURLExpiry_CustomDuration(t *testing.T) {
	t.Parallel()
	expiry, err := ParseSignedURLExpiry("12m")
	require.NoError(t, err)
	assert.Equal(t, 12*time.Minute, expiry)
}

func TestParseSignedURLExpiry_MaximumBoundary(t *testing.T) {
	t.Parallel()
	expiry, err := ParseSignedURLExpiry("168h")
	require.NoError(t, err)
	assert.Equal(t, MaxSignedURLExpiry, expiry)

	_, err = ParseSignedURLExpiry("168h1ns")
	require.EqualError(t, err, "signed URL expiry must not exceed 168h")
}

func TestNormalizeSignedURLExpiry_ClampsDirectCallers(t *testing.T) {
	t.Parallel()
	assert.Equal(t, MaxSignedURLExpiry, normalizeSignedURLExpiry(MaxSignedURLExpiry+time.Hour))
}

func TestParseSignedURLExpiry_InvalidDuration(t *testing.T) {
	t.Parallel()
	_, err := ParseSignedURLExpiry("not-a-duration")
	require.Error(t, err)
}

func TestGCSStore_SignedUploadURL_ZeroExpiryUsesDefault(t *testing.T) {
	t.Parallel()
	before := time.Now()
	var gotExpiry time.Time
	store := NewGCSStoreWithHooks("bucket", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotExpiry = opts.Expires
		return "https://upload.test", nil
	}, nil, nil, nil)
	_, err := store.SignedUploadURL(context.Background(), "obj", "application/octet-stream", 0, 0)
	require.NoError(t, err)
	assert.WithinDuration(t, before.Add(DefaultSignedURLExpiry), gotExpiry, 2*time.Second)
}
