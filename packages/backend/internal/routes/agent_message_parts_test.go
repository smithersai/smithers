package routes

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeAgentMessageParts_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("requires_parts", func(t *testing.T) {
		got, err := normalizeAgentMessageParts(nil)
		requireAPIErrorWithMessage(t, err, 400, "parts are required")
		assert.Nil(t, got)
	})

	t.Run("rejects_invalid_part_type", func(t *testing.T) {
		got, err := normalizeAgentMessageParts([]createAgentMessagePartRequest{{
			Type:    "invalid",
			Content: json.RawMessage(`"hello"`),
		}})
		requireAPIErrorWithMessage(t, err, 400, "invalid part type")
		assert.Nil(t, got)
	})

	t.Run("normalizes_text_strings_to_objects", func(t *testing.T) {
		got, err := normalizeAgentMessageParts([]createAgentMessagePartRequest{{
			Type:    "text",
			Content: json.RawMessage(`"hello"`),
		}})
		require.Nil(t, err)
		require.Len(t, got, 1)
		assert.Equal(t, "text", got[0].PartType)
		assert.JSONEq(t, `{"value":"hello"}`, string(got[0].Content))
	})

	t.Run("preserves_object_payloads", func(t *testing.T) {
		got, err := normalizeAgentMessageParts([]createAgentMessagePartRequest{
			{Type: "tool_call", Content: json.RawMessage(`{"id":"1","name":"search"}`)},
			{Type: "tool_result", Content: json.RawMessage(`{"id":"1","status":"ok"}`)},
		})
		require.Nil(t, err)
		require.Len(t, got, 2)
		assert.JSONEq(t, `{"id":"1","name":"search"}`, string(got[0].Content))
		assert.JSONEq(t, `{"id":"1","status":"ok"}`, string(got[1].Content))
	})

	// Issue #287: parts[] was unbounded — one body-limited request could carry
	// tens of thousands of minimal parts, each becoming an agent_parts row that
	// every later list/replay must expand.
	t.Run("accepts_exactly_max_parts", func(t *testing.T) {
		parts := make([]createAgentMessagePartRequest, maxAgentMessageParts)
		for i := range parts {
			parts[i] = createAgentMessagePartRequest{Type: "text", Content: json.RawMessage(`"x"`)}
		}
		got, err := normalizeAgentMessageParts(parts)
		require.Nil(t, err)
		assert.Len(t, got, maxAgentMessageParts)
	})

	t.Run("rejects_too_many_parts", func(t *testing.T) {
		parts := make([]createAgentMessagePartRequest, maxAgentMessageParts+1)
		for i := range parts {
			parts[i] = createAgentMessagePartRequest{Type: "text", Content: json.RawMessage(`"x"`)}
		}
		got, err := normalizeAgentMessageParts(parts)
		require.NotNil(t, err)
		assert.Equal(t, 400, err.Status)
		assert.Contains(t, err.Message, "too many parts")
		assert.Nil(t, got)
	})

	t.Run("rejects_oversize_aggregate_content", func(t *testing.T) {
		// A single part whose normalized content exceeds the aggregate cap.
		big := make([]byte, maxAgentMessagePartsBytes)
		for i := range big {
			big[i] = 'a'
		}
		content, marshalErr := json.Marshal(string(big))
		require.NoError(t, marshalErr)
		got, err := normalizeAgentMessageParts([]createAgentMessagePartRequest{{
			Type:    "text",
			Content: content,
		}})
		require.NotNil(t, err)
		assert.Equal(t, 400, err.Status)
		assert.Contains(t, err.Message, "message parts too large")
		assert.Nil(t, got)
	})
}

func TestNormalizeAgentMessagePartContent_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		partType    string
		raw         json.RawMessage
		wantJSON    string
		wantErrText string
	}{
		{name: "missing", partType: "text", raw: json.RawMessage(``), wantErrText: "part content is required"},
		{name: "null", partType: "text", raw: json.RawMessage(`null`), wantErrText: "part content is required"},
		{name: "invalid_json", partType: "text", raw: json.RawMessage(`{`), wantErrText: "invalid part content"},
		{name: "text_string", partType: "text", raw: json.RawMessage(`"hello"`), wantJSON: `{"value":"hello"}`},
		{name: "text_object", partType: "text", raw: json.RawMessage(`{"value":"hello"}`), wantJSON: `{"value":"hello"}`},
		{name: "tool_call_object", partType: "tool_call", raw: json.RawMessage(`{"id":"1"}`), wantJSON: `{"id":"1"}`},
		{name: "tool_result_object", partType: "tool_result", raw: json.RawMessage(`{"id":"1","status":"ok"}`), wantJSON: `{"id":"1","status":"ok"}`},
		{name: "tool_call_string_invalid", partType: "tool_call", raw: json.RawMessage(`"hello"`), wantErrText: "part content must be an object for tool_call"},
		{name: "tool_result_string_invalid", partType: "tool_result", raw: json.RawMessage(`"hello"`), wantErrText: "part content must be an object for tool_result"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeAgentMessagePartContent(tc.partType, tc.raw)
			if tc.wantErrText != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErrText)
				assert.Nil(t, got)
				return
			}
			require.NoError(t, err)
			assert.JSONEq(t, tc.wantJSON, string(got))
		})
	}
}
