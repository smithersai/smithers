package blob

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestFilesystemStore(t *testing.T, root string, mutate ...func(*FilesystemConfig)) *FilesystemStore {
	t.Helper()
	cfg := FilesystemConfig{Root: root, PublicBaseURL: "https://smithers.test", SigningKey: bytes.Repeat([]byte{0x42}, 32)}
	for _, fn := range mutate {
		fn(&cfg)
	}
	store, err := NewFilesystemStore(cfg)
	require.NoError(t, err)
	return store
}

func readObject(t *testing.T, store Store, key string) string {
	t.Helper()
	r, err := store.NewReader(context.Background(), key)
	require.NoError(t, err)
	defer func() { require.NoError(t, r.Close()) }()
	payload, err := io.ReadAll(r)
	require.NoError(t, err)
	return string(payload)
}

// runStoreContract is deliberately adapter-neutral so the clustered adapter
// can run the same behavioral suite during the Plue conformance step.
func runStoreContract(t *testing.T, factory func(*testing.T) Store) {
	t.Helper()
	t.Run("put stat open delete", func(t *testing.T) {
		store := factory(t)
		require.NoError(t, Put(context.Background(), store, "repos/7/artifacts/a", "text/plain", strings.NewReader("durable")))
		attrs, err := store.Stat(context.Background(), "repos/7/artifacts/a")
		require.NoError(t, err)
		assert.Equal(t, int64(7), attrs.Size)
		if attrs.SHA256 != "" {
			assert.Equal(t, "54dab9eb6d3204a0b42800148196ed4785d258f980432579b62ef0d9db0207b8", attrs.SHA256)
		}
		assert.Equal(t, "durable", readObject(t, store, "repos/7/artifacts/a"))
		require.NoError(t, store.Delete(context.Background(), "repos/7/artifacts/a"))
		require.NoError(t, store.Delete(context.Background(), "repos/7/artifacts/a"))
		_, err = store.Stat(context.Background(), "repos/7/artifacts/a")
		assert.ErrorIs(t, err, ErrObjectNotFound)
	})

	t.Run("create only promotion", func(t *testing.T) {
		store := factory(t)
		promoter := store.(CreateOnlyPromoter)
		require.NoError(t, Put(context.Background(), store, "pending/workflow-artifacts/repos/8/a", "", strings.NewReader("first")))
		require.NoError(t, promoter.PromoteCreateOnly(context.Background(), "pending/workflow-artifacts/repos/8/a", "repos/8/artifacts/a"))
		require.NoError(t, Put(context.Background(), store, "pending/workflow-artifacts/repos/8/b", "", strings.NewReader("other")))
		assert.ErrorIs(t, promoter.PromoteCreateOnly(context.Background(), "pending/workflow-artifacts/repos/8/b", "repos/8/artifacts/a"), ErrObjectAlreadyExists)
		assert.Equal(t, "first", readObject(t, store, "repos/8/artifacts/a"))
		assert.Equal(t, "other", readObject(t, store, "pending/workflow-artifacts/repos/8/b"))
	})

	t.Run("unsafe keys", func(t *testing.T) {
		store := factory(t)
		for _, key := range []string{"../escape", "/absolute", "a/../../escape", "a\\b", ".tmp/private", " repos/1/a"} {
			assert.Error(t, Put(context.Background(), store, key, "", strings.NewReader("x")), key)
		}
	})
}

func TestFilesystemStoreContract(t *testing.T) {
	runStoreContract(t, func(t *testing.T) Store {
		return newTestFilesystemStore(t, t.TempDir())
	})
}

func TestFilesystemStoreRejectsSymlinkTraversal(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	store := newTestFilesystemStore(t, root)
	require.NoError(t, os.Symlink(outside, filepath.Join(root, "repos")))
	err := store.Put(context.Background(), "repos/1/object", "", strings.NewReader("escape"))
	require.Error(t, err)
	_, statErr := os.Stat(filepath.Join(outside, "1", "object"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestFilesystemStoreRejectsUnsafeSigningKeyFile(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "key")
	require.NoError(t, os.WriteFile(outside, bytes.Repeat([]byte{1}, 32), 0o600))
	require.NoError(t, os.Symlink(outside, filepath.Join(root, filesystemKeyFile)))
	_, err := NewFilesystemStore(FilesystemConfig{Root: root, PublicBaseURL: "https://smithers.test"})
	require.ErrorContains(t, err, "private regular file")
}

func TestFilesystemStorePersistsAndReconcilesInterruptedSpools(t *testing.T) {
	root := t.TempDir()
	first := newTestFilesystemStore(t, root, func(cfg *FilesystemConfig) { cfg.SigningKey = nil })
	require.NoError(t, first.Put(context.Background(), "repos/1/lfs/object", "", strings.NewReader("persisted")))
	orphan := filepath.Join(root, filesystemTempDir, "upload-crashed")
	require.NoError(t, os.WriteFile(orphan, []byte("partial"), 0o600))

	second := newTestFilesystemStore(t, root, func(cfg *FilesystemConfig) { cfg.SigningKey = nil })
	assert.Equal(t, "persisted", readObject(t, second, "repos/1/lfs/object"))
	_, err := os.Stat(orphan)
	assert.ErrorIs(t, err, os.ErrNotExist)

	u, err := first.SignedDownloadURL(context.Background(), "repos/1/lfs/object", time.Minute)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodGet, mustURLPath(t, u), nil)
	rec := httptest.NewRecorder()
	second.TransferHandler().ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "persisted", rec.Body.String(), "persisted signing key keeps in-flight URLs valid across restart")
}

