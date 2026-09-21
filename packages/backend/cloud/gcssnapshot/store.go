// Package gcssnapshot is the optional GCS archive adapter for clustered
// Microsandbox controllers. The common product and local process host do not
// import this package.
package gcssnapshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"

	"cloud.google.com/go/storage"
	"github.com/smithersai/smithers/packages/backend/internal/microsandbox/control"
)

type GCSObjectStore struct {
	client          *storage.Client
	bucket          string
	uploadChunkSize int
}

var _ control.SnapshotObjectStore = (*GCSObjectStore)(nil)

func NewGCSObjectStore(client *storage.Client, bucket string, uploadChunkSize ...int) (*GCSObjectStore, error) {
	if client == nil || strings.TrimSpace(bucket) == "" {
		return nil, errors.New("snapshot GCS client and bucket are required")
	}
	chunkSize := 0
	if len(uploadChunkSize) > 0 {
		chunkSize = uploadChunkSize[0]
		if chunkSize < 0 || (chunkSize > 0 && chunkSize%(256*1024) != 0) {
			return nil, errors.New("snapshot GCS upload chunk size must be zero or a positive multiple of 256 KiB")
		}
	}
	return &GCSObjectStore{client: client, bucket: strings.TrimSpace(bucket), uploadChunkSize: chunkSize}, nil
}

func (s *GCSObjectStore) Put(ctx context.Context, key string, source io.Reader) (string, string, int64, error) {
	key = strings.TrimPrefix(path.Clean("/"+key), "/")
	if key == "." || key == "" {
		return "", "", 0, errors.New("snapshot object key is required")
	}
	object := s.client.Bucket(s.bucket).Object(key)
	writer := object.NewWriter(ctx)
	if s.uploadChunkSize > 0 {
		writer.ChunkSize = s.uploadChunkSize
	}
	writer.ContentType = "application/x-tar"
	writer.CacheControl = "private, no-store"
	hash := sha256.New()
	size, copyErr := io.Copy(writer, io.TeeReader(source, hash))
	closeErr := writer.Close()
	if copyErr != nil || closeErr != nil {
		_ = object.Delete(context.WithoutCancel(ctx))
		return "", "", 0, errors.Join(copyErr, closeErr)
	}
	digest := "sha256:" + hex.EncodeToString(hash.Sum(nil))
	return "gs://" + s.bucket + "/" + key, digest, size, nil
}

func (s *GCSObjectStore) Open(ctx context.Context, objectURI string) (io.ReadCloser, error) {
	key, err := s.objectKey(objectURI)
	if err != nil {
		return nil, err
	}
	return s.client.Bucket(s.bucket).Object(key).NewReader(ctx)
}

func (s *GCSObjectStore) Delete(ctx context.Context, objectURI string) error {
	if strings.TrimSpace(objectURI) == "" {
		return nil
	}
	key, err := s.objectKey(objectURI)
	if err != nil {
		return err
	}
	err = s.client.Bucket(s.bucket).Object(key).Delete(ctx)
	if errors.Is(err, storage.ErrObjectNotExist) {
		return nil
	}
	return err
}

func (s *GCSObjectStore) objectKey(objectURI string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(objectURI))
	if err != nil || parsed.Scheme != "gs" || parsed.Host != s.bucket {
		return "", fmt.Errorf("snapshot object URI is outside configured bucket")
	}
	key := strings.TrimPrefix(path.Clean(parsed.Path), "/")
	if key == "." || key == "" {
		return "", errors.New("snapshot object URI has no key")
	}
	return key, nil
}
