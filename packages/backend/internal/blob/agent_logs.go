package blob

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"cloud.google.com/go/storage"
)

const MaxAgentSessionLogBytes = 10 << 20 // 10 MiB

// AgentLogStore defines the interface for storing and retrieving agent session logs in GCS.
type AgentLogStore interface {
	PutSessionLog(ctx context.Context, repositoryID int64, sessionID string, payload []byte) error
	GetSessionLog(ctx context.Context, repositoryID int64, sessionID string) ([]byte, error)
}

// FilesystemAgentLogStore keeps transcript retention bytes in the same durable
// local volume as the other single-owner blob classes.
type FilesystemAgentLogStore struct {
	store *FilesystemStore
}

func NewFilesystemAgentLogStore(store *FilesystemStore) *FilesystemAgentLogStore {
	return &FilesystemAgentLogStore{store: store}
}

func (s *FilesystemAgentLogStore) PutSessionLog(ctx context.Context, repositoryID int64, sessionID string, payload []byte) error {
	key := AgentLogObjectKey(repositoryID, sessionID)
	if err := validateAgentLogPayloadSize(payload); err != nil {
		return fmt.Errorf("store agent log %s: %w", key, err)
	}
	if s == nil || s.store == nil {
		return errors.New("filesystem agent log store is unavailable")
	}
	return s.store.Put(ctx, key, "application/json", bytes.NewReader(payload))
}

func (s *FilesystemAgentLogStore) GetSessionLog(ctx context.Context, repositoryID int64, sessionID string) ([]byte, error) {
	key := AgentLogObjectKey(repositoryID, sessionID)
	if s == nil || s.store == nil {
		return nil, errors.New("filesystem agent log store is unavailable")
	}
	r, err := s.store.NewReader(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("open agent log %s: %w", key, err)
	}
	defer func() { _ = r.Close() }()
	payload, err := io.ReadAll(io.LimitReader(r, MaxAgentSessionLogBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read agent log %s: %w", key, err)
	}
	if len(payload) > MaxAgentSessionLogBytes {
		return nil, fmt.Errorf("read agent log %s: payload exceeds %d bytes", key, MaxAgentSessionLogBytes)
	}
	return payload, nil
}

// AgentLogObjectKey returns the GCS object key for an agent session log.
// Format: agent-logs/{repo_id}/{session_id}.json
func AgentLogObjectKey(repositoryID int64, sessionID string) string {
	return fmt.Sprintf("agent-logs/%d/%s.json", repositoryID, sessionID)
}

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
	key := AgentLogObjectKey(repositoryID, sessionID)
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
	key := AgentLogObjectKey(repositoryID, sessionID)
	r, err := s.client.Bucket(s.bucket).Object(key).NewReader(ctx)
	if errors.Is(err, storage.ErrObjectNotExist) && s.readFallbackBucket != "" && s.readFallbackBucket != s.bucket {
		r, err = s.client.Bucket(s.readFallbackBucket).Object(key).NewReader(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("open agent log %s: %w", key, err)
	}
	defer func() { _ = r.Close() }()
	data, err := io.ReadAll(io.LimitReader(r, MaxAgentSessionLogBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read agent log %s: %w", key, err)
	}
	if len(data) > MaxAgentSessionLogBytes {
		return nil, fmt.Errorf("read agent log %s: payload exceeds %d bytes", key, MaxAgentSessionLogBytes)
	}
	return data, nil
}

// MemoryAgentLogStore implements AgentLogStore in memory for testing.
type MemoryAgentLogStore struct {
	mu   sync.RWMutex
	logs map[string][]byte
}

// NewMemoryAgentLogStore creates a new in-memory agent log store.
func NewMemoryAgentLogStore() *MemoryAgentLogStore {
	return &MemoryAgentLogStore{logs: make(map[string][]byte)}
}

// PutSessionLog stores the agent session log in memory.
func (s *MemoryAgentLogStore) PutSessionLog(_ context.Context, repositoryID int64, sessionID string, payload []byte) error {
	key := AgentLogObjectKey(repositoryID, sessionID)
	if err := validateAgentLogPayloadSize(payload); err != nil {
		return fmt.Errorf("store agent log %s: %w", key, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs[key] = append([]byte(nil), payload...)
	return nil
}

// GetSessionLog retrieves the agent session log from memory.
func (s *MemoryAgentLogStore) GetSessionLog(_ context.Context, repositoryID int64, sessionID string) ([]byte, error) {
	key := AgentLogObjectKey(repositoryID, sessionID)
	s.mu.RLock()
	data, ok := s.logs[key]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("agent log not found: %s", key)
	}
	return append([]byte(nil), data...), nil
}

func validateAgentLogPayloadSize(payload []byte) error {
	if len(payload) > MaxAgentSessionLogBytes {
		return fmt.Errorf("payload exceeds %d bytes", MaxAgentSessionLogBytes)
	}
	return nil
}
