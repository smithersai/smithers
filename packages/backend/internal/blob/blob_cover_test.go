package blob

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// blobCoverFakeStore is a minimal Store implementation whose NewReader behavior
// is configurable so ComputeSHA256 can be exercised without a real backend.
type blobCoverFakeStore struct {
	newReader func(ctx context.Context, key string) (io.ReadCloser, error)
}

func (f blobCoverFakeStore) SignedUploadURL(context.Context, string, string, int64, time.Duration) (string, error) {
	return "", nil
}
func (f blobCoverFakeStore) SignedDownloadURL(context.Context, string, time.Duration) (string, error) {
	return "", nil
}
func (f blobCoverFakeStore) Delete(context.Context, string) error         { return nil }
func (f blobCoverFakeStore) Exists(context.Context, string) (bool, error) { return false, nil }
func (f blobCoverFakeStore) Stat(context.Context, string) (ObjectAttrs, error) {
	return ObjectAttrs{}, nil
}
func (f blobCoverFakeStore) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	return f.newReader(ctx, key)
}

// blobCoverErrReader is an io.ReadCloser that always fails on Read and records
// whether Close was invoked, so the io.Copy error path (and defer Close) of
// ComputeSHA256 can be verified.
type blobCoverErrReader struct {
	closed *bool
}

func (r blobCoverErrReader) Read([]byte) (int, error) { return 0, errors.New("blob-cover boom read") }
func (r blobCoverErrReader) Close() error {
	if r.closed != nil {
		*r.closed = true
	}
	return nil
}

func TestBlob_Cover_ParseSignedURLExpiry_NonPositive(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"0s", "-5m", "-1ns"} {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()
			d, err := ParseSignedURLExpiry(raw)
			require.Error(t, err)
			assert.Equal(t, time.Duration(0), d)
			assert.EqualError(t, err, "signed URL expiry must be greater than zero")
		})
	}
}

func TestBlob_Cover_ComputeSHA256_Success(t *testing.T) {
	t.Parallel()
	content := "the quick brown fox jumps over the lazy dog"
	sum := sha256.Sum256([]byte(content))
	want := hex.EncodeToString(sum[:])

	var closed bool
	store := blobCoverFakeStore{
		newReader: func(_ context.Context, key string) (io.ReadCloser, error) {
			assert.Equal(t, "objects/abc", key)
			return &blobCoverTrackingReader{Reader: strings.NewReader(content), closed: &closed}, nil
		},
	}

	got, err := ComputeSHA256(context.Background(), store, "objects/abc")
	require.NoError(t, err)
	assert.Equal(t, want, got)
	assert.True(t, closed, "reader should be closed via defer")
}

// blobCoverTrackingReader wraps a Reader and records Close so the success path
// can assert the deferred Close ran.
type blobCoverTrackingReader struct {
	io.Reader
	closed *bool
}

func (r *blobCoverTrackingReader) Close() error {
	if r.closed != nil {
		*r.closed = true
	}
	return nil
}

func TestBlob_Cover_ComputeSHA256_EmptyObject(t *testing.T) {
	t.Parallel()
	sum := sha256.Sum256(nil)
	want := hex.EncodeToString(sum[:])

	store := blobCoverFakeStore{
		newReader: func(context.Context, string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader("")), nil
		},
	}
	got, err := ComputeSHA256(context.Background(), store, "empty")
	require.NoError(t, err)
	assert.Equal(t, want, got)
}

func TestBlob_Cover_ComputeSHA256_NewReaderError(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("blob-cover open failed")
	store := blobCoverFakeStore{
		newReader: func(context.Context, string) (io.ReadCloser, error) {
			return nil, sentinel
		},
	}
	got, err := ComputeSHA256(context.Background(), store, "missing")
	require.Error(t, err)
	assert.ErrorIs(t, err, sentinel)
	assert.Empty(t, got)
}

func TestBlob_Cover_ComputeSHA256_ReadError(t *testing.T) {
	t.Parallel()
	var closed bool
	store := blobCoverFakeStore{
		newReader: func(context.Context, string) (io.ReadCloser, error) {
			return blobCoverErrReader{closed: &closed}, nil
		},
	}
	got, err := ComputeSHA256(context.Background(), store, "broken")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "blob-cover boom read")
	assert.Empty(t, got)
	assert.True(t, closed, "reader should be closed even on read error")
}
