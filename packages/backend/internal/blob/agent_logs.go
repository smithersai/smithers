package blob

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

const MaxAgentSessionLogBytes = 10 << 20 // 10 MiB

// AgentLogStore stores and retrieves agent session logs across deployment adapters.
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

// AgentLogObjectKey returns the storage key for an agent session log.
// Format: agent-logs/{repo_id}/{session_id}.json
func AgentLogObjectKey(repositoryID int64, sessionID string) string {
	return fmt.Sprintf("agent-logs/%d/%s.json", repositoryID, sessionID)
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
