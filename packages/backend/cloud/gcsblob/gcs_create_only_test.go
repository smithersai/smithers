package gcsblob

import (
	"context"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGCSStore_SignedCreateOnlyUploadURL_SignsGenerationPrecondition(t *testing.T) {
	t.Parallel()
	var gotBucket, gotObject string
	var gotOpts *storage.SignedURLOptions
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotBucket, gotObject, gotOpts = bucket, object, opts
		return "https://example.test/upload", nil
	}, nil, nil, nil)
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "path/object.bin", "application/octet-stream", 0, 5*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "https://example.test/upload", upload.URL)
	assert.Equal(t, "smithers-blobs", gotBucket)
	assert.Equal(t, "path/object.bin", gotObject)
	require.NotNil(t, gotOpts)
	assert.Equal(t, "PUT", gotOpts.Method)
	assert.Equal(t, "application/octet-stream", gotOpts.ContentType)
	assert.Equal(t, storage.SigningSchemeV4, gotOpts.Scheme,
		"create-only uploads must use V4 signing so extension headers are part of the signature")
	assert.Equal(t, []string{"x-goog-if-generation-match:0", "x-goog-content-length-range:0,0"}, gotOpts.Headers,
		"the generation precondition must be a signed header, not advisory")
	assert.Equal(t, map[string]string{
		"x-goog-if-generation-match":  "0",
		"x-goog-content-length-range": "0,0",
		"Content-Type":                "application/octet-stream",
	}, upload.Header, "every signed header must be surfaced so the uploader sends it")
}

func TestGCSStore_SignedCreateOnlyUploadURL_UnknownSizeOmitsBound(t *testing.T) {
	t.Parallel()
	var gotOpts *storage.SignedURLOptions
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotOpts = opts
		return "https://example.test/upload", nil
	}, nil, nil, nil)
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "path/object.bin", "application/octet-stream", blob.UnknownObjectSize, 5*time.Minute)
	require.NoError(t, err)
	require.NotNil(t, gotOpts)
	assert.Equal(t, []string{"x-goog-if-generation-match:0"}, gotOpts.Headers)
	assert.NotContains(t, upload.Header, "x-goog-content-length-range")
}

func TestGCSStore_SignedCreateOnlyUploadURL_EnforcesExactSize(t *testing.T) {
	t.Parallel()
	var gotOpts *storage.SignedURLOptions
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		gotOpts = opts
		return "https://example.test/upload", nil
	}, nil, nil, nil)
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "path/object.bin", "application/octet-stream", 42, 5*time.Minute)
	require.NoError(t, err)
	require.NotNil(t, gotOpts)
	assert.Equal(t, []string{"x-goog-if-generation-match:0", "x-goog-content-length-range:42,42"}, gotOpts.Headers)
	assert.Equal(t, "42,42", upload.Header["x-goog-content-length-range"])
}

func TestGCSStore_SignedCreateOnlyUploadURL_NoSigner(t *testing.T) {
	t.Parallel()
	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, nil, nil)
	_, err := store.SignedCreateOnlyUploadURL(context.Background(), "k", "application/octet-stream", 0, time.Minute)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "signer is not configured")
}

func TestGCSStore_SignedCreateOnlyUploadURL_PropagatesError(t *testing.T) {
	t.Parallel()
	expectedErr := errors.New("signer failed")
	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		return "", expectedErr
	}, nil, nil, nil)
	_, err := store.SignedCreateOnlyUploadURL(context.Background(), "k", "application/octet-stream", 0, time.Minute)
	assert.ErrorIs(t, err, expectedErr)
}

func TestGCSStore_DeletePendingUsesAllGenerationPurge(t *testing.T) {
	t.Parallel()
	var deleted, purged []string
	store := NewGCSStoreWithHooks("smithers-blobs", nil, nil, func(_ context.Context, _, object string) error {
		deleted = append(deleted, object)
		return nil
	}, nil)
	store.purgeFn = func(_ context.Context, _, object string) error {
		purged = append(purged, object)
		return nil
	}

	require.NoError(t, store.Delete(context.Background(), "lfs-pending/1/abc"))
	require.NoError(t, store.Delete(context.Background(), "repos/1/lfs/abc"))
	require.NoError(t, store.Delete(context.Background(), "repos/1/releases/abc"))
	assert.Equal(t, []string{"lfs-pending/1/abc", "repos/1/lfs/abc"}, purged)
	assert.Equal(t, []string{"repos/1/releases/abc"}, deleted)
}

