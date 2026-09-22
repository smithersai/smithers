package gcsblob

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/option"
)

type gcsHObject struct {
	body        []byte
	contentType string
}

type gcsHFakeServer struct {
	server *httptest.Server

	mu                sync.Mutex
	objects           map[string]gcsHObject
	attrsStatuses     map[string]int
	deleteStatuses    map[string]int
	downloadStatuses  map[string]int
	uploadStatuses    map[string]int
	truncatedDownload map[string]bool
}

func gcsHNewFakeServer(t *testing.T) *gcsHFakeServer {
	t.Helper()
	fake := &gcsHFakeServer{
		objects:           make(map[string]gcsHObject),
		attrsStatuses:     make(map[string]int),
		deleteStatuses:    make(map[string]int),
		downloadStatuses:  make(map[string]int),
		uploadStatuses:    make(map[string]int),
		truncatedDownload: make(map[string]bool),
	}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.serveHTTP))
	t.Cleanup(fake.server.Close)
	return fake
}

func gcsHNewFakeClient(t *testing.T, fake *gcsHFakeServer) *storage.Client {
	t.Helper()
	client, err := storage.NewClient(
		context.Background(),
		option.WithEndpoint(fake.server.URL+"/storage/v1/"),
		option.WithoutAuthentication(),
		storage.WithJSONReads(),
	)
	require.NoError(t, err)
	client.SetRetry(storage.WithPolicy(storage.RetryNever))
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func (f *gcsHFakeServer) putObject(bucket, object string, body []byte, contentType string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[gcsHKey(bucket, object)] = gcsHObject{body: append([]byte(nil), body...), contentType: contentType}
}

func (f *gcsHFakeServer) object(bucket, object string) (gcsHObject, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	obj, ok := f.objects[gcsHKey(bucket, object)]
	obj.body = append([]byte(nil), obj.body...)
	return obj, ok
}

func (f *gcsHFakeServer) setAttrsStatus(bucket, object string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attrsStatuses[gcsHKey(bucket, object)] = status
}

func (f *gcsHFakeServer) setDeleteStatus(bucket, object string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleteStatuses[gcsHKey(bucket, object)] = status
}

func (f *gcsHFakeServer) setDownloadStatus(bucket, object string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.downloadStatuses[gcsHKey(bucket, object)] = status
}

func (f *gcsHFakeServer) setUploadStatus(bucket, object string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.uploadStatuses[gcsHKey(bucket, object)] = status
}

func (f *gcsHFakeServer) setTruncatedDownload(bucket, object string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.truncatedDownload[gcsHKey(bucket, object)] = true
}

func (f *gcsHFakeServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasPrefix(r.URL.EscapedPath(), "/upload/storage/v1/b/"):
		f.serveUpload(w, r)
	case strings.HasPrefix(r.URL.EscapedPath(), "/storage/v1/b/"):
		f.serveObject(w, r)
	default:
		gcsHWriteError(w, http.StatusNotFound)
	}
}

func (f *gcsHFakeServer) serveUpload(w http.ResponseWriter, r *http.Request) {
	bucket, ok := gcsHUploadBucket(r.URL.EscapedPath())
	if !ok || r.Method != http.MethodPost {
		gcsHWriteError(w, http.StatusNotFound)
		return
	}
	object := r.URL.Query().Get("name")
	if object == "" {
		gcsHWriteError(w, http.StatusBadRequest)
		return
	}

	status := f.uploadStatus(bucket, object)
	if status != 0 {
		_, _ = io.Copy(io.Discard, r.Body)
		gcsHWriteError(w, status)
		return
	}

	body, contentType, err := gcsHReadMultipartPayload(r)
	if err != nil {
		gcsHWriteError(w, http.StatusBadRequest)
		return
	}

	f.mu.Lock()
	f.objects[gcsHKey(bucket, object)] = gcsHObject{body: body, contentType: contentType}
	f.mu.Unlock()
	gcsHWriteObjectJSON(w, bucket, object, len(body), contentType)
}

func (f *gcsHFakeServer) serveObject(w http.ResponseWriter, r *http.Request) {
	bucket, object, ok := gcsHObjectPath(r.URL.EscapedPath())
	if !ok {
		gcsHWriteError(w, http.StatusNotFound)
		return
	}

	switch r.Method {
	case http.MethodGet:
		if r.URL.Query().Get("alt") == "media" {
			f.serveDownload(w, bucket, object)
			return
		}
		f.serveAttrs(w, bucket, object)
	case http.MethodDelete:
		f.serveDelete(w, bucket, object)
	default:
		gcsHWriteError(w, http.StatusMethodNotAllowed)
	}
}

func (f *gcsHFakeServer) serveAttrs(w http.ResponseWriter, bucket, object string) {
	if status := f.attrsStatus(bucket, object); status != 0 {
		gcsHWriteError(w, status)
		return
	}
	obj, ok := f.object(bucket, object)
	if !ok {
		gcsHWriteError(w, http.StatusNotFound)
		return
	}
	gcsHWriteObjectJSON(w, bucket, object, len(obj.body), obj.contentType)
}

