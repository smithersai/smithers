package gcsblob

import (
	"cloud.google.com/go/storage"
	"context"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"io"
)

// GCSAgentLogStore implements AgentLogStore using Google Cloud Storage.
type GCSAgentLogStore struct {
	client *storage.Client
	bucket string
	// readFallbackBucket, when set, is consulted on read misses so transcripts
	// archived before the dedicated retention bucket existed stay retrievable.
	// Writes always go to bucket.
	readFallbackBucket string
}

// NewGCSAgentLogStore creates a new GCS-backed agent log store.
func NewGCSAgentLogStore(client *storage.Client, bucket string) *GCSAgentLogStore {
	return &GCSAgentLogStore{client: client, bucket: bucket}
}

// NewGCSAgentLogStoreWithReadFallback creates a GCS-backed agent log store
// that writes to bucket but falls back to readFallbackBucket when a session
// log is not found in bucket.
func NewGCSAgentLogStoreWithReadFallback(client *storage.Client, bucket, readFallbackBucket string) *GCSAgentLogStore {
	return &GCSAgentLogStore{client: client, bucket: bucket, readFallbackBucket: readFallbackBucket}
}

// Bucket returns the bucket session logs are written to.
func (s *GCSAgentLogStore) Bucket() string { return s.bucket }

// ReadFallbackBucket returns the bucket consulted on read misses ("" when no
// fallback is configured).
func (s *GCSAgentLogStore) ReadFallbackBucket() string { return s.readFallbackBucket }

// PutSessionLog writes the agent session log to GCS.
func (s *GCSAgentLogStore) PutSessionLog(ctx context.Context, repositoryID int64, sessionID string, payload []byte) error {
	key := blob.AgentLogObjectKey(repositoryID, sessionID)
	if err := validateAgentLogPayloadSize(payload); err != nil {
		return fmt.Errorf("validate agent log %s: %w", key, err)
	}
	w := s.client.Bucket(s.bucket).Object(key).NewWriter(ctx)
	w.ContentType = "application/json"
	if _, err := w.Write(payload); err != nil {
		_ = w.Close()
		return fmt.Errorf("write agent log %s: %w", key, err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close agent log writer %s: %w", key, err)
	}
	return nil
}

// GetSessionLog reads the agent session log from GCS, consulting the read
// fallback bucket (if configured) when the primary bucket has no object.
func (s *GCSAgentLogStore) GetSessionLog(ctx context.Context, repositoryID int64, sessionID string) ([]byte, error) {
	key := blob.AgentLogObjectKey(repositoryID, sessionID)
	r, err := s.client.Bucket(s.bucket).Object(key).NewReader(ctx)
	if errors.Is(err, storage.ErrObjectNotExist) && s.readFallbackBucket != "" && s.readFallbackBucket != s.bucket {
		r, err = s.client.Bucket(s.readFallbackBucket).Object(key).NewReader(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("open agent log %s: %w", key, err)
	}
	defer func() { _ = r.Close() }()
	data, err := io.ReadAll(io.LimitReader(r, blob.MaxAgentSessionLogBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read agent log %s: %w", key, err)
	}
	if len(data) > blob.MaxAgentSessionLogBytes {
		return nil, fmt.Errorf("read agent log %s: payload exceeds %d bytes", key, blob.MaxAgentSessionLogBytes)
	}
	return data, nil
}

func validateAgentLogPayloadSize(payload []byte) error {
	if len(payload) > blob.MaxAgentSessionLogBytes {
		return fmt.Errorf("payload exceeds %d bytes", blob.MaxAgentSessionLogBytes)
	}
	return nil
}

var _ blob.AgentLogStore = (*GCSAgentLogStore)(nil)
