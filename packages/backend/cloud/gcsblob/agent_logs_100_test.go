package gcsblob

import (
	"bytes"
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAgentLogs_H_GCSStorePutGetRoundTrip(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const bucket = "h-agent-logs"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStore(client, bucket)
	payload := []byte(`{"steps":[{"status":"ok"}]}`)

	require.NoError(t, store.PutSessionLog(ctx, 42, "session-round-trip", payload))

	key := blob.AgentLogObjectKey(42, "session-round-trip")
	stored, ok := fake.object(bucket, key)
	require.True(t, ok)
	assert.Equal(t, payload, stored.body)
	assert.Equal(t, "application/json", stored.contentType)

	got, err := store.GetSessionLog(ctx, 42, "session-round-trip")
	require.NoError(t, err)
	assert.Equal(t, payload, got)
}

func TestAgentLogs_H_GCSStorePutWriteError(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const bucket = "h-agent-logs-write"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStore(client, bucket)

	err := store.PutSessionLog(ctx, 7, string([]byte{0xff}), []byte(`{"bad":"name"}`))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "write agent log")
	assert.Contains(t, err.Error(), "not valid UTF-8")
}

func TestAgentLogs_H_GCSStorePutCloseError(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const bucket = "h-agent-logs-close"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStore(client, bucket)
	key := blob.AgentLogObjectKey(8, "session-close-error")
	fake.setUploadStatus(bucket, key, http.StatusInternalServerError)

	err := store.PutSessionLog(ctx, 8, "session-close-error", []byte(`{"close":"fails"}`))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "close agent log writer")
}

func TestAgentLogs_H_GCSStoreGetOpenErrors(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const bucket = "h-agent-logs-open"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStore(client, bucket)

	_, err := store.GetSessionLog(ctx, 9, "missing")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "open agent log")

	key := blob.AgentLogObjectKey(9, "server-error")
	fake.putObject(bucket, key, []byte(`{"open":"server-error"}`), "application/json")
	fake.setDownloadStatus(bucket, key, http.StatusInternalServerError)
	_, err = store.GetSessionLog(ctx, 9, "server-error")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "open agent log")
}

func TestAgentLogs_H_GCSStoreGetReadError(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const bucket = "h-agent-logs-read"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStore(client, bucket)
	key := blob.AgentLogObjectKey(10, "truncated")
	fake.putObject(bucket, key, []byte(`{"short":true}`), "application/json")
	fake.setTruncatedDownload(bucket, key)

	_, err := store.GetSessionLog(ctx, 10, "truncated")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read agent log")
}

func TestAgentLogs_H_GCSStoreGetOversized(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const bucket = "h-agent-logs-oversized"
	fake := gcsHNewFakeServer(t)
	client := gcsHNewFakeClient(t, fake)
	store := NewGCSAgentLogStore(client, bucket)
	key := blob.AgentLogObjectKey(11, "oversized")
	payload := append(bytes.Repeat([]byte("a"), blob.MaxAgentSessionLogBytes), 'b')
	fake.putObject(bucket, key, payload, "application/json")

	_, err := store.GetSessionLog(ctx, 11, "oversized")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "payload exceeds")
	assert.True(t, strings.Contains(err.Error(), key))
}