func TestFilesystemTransferConcurrentCreateOnly(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "pending/workflow-artifacts/repos/42/runs/1/a", "application/octet-stream", 8, time.Minute)
	require.NoError(t, err)
	requestPath := mustURLPath(t, upload.URL)

	const contenders = 12
	statuses := make(chan int, contenders)
	var wg sync.WaitGroup
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := strings.Repeat(string(rune('a'+i)), 8)
			req := httptest.NewRequest(http.MethodPut, requestPath, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/octet-stream")
			rec := httptest.NewRecorder()
			store.TransferHandler().ServeHTTP(rec, req)
			statuses <- rec.Code
		}(i)
	}
	wg.Wait()
	close(statuses)
	created := 0
	for status := range statuses {
		if status == http.StatusCreated {
			created++
		} else {
			assert.Equal(t, http.StatusPreconditionFailed, status)
		}
	}
	assert.Equal(t, 1, created)
	assert.Len(t, readObject(t, store, "pending/workflow-artifacts/repos/42/runs/1/a"), 8)
}

func TestFilesystemTransferCredentialScopeExpiryAndValidation(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	store.now = func() time.Time { return time.Unix(1_000, 0) }
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "lfs-pending/19/"+strings.Repeat("a", 64), "application/octet-stream", 3, time.Minute)
	require.NoError(t, err)
	requestPath := mustURLPath(t, upload.URL)

	wrongMethod := httptest.NewRecorder()
	store.TransferHandler().ServeHTTP(wrongMethod, httptest.NewRequest(http.MethodGet, requestPath, nil))
	assert.Equal(t, http.StatusMethodNotAllowed, wrongMethod.Code)

	wrongSize := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, requestPath, strings.NewReader("xx"))
	req.Header.Set("Content-Type", "application/octet-stream")
	store.TransferHandler().ServeHTTP(wrongSize, req)
	assert.Equal(t, http.StatusBadRequest, wrongSize.Code)

	tampered := tamperTransferKey(t, requestPath, "lfs-pending/20/"+strings.Repeat("a", 64))
	tamperedRec := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, tampered, strings.NewReader("xxx"))
	req.Header.Set("Content-Type", "application/octet-stream")
	store.TransferHandler().ServeHTTP(tamperedRec, req)
	assert.Equal(t, http.StatusForbidden, tamperedRec.Code)

	store.now = func() time.Time { return time.Unix(1_061, 0) }
	expired := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, requestPath, strings.NewReader("xxx"))
	req.Header.Set("Content-Type", "application/octet-stream")
	store.TransferHandler().ServeHTTP(expired, req)
	assert.Equal(t, http.StatusForbidden, expired.Code)
}

func TestFilesystemTransferRejectsDigestMismatchWithoutPublishing(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	oid := strings.Repeat("0", 64)
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "lfs-pending/9/"+oid, "application/octet-stream", 3, time.Minute)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPut, mustURLPath(t, upload.URL), strings.NewReader("bad"))
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	store.TransferHandler().ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	exists, err := store.Exists(context.Background(), "lfs-pending/9/"+oid)
	require.NoError(t, err)
	assert.False(t, exists)
}

type failingReader struct {
	sent bool
}

func (r *failingReader) Read(p []byte) (int, error) {
	if !r.sent {
		r.sent = true
		copy(p, "part")
		return 4, nil
	}
	return 0, errors.New("connection interrupted")
}

func TestFilesystemStoreInterruptedAndQuotaFailuresPublishNothing(t *testing.T) {
	root := t.TempDir()
	store := newTestFilesystemStore(t, root, func(cfg *FilesystemConfig) { cfg.MaxBytes = 4 })
	_, err := store.writeObject(context.Background(), "repos/1/artifacts/interrupted", &failingReader{}, true, UnknownObjectSize, UnknownObjectSize, "")
	assert.EqualError(t, err, "connection interrupted")
	exists, statErr := store.Exists(context.Background(), "repos/1/artifacts/interrupted")
	require.NoError(t, statErr)
	assert.False(t, exists)

	err = store.Put(context.Background(), "repos/1/artifacts/full", "", strings.NewReader("12345"))
	assert.ErrorIs(t, err, ErrStorageFull)
	exists, statErr = store.Exists(context.Background(), "repos/1/artifacts/full")
	require.NoError(t, statErr)
	assert.False(t, exists)
	entries, err := os.ReadDir(filepath.Join(root, filesystemTempDir))
	require.NoError(t, err)
	assert.Empty(t, entries)
}

func TestFilesystemAgentLogsAreDurable(t *testing.T) {
	root := t.TempDir()
	first := NewFilesystemAgentLogStore(newTestFilesystemStore(t, root))
	require.NoError(t, first.PutSessionLog(context.Background(), 3, "session", []byte(`{"ok":true}`)))
	second := NewFilesystemAgentLogStore(newTestFilesystemStore(t, root))
	payload, err := second.GetSessionLog(context.Background(), 3, "session")
	require.NoError(t, err)
	assert.JSONEq(t, `{"ok":true}`, string(payload))
}

func mustURLPath(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	require.NoError(t, err)
	return parsed.RequestURI()
}

func tamperTransferKey(t *testing.T, requestPath, key string) string {
	t.Helper()
	token := strings.TrimPrefix(requestPath, filesystemTransferPath)
	parts := strings.Split(token, ".")
	require.Len(t, parts, 2)
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	require.NoError(t, err)
	var claims transferClaims
	require.NoError(t, json.Unmarshal(payload, &claims))
	claims.Key = key
	payload, err = json.Marshal(claims)
	require.NoError(t, err)
	return filesystemTransferPath + base64.RawURLEncoding.EncodeToString(payload) + "." + parts[1]
}