// TestSignedCreateOnlyUpload_FallsBackForMemoryStore locks in that non-GCS
// stores keep their existing semantics: a plain signed URL with no required
// headers, and the MemoryStore still registers the key on signing.
func TestSignedCreateOnlyUpload_FallsBackForMemoryStore(t *testing.T) {
	t.Parallel()
	mem := blob.NewMemoryStore()
	upload, err := blob.SignedCreateOnlyUpload(context.Background(), mem, "k", "application/octet-stream", 0, time.Minute)
	require.NoError(t, err)
	plain, err := mem.SignedUploadURL(context.Background(), "k", "application/octet-stream", 0, time.Minute)
	require.NoError(t, err)
	assert.Equal(t, plain, upload.URL)
	assert.Empty(t, upload.Header, "in-memory uploads must not gain required headers")
	exists, err := mem.Exists(context.Background(), "k")
	require.NoError(t, err)
	assert.True(t, exists)
}

// fakeGenerationServer emulates the slice of GCS behavior that create-only
// signed uploads rely on: a V4 signature covers x-goog-if-generation-match, so
// GCS rejects a PUT that omits the signed header (403 signature mismatch) and
// rejects a PUT whose precondition fails (412) without touching the object.
type fakeGenerationServer struct {
	mu         sync.Mutex
	content    map[string][]byte
	generation map[string]int64
}

func (f *fakeGenerationServer) handler(signedHeaders map[string][]string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		key := strings.TrimPrefix(r.URL.Path, "/")
		for _, want := range signedHeaders[key] {
			parts := strings.SplitN(want, ":", 2)
			if r.Header.Get(parts[0]) != parts[1] {
				// A missing or altered signed header breaks the V4 signature.
				w.WriteHeader(http.StatusForbidden)
				return
			}
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if match := r.Header.Get("x-goog-if-generation-match"); match != "" {
			if fmt.Sprintf("%d", f.generation[key]) != match {
				w.WriteHeader(http.StatusPreconditionFailed)
				return
			}
		}
		f.content[key] = body
		f.generation[key]++
		w.WriteHeader(http.StatusOK)
	}
}

// TestGCSStore_CreateOnlyUpload_StaleURLCannotOverwriteGeneration1 walks the
// full corruption-window scenario: two live signed upload actions for the same
// key, the first upload lands and is verified, then the stale second action
// fires. With the generation precondition signed into both URLs the stale PUT
// gets 412 and generation-1 content survives untouched.
func TestGCSStore_CreateOnlyUpload_StaleURLCannotOverwriteGeneration1(t *testing.T) {
	t.Parallel()
	fake := &fakeGenerationServer{content: map[string][]byte{}, generation: map[string]int64{}}
	signedHeaders := map[string][]string{}
	server := httptest.NewServer(fake.handler(signedHeaders))
	defer server.Close()

	store := NewGCSStoreWithHooks("smithers-blobs", func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		signedHeaders[object] = append([]string{"Content-Type:" + opts.ContentType}, opts.Headers...)
		return server.URL + "/" + object, nil
	}, nil, nil, nil)

	doPut := func(upload blob.SignedUpload, body string) int {
		req, err := http.NewRequest(http.MethodPut, upload.URL, strings.NewReader(body))
		require.NoError(t, err)
		// Send exactly the headers the LFS action advertises, as a
		// spec-following client (git-lfs) would.
		for k, v := range upload.Header {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		return res.StatusCode
	}

	// Two concurrent batch calls hand out two live actions for the same key.
	first, err := store.SignedCreateOnlyUploadURL(context.Background(), "repos/1/lfs/abc", "application/octet-stream", blob.UnknownObjectSize, time.Minute)
	require.NoError(t, err)
	stale, err := store.SignedCreateOnlyUploadURL(context.Background(), "repos/1/lfs/abc", "application/octet-stream", blob.UnknownObjectSize, time.Minute)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, doPut(first, "verified content"))
	require.Equal(t, int64(1), fake.generation["repos/1/lfs/abc"])

	// The stale action fires after the first upload was verified+confirmed.
	assert.Equal(t, http.StatusPreconditionFailed, doPut(stale, "corrupted content"))
	assert.Equal(t, "verified content", string(fake.content["repos/1/lfs/abc"]),
		"generation 1 content must survive the stale write")
	assert.Equal(t, int64(1), fake.generation["repos/1/lfs/abc"])

	// A client that strips the precondition header breaks the signature and is
	// rejected outright — the header is mandatory, not advisory.
	bare := blob.SignedUpload{URL: stale.URL, Header: map[string]string{"Content-Type": "application/octet-stream"}}
	assert.Equal(t, http.StatusForbidden, doPut(bare, "corrupted content"))
	assert.Equal(t, "verified content", string(fake.content["repos/1/lfs/abc"]))
}
