package services

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestArchiveAgentTranscript_PaginatesAllMessagesInChronologicalOrder(t *testing.T) {
	const messageCount = 450
	const sessionID = "11111111-1111-1111-1111-111111111111"
	var pageCalls []db.ListAgentMessagesParams
	var archived []byte

	q := &mockAgentQuerier{
		listAgentMessagesFn: func(_ context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			pageCalls = append(pageCalls, arg)
			start := int(arg.PageOffset)
			if start >= messageCount {
				return nil, nil
			}
			end := min(start+int(arg.PageSize), messageCount)
			messages := make([]db.AgentMessage, 0, end-start)
			for sequence := start; sequence < end; sequence++ {
				messages = append(messages, sampleDBAgentMessage(int64(sequence+1), sessionID, "assistant", int64(sequence)))
			}
			return messages, nil
		},
		listAgentMessagePartsFn: func(_ context.Context, messageID int64) ([]db.AgentPart, error) {
			return []db.AgentPart{sampleDBAgentPart(messageID, messageID, 0, "text", json.RawMessage(`"ok"`))}, nil
		},
	}
	svc := &AgentService{
		q: q,
		logStore: &mockAgentLogStore{putSessionLogFn: func(_ context.Context, _ int64, _ string, payload []byte) error {
			archived = append([]byte(nil), payload...)
			return nil
		}},
	}
	svc.archiveAgentTranscript(context.Background(), sampleDBAgentSession(sessionID, 101, 7, "completed"), "completed")

	require.NotEmpty(t, archived)
	var record agentTranscriptArchive
	require.NoError(t, json.Unmarshal(archived, &record))
	assert.False(t, record.Truncated)
	assert.Equal(t, messageCount, record.ArchivedMessageCount)
	assert.Equal(t, maxAgentTranscriptArchiveMessages, record.ArchiveLimits.MaxMessages)
	assert.Equal(t, blob.MaxAgentSessionLogBytes, record.ArchiveLimits.MaxBytes)

	var messages []AgentMessageResponse
	require.NoError(t, json.Unmarshal(record.Messages, &messages))
	require.Len(t, messages, messageCount)
	for sequence, message := range messages {
		assert.Equal(t, int64(sequence), message.Sequence)
	}
	require.Len(t, pageCalls, 3)
	assert.Equal(t, []int32{0, 200, 400}, []int32{pageCalls[0].PageOffset, pageCalls[1].PageOffset, pageCalls[2].PageOffset})
	for _, call := range pageCalls {
		assert.Equal(t, int32(maxAgentMessagesPageSize), call.PageSize)
	}
}

func TestArchiveAgentTranscript_RecordsMessageLimitTruncation(t *testing.T) {
	const sourceMessageCount = maxAgentTranscriptArchiveMessages + 1
	const sessionID = "22222222-2222-2222-2222-222222222222"
	var archived []byte

	q := &mockAgentQuerier{
		listAgentMessagesFn: func(_ context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			start := int(arg.PageOffset)
			if start >= sourceMessageCount {
				return nil, nil
			}
			end := min(start+int(arg.PageSize), sourceMessageCount)
			messages := make([]db.AgentMessage, 0, end-start)
			for sequence := start; sequence < end; sequence++ {
				messages = append(messages, sampleDBAgentMessage(int64(sequence+1), sessionID, "assistant", int64(sequence)))
			}
			return messages, nil
		},
		listAgentMessagePartsFn: func(_ context.Context, messageID int64) ([]db.AgentPart, error) {
			return []db.AgentPart{sampleDBAgentPart(messageID, messageID, 0, "text", json.RawMessage(`"x"`))}, nil
		},
	}
	svc := &AgentService{
		q: q,
		logStore: &mockAgentLogStore{putSessionLogFn: func(_ context.Context, _ int64, _ string, payload []byte) error {
			archived = append([]byte(nil), payload...)
			return nil
		}},
	}
	svc.archiveAgentTranscript(context.Background(), sampleDBAgentSession(sessionID, 101, 7, "completed"), "completed")

	var record agentTranscriptArchive
	require.NoError(t, json.Unmarshal(archived, &record))
	assert.True(t, record.Truncated)
	assert.Equal(t, agentTranscriptTruncationMessageLimit, record.TruncationReason)
	assert.Equal(t, maxAgentTranscriptArchiveMessages, record.ArchivedMessageCount)
	require.NotNil(t, record.NextMessageSequence)
	assert.Equal(t, int64(maxAgentTranscriptArchiveMessages), *record.NextMessageSequence)
	assert.LessOrEqual(t, len(archived), blob.MaxAgentSessionLogBytes)
}

func TestArchiveAgentTranscript_RecordsByteLimitTruncation(t *testing.T) {
	const sessionID = "33333333-3333-3333-3333-333333333333"
	oversizedContent := json.RawMessage(strconv.Quote(strings.Repeat("x", blob.MaxAgentSessionLogBytes)))
	var archived []byte

	q := &mockAgentQuerier{
		listAgentMessagesFn: func(_ context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			if arg.PageOffset > 0 {
				return nil, nil
			}
			return []db.AgentMessage{sampleDBAgentMessage(1, sessionID, "assistant", 0)}, nil
		},
		listAgentMessagePartsFn: func(_ context.Context, messageID int64) ([]db.AgentPart, error) {
			return []db.AgentPart{sampleDBAgentPart(1, messageID, 0, "text", oversizedContent)}, nil
		},
	}
	svc := &AgentService{
		q: q,
		logStore: &mockAgentLogStore{putSessionLogFn: func(_ context.Context, _ int64, _ string, payload []byte) error {
			archived = append([]byte(nil), payload...)
			return nil
		}},
	}
	svc.archiveAgentTranscript(context.Background(), sampleDBAgentSession(sessionID, 101, 7, "completed"), "completed")

	var record agentTranscriptArchive
	require.NoError(t, json.Unmarshal(archived, &record))
	assert.True(t, record.Truncated)
	assert.Equal(t, agentTranscriptTruncationByteLimit, record.TruncationReason)
	assert.Zero(t, record.ArchivedMessageCount)
	require.NotNil(t, record.NextMessageSequence)
	assert.Zero(t, *record.NextMessageSequence)
	assert.LessOrEqual(t, len(archived), blob.MaxAgentSessionLogBytes)
}
