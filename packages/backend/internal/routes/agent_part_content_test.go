package routes

import (
	"encoding/json"
	"net/http"
	"testing"
)

// agent_parts.content has a DB CHECK (jsonb_typeof(content) = 'object'). Non-string,
// non-object JSON (arrays, numbers, booleans) must be rejected at the route with a
// 400, not slip through and 500 at the database constraint.
func TestNormalizeAgentMessageParts_RejectsNonObjectContent(t *testing.T) {
	for _, raw := range []string{"[1,2]", "42", "true"} {
		parts := []createAgentMessagePartRequest{{Type: "tool_call", Content: json.RawMessage(raw)}}
		_, apiErr := normalizeAgentMessageParts(parts)
		if apiErr == nil {
			t.Fatalf("content %s was accepted, want a 400 error", raw)
		}
		if apiErr.Status != http.StatusBadRequest {
			t.Fatalf("content %s -> status %d, want 400", raw, apiErr.Status)
		}
	}

	// A JSON object is still accepted.
	parts := []createAgentMessagePartRequest{{Type: "tool_call", Content: json.RawMessage(`{"name":"x"}`)}}
	if _, apiErr := normalizeAgentMessageParts(parts); apiErr != nil {
		t.Fatalf("object content rejected: %v", apiErr)
	}
}
