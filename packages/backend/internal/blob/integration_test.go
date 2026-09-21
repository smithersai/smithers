package blob

import (
	"context"
	"errors"
	"io"
	"os"
	"strconv"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	"google.golang.org/api/option"
)

func requireGCSEmulator(t *testing.T) {
	t.Helper()
	endpoint := os.Getenv("SMITHERS_TEST_GCS_ENDPOINT")
	if endpoint == "" {
		t.Skip("set SMITHERS_TEST_GCS_ENDPOINT to run GCS integration tests")
	}
	t.Setenv("STORAGE_EMULATOR_HOST", endpoint)
}

func newEmulatorClientAndBucket(t *testing.T) (*storage.Client, string) {
	t.Helper()
	requireGCSEmulator(t)
	client, err := storage.NewClient(context.Background(), option.WithoutAuthentication())
	if err != nil {
		t.Fatalf("create storage client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	bucket := "smithers-test-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if err := client.Bucket(bucket).Create(context.Background(), "smithers-test-project", nil); err != nil {
		t.Fatalf("create test bucket: %v", err)
	}
	return client, bucket
}

func uploadObject(t *testing.T, client *storage.Client, bucket, key string) {
	t.Helper()
	w := client.Bucket(bucket).Object(key).NewWriter(context.Background())
	if _, err := io.WriteString(w, "test payload"); err != nil {
		t.Fatalf("write object: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close object writer: %v", err)
	}
}

func TestGCSIntegration_Exists_ReturnsTrueForUploadedObject(t *testing.T) {
	client, bucket := newEmulatorClientAndBucket(t)
	key := "objects/existing.txt"
	uploadObject(t, client, bucket, key)
	store := NewGCSStore(client, bucket)
	exists, err := store.Exists(context.Background(), key)
	if err != nil || !exists {
		t.Fatalf("expected object to exist: exists=%v err=%v", exists, err)
	}
}

func TestGCSIntegration_Exists_ReturnsFalseForMissingObject(t *testing.T) {
	client, bucket := newEmulatorClientAndBucket(t)
	store := NewGCSStore(client, bucket)
	exists, err := store.Exists(context.Background(), "objects/missing.txt")
	if err != nil || exists {
		t.Fatalf("expected missing object: exists=%v err=%v", exists, err)
	}
}

func TestGCSIntegration_Delete_RemovesObject(t *testing.T) {
	client, bucket := newEmulatorClientAndBucket(t)
	key := "objects/delete-me.txt"
	uploadObject(t, client, bucket, key)
	store := NewGCSStore(client, bucket)
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	exists, err := store.Exists(context.Background(), key)
	if err != nil || exists {
		t.Fatalf("expected deleted object: exists=%v err=%v", exists, err)
	}
}

func TestGCSIntegration_StoreContract(t *testing.T) {
	requireGCSEmulator(t)
	runStoreContract(t, func(t *testing.T) Store {
		client, bucket := newEmulatorClientAndBucket(t)
		return NewGCSStore(client, bucket)
	})
}

func TestGCSIntegration_SignedUploadURL_WithHook(t *testing.T) {
	_, bucket := newEmulatorClientAndBucket(t)
	store := NewGCSStoreWithHooks(bucket, func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		if opts.Method != "PUT" {
			return "", errors.New("unexpected method")
		}
		return "https://signed-upload.example.test", nil
	}, nil, nil, nil)
	url, err := store.SignedUploadURL(context.Background(), "objects/signed-upload.txt", "text/plain", 0, time.Minute)
	if err != nil || url == "" {
		t.Fatalf("signed upload url: %v %v", url, err)
	}
}

func TestGCSIntegration_SignedDownloadURL_WithHook(t *testing.T) {
	_, bucket := newEmulatorClientAndBucket(t)
	store := NewGCSStoreWithHooks(bucket, func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
		if opts.Method != "GET" {
			return "", errors.New("unexpected method")
		}
		return "https://signed-download.example.test", nil
	}, nil, nil, nil)
	url, err := store.SignedDownloadURL(context.Background(), "objects/signed-download.txt", time.Minute)
	if err != nil || url == "" {
		t.Fatalf("signed download url: %v %v", url, err)
	}
}
