package blob

import (
	"context"
	"errors"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newPurgeFenceTestStore(t *testing.T, gate LegacyFinalKeyPurgeGate) (*LegacyFinalKeyPurgeFencedStore, *[]string) {
	t.Helper()
	deleted := []string{}
	base := NewGCSStoreWithHooks(
		"test-bucket",
		func(string, string, *storage.SignedURLOptions) (string, error) { return "https://example.test", nil },
		func(context.Context, string, string) (bool, error) { return true, nil },
		func(_ context.Context, _ string, key string) error {
			deleted = append(deleted, key)
			return nil
		},
		func(context.Context, string, string) (ObjectAttrs, error) { return ObjectAttrs{}, nil },
	)
	store, err := NewLegacyFinalKeyPurgeFencedStore(base, gate)
	require.NoError(t, err)
	return store, &deleted
}

func TestLegacyFinalKeyPurgeFencedStoreFailsClosedForFinalKeys(t *testing.T) {
	gateCalls := 0
	store, deleted := newPurgeFenceTestStore(t, func(context.Context) (bool, error) {
		gateCalls++
		return false, nil
	})

	err := store.Delete(context.Background(), "repos/7/lfs/abc")
	require.ErrorIs(t, err, ErrLegacyFinalKeyPurgeFenced)
	err = store.PurgeAllGenerations(context.Background(), "workflow-artifacts/7/file")
	require.ErrorIs(t, err, ErrLegacyFinalKeyPurgeFenced)
	assert.Equal(t, 2, gateCalls)
	assert.Empty(t, *deleted)
}

func TestLegacyFinalKeyPurgeFencedStoreAllowsOnlyKnownStagingNamespaces(t *testing.T) {
	gateCalls := 0
	store, deleted := newPurgeFenceTestStore(t, func(context.Context) (bool, error) {
		gateCalls++
		return false, nil
	})

	keys := []string{
		"lfs-pending/7/abc",
		"pending/workflow-caches/cache.tgz",
		"pending/workflow-artifacts/artifact.bin",
		"pending/issue-artifacts/attachment.bin",
		"pending/release-assets/release.bin",
	}
	for _, key := range keys {
		require.NoError(t, store.PurgeAllGenerations(context.Background(), key))
	}
	assert.Zero(t, gateCalls)
	assert.Equal(t, keys, *deleted)

	err := store.Delete(context.Background(), "pending/unknown/final-key")
	require.ErrorIs(t, err, ErrLegacyFinalKeyPurgeFenced)
}

func TestLegacyFinalKeyPurgeFencedStoreRechecksGateForEveryFinalPurge(t *testing.T) {
	gateCalls := 0
	store, deleted := newPurgeFenceTestStore(t, func(context.Context) (bool, error) {
		gateCalls++
		return gateCalls == 1, nil
	})

	require.NoError(t, store.Delete(context.Background(), "final/one"))
	err := store.PurgeAllGenerations(context.Background(), "final/two")
	require.ErrorIs(t, err, ErrLegacyFinalKeyPurgeFenced)
	assert.Equal(t, 2, gateCalls)
	assert.Equal(t, []string{"final/one"}, *deleted)
}

func TestLegacyFinalKeyPurgeFencedStorePropagatesGateFailure(t *testing.T) {
	sentinel := errors.New("database unavailable")
	store, _ := newPurgeFenceTestStore(t, func(context.Context) (bool, error) {
		return false, sentinel
	})

	err := store.Delete(context.Background(), "final/key")
	require.Error(t, err)
	assert.ErrorIs(t, err, sentinel)
}

func TestLegacyFinalKeyPurgeFencedStorePreservesCreateOnlyCapabilities(t *testing.T) {
	store, _ := newPurgeFenceTestStore(t, func(context.Context) (bool, error) { return false, nil })

	_, signerOK := any(store).(CreateOnlyUploadSigner)
	_, promoterOK := any(store).(CreateOnlyPromoter)
	_, purgerOK := any(store).(GenerationPurger)
	assert.True(t, signerOK)
	assert.True(t, promoterOK)
	assert.True(t, purgerOK)

	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "pending/workflow-artifacts/a", "application/octet-stream", 1, time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "https://example.test", upload.URL)
}