func (f *gcsHFakeServer) serveDelete(w http.ResponseWriter, bucket, object string) {
	if status := f.deleteStatus(bucket, object); status != 0 {
		gcsHWriteError(w, status)
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	key := gcsHKey(bucket, object)
	if _, ok := f.objects[key]; !ok {
		gcsHWriteError(w, http.StatusNotFound)
		return
	}
	delete(f.objects, key)
	w.WriteHeader(http.StatusNoContent)
}

func (f *gcsHFakeServer) serveDownload(w http.ResponseWriter, bucket, object string) {
	if status := f.downloadStatus(bucket, object); status != 0 {
		gcsHWriteError(w, status)
		return
	}
	obj, ok := f.object(bucket, object)
	if !ok {
		gcsHWriteError(w, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", obj.contentType)
	w.Header().Set("X-Goog-Metageneration", "1")
	if f.isTruncatedDownload(bucket, object) {
		w.Header().Set("Content-Length", strconv.Itoa(len(obj.body)+8))
		_, _ = w.Write(obj.body)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(obj.body)))
	_, _ = w.Write(obj.body)
}

func (f *gcsHFakeServer) attrsStatus(bucket, object string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attrsStatuses[gcsHKey(bucket, object)]
}

func (f *gcsHFakeServer) deleteStatus(bucket, object string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deleteStatuses[gcsHKey(bucket, object)]
}

func (f *gcsHFakeServer) downloadStatus(bucket, object string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.downloadStatuses[gcsHKey(bucket, object)]
}

func (f *gcsHFakeServer) uploadStatus(bucket, object string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.uploadStatuses[gcsHKey(bucket, object)]
}

func (f *gcsHFakeServer) isTruncatedDownload(bucket, object string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.truncatedDownload[gcsHKey(bucket, object)]
}

func gcsHReadMultipartPayload(r *http.Request) ([]byte, string, error) {
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return nil, "", err
	}
	if !strings.HasPrefix(mediaType, "multipart/") {
		return nil, "", fmt.Errorf("unexpected media type %q", mediaType)
	}
	reader := multipart.NewReader(r.Body, params["boundary"])
	var payload []byte
	var contentType string
	partIndex := 0
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", err
		}
		partBody, err := io.ReadAll(part)
		if err != nil {
			return nil, "", err
		}
		if partIndex > 0 {
			payload = partBody
			contentType = part.Header.Get("Content-Type")
		}
		partIndex++
	}
	if partIndex < 2 {
		return nil, "", fmt.Errorf("missing media part")
	}
	return payload, contentType, nil
}

func gcsHUploadBucket(escapedPath string) (string, bool) {
	rest := strings.TrimPrefix(escapedPath, "/upload/storage/v1/b/")
	bucket, suffix, ok := strings.Cut(rest, "/o")
	return bucket, ok && suffix == ""
}

func gcsHObjectPath(escapedPath string) (string, string, bool) {
	rest := strings.TrimPrefix(escapedPath, "/storage/v1/b/")
	bucket, object, ok := strings.Cut(rest, "/o/")
	if !ok {
		return "", "", false
	}
	decoded, err := url.PathUnescape(object)
	if err != nil {
		return "", "", false
	}
	return bucket, decoded, true
}

func gcsHKey(bucket, object string) string {
	return bucket + "/" + object
}

func gcsHWriteObjectJSON(w http.ResponseWriter, bucket, object string, size int, contentType string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"kind":        "storage#object",
		"bucket":      bucket,
		"name":        object,
		"size":        strconv.Itoa(size),
		"contentType": contentType,
	})
}

func gcsHWriteError(w http.ResponseWriter, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":    status,
			"message": http.StatusText(status),
		},
	})
}

func TestGCS_H_NewGCSStoreHTTPClientClosures(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const bucket = "h-bucket"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSStore(client, bucket)
	fake.putObject(bucket, "objects/existing.txt", []byte("payload"), "text/plain")

	exists, err := store.Exists(ctx, "objects/existing.txt")
	require.NoError(t, err)
	assert.True(t, exists)

	attrs, err := store.Stat(ctx, "objects/existing.txt")
	require.NoError(t, err)
	assert.Equal(t, int64(len("payload")), attrs.Size)

	reader, err := store.NewReader(ctx, "objects/existing.txt")
	require.NoError(t, err)
	got, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	assert.Equal(t, "payload", string(got))

	require.NoError(t, store.Delete(ctx, "objects/existing.txt"))

	exists, err = store.Exists(ctx, "objects/existing.txt")
	require.NoError(t, err)
	assert.False(t, exists)

	require.NoError(t, store.Delete(ctx, "objects/existing.txt"))

	_, err = store.Stat(ctx, "objects/existing.txt")
	require.ErrorIs(t, err, blob.ErrObjectNotFound)

	reader, err = store.NewReader(ctx, "objects/existing.txt")
	require.ErrorIs(t, err, blob.ErrObjectNotFound)
	assert.Nil(t, reader)
}

func TestGCS_H_NewGCSStoreHTTPClientErrorBranches(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const bucket = "h-bucket-errors"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSStore(client, bucket)

	fake.setAttrsStatus(bucket, "objects/attrs-500.txt", http.StatusInternalServerError)
	exists, err := store.Exists(ctx, "objects/attrs-500.txt")
	require.Error(t, err)
	assert.False(t, exists)

	_, err = store.Stat(ctx, "objects/attrs-500.txt")
	require.Error(t, err)
	assert.NotErrorIs(t, err, blob.ErrObjectNotFound)

	fake.putObject(bucket, "objects/delete-500.txt", []byte("delete"), "text/plain")
	fake.setDeleteStatus(bucket, "objects/delete-500.txt", http.StatusInternalServerError)
	err = store.Delete(ctx, "objects/delete-500.txt")
	require.Error(t, err)

	fake.putObject(bucket, "objects/download-500.txt", []byte("download"), "text/plain")
	fake.setDownloadStatus(bucket, "objects/download-500.txt", http.StatusInternalServerError)
	reader, err := store.NewReader(ctx, "objects/download-500.txt")
	require.Error(t, err)
	assert.Nil(t, reader)
}
