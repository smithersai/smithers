package blob

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPurgeAllGenerationsUsesGCSHookForAnyExactKey(t *testing.T) {
	t.Parallel()

	var purged string
	store := &GCSStore{
		bucket: "bucket",
		purgeFn: func(_ context.Context, bucket, key string) error {
			require.Equal(t, "bucket", bucket)
			purged = key
			return nil
		},
	}

	require.NoError(t, PurgeAllGenerations(context.Background(), store, "arbitrary/final/key"))
	require.Equal(t, "arbitrary/final/key", purged)
}

type recordingCreateOnlySigner struct {
	Store
	expiry time.Duration
}

func (s *recordingCreateOnlySigner) SignedCreateOnlyUploadURL(_ context.Context, _ string, _ string, _ int64, expiry time.Duration) (SignedUpload, error) {
	s.expiry = expiry
	return SignedUpload{URL: "https://upload.test"}, nil
}

func TestSignedCreateOnlyUploadClampsArbitrarySignerExpiry(t *testing.T) {
	t.Parallel()
	store := &recordingCreateOnlySigner{}
	_, err := SignedCreateOnlyUpload(context.Background(), store, "key", "application/octet-stream", 1, MaxSignedURLExpiry+time.Hour)
	require.NoError(t, err)
	require.Equal(t, MaxSignedURLExpiry, store.expiry)
}

type deleteOnlyStore struct {
	Store
	deleted string
	err     error
}

func (s *deleteOnlyStore) Delete(_ context.Context, key string) error {
	s.deleted = key
	return s.err
}

func TestPurgeAllGenerationsFallsBackToDelete(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("delete failed")
	store := &deleteOnlyStore{err: wantErr}
	err := PurgeAllGenerations(context.Background(), store, "local/key")
	require.ErrorIs(t, err, wantErr)
	require.Equal(t, "local/key", store.deleted)
}
