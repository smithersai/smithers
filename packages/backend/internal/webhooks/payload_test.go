package webhooks

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLandingRequestPayload_JSONIncludesJJNativeFields(t *testing.T) {
	payload := LandingRequestEventPayload{
		Action: "opened",
		LandingRequest: LandingRequestPayload{
			Number:         42,
			Title:          "Add authentication",
			State:          "open",
			Author:         UserPayload{ID: 9, Login: "alice"},
			ChangeIDs:      []string{"kxyz", "kabc"},
			TargetBookmark: "main",
			ConflictStatus: "clean",
			StackSize:      2,
			CreatedAt:      time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
			UpdatedAt:      time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
		},
		Repository: RepositoryPayload{ID: 11, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))

	landing, ok := decoded["landing_request"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, []any{"kxyz", "kabc"}, landing["change_ids"])
	assert.Equal(t, "main", landing["target_bookmark"])
	assert.Equal(t, "clean", landing["conflict_status"])
	assert.EqualValues(t, 2, landing["stack_size"])
}

func TestWorkflowRunEventPayload_JSONShape(t *testing.T) {
	payload := WorkflowRunEventPayload{
		Action: "queued",
		WorkflowRun: WorkflowRunPayload{
			ID:           7,
			Name:         "ci",
			Status:       "queued",
			TriggerEvent: "push",
			TriggerRef:   "main",
			CommitSHA:    "abc123",
			CreatedAt:    time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
		},
		Repository: RepositoryPayload{ID: 11, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))

	assert.Equal(t, "queued", decoded["action"])
	wr, ok := decoded["workflow_run"].(map[string]any)
	require.True(t, ok)
	assert.EqualValues(t, 7, wr["id"])
	assert.Equal(t, "queued", wr["status"])
	assert.Equal(t, "push", wr["trigger_event"])
	assert.Equal(t, "main", wr["trigger_ref"])
	assert.Equal(t, "abc123", wr["commit_sha"])
}

func TestWorkflowArtifactEventPayload_JSONShape(t *testing.T) {
	confirmedAt := time.Date(2026, time.February, 22, 12, 5, 0, 0, time.UTC)
	payload := WorkflowArtifactEventPayload{
		Action: "ready",
		Artifact: WorkflowArtifactPayload{
			ID:             9,
			WorkflowRunID:  7,
			Name:           "research.md",
			Size:           128,
			ContentType:    "text/markdown",
			Status:         "ready",
			SourceWorkflow: "research",
			CreatedAt:      time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
			UpdatedAt:      time.Date(2026, time.February, 22, 12, 5, 0, 0, time.UTC),
			ConfirmedAt:    &confirmedAt,
		},
		Repository: RepositoryPayload{ID: 11, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))

	assert.Equal(t, "ready", decoded["action"])
	artifact, ok := decoded["artifact"].(map[string]any)
	require.True(t, ok)
	assert.EqualValues(t, 9, artifact["id"])
	assert.EqualValues(t, 7, artifact["workflow_run_id"])
	assert.Equal(t, "research.md", artifact["name"])
	assert.Equal(t, "research", artifact["source_workflow"])
	assert.Equal(t, "ready", artifact["status"])
}

func TestAllSpecEventTypesAreDefined(t *testing.T) {
	events := []EventType{
		EventTypePush,
		EventTypeLandingRequest,
		EventTypeLandingRequestReview,
		EventTypeLandingRequestComment,
		EventTypeIssues,
		EventTypeIssueComment,
		EventTypeCreate,
		EventTypeDelete,
		EventTypeStar,
		EventTypeWatch,
		EventTypeMember,
		EventTypeTeam,
		EventTypeOrganization,
		EventTypeWorkflowRun,
		EventTypeWorkflowArtifact,
		EventTypeRelease,
		EventTypeStatus,
		EventTypePing,
		EventTypeAgentSession,
		EventTypeAgentMessage,
		EventTypeLandingConflict,
	}

	assert.Len(t, events, 21)
	assert.Contains(t, events, EventTypeLandingRequest)
	assert.Contains(t, events, EventTypeAgentMessage)
	assert.Contains(t, events, EventTypeLandingConflict)
	assert.Contains(t, events, EventTypeWorkflowArtifact)
}

// TestAgentSessionEventPayload_PassesValidation tests that a properly constructed
// AgentSessionEventPayload passes validation. This is a regression test for the
// bug where the validator expected "session" but the struct uses "agent_session".
func TestAgentSessionEventPayload_PassesValidation(t *testing.T) {
	payload := AgentSessionEventPayload{
		Action: "started",
		AgentSession: AgentSessionPayload{
			ID:        "ses_abc123def",
			Title:     "Fix auth bug",
			Status:    "active",
			CreatedAt: time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
			UpdatedAt: time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
		},
		Repository: RepositoryPayload{ID: 11, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	validator := NewPayloadValidator()
	err = validator.Validate(EventTypeAgentSession, encoded)
	assert.NoError(t, err, "AgentSessionEventPayload should pass validation")
}

// TestAgentSessionEventPayload_RejectsMissingFields tests that validation fails
// when the agent_session field is missing from the payload.
func TestAgentSessionEventPayload_RejectsMissingFields(t *testing.T) {
	// Payload missing the agent_session field
	rawJSON := []byte(`{"action":"started","repository":{"id":1,"name":"demo"},"sender":{"id":1,"login":"alice"}}`)

	validator := NewPayloadValidator()
	err := validator.Validate(EventTypeAgentSession, rawJSON)
	require.Error(t, err)

	var validErr *ValidationError
	require.ErrorAs(t, err, &validErr)
	assert.Contains(t, validErr.MissingFields, "agent_session")
}

// TestRequiredFields_MatchJSONTags_AgentSession ensures that the validator's
// required field names match the actual JSON field names produced by the struct.
func TestRequiredFields_MatchJSONTags_AgentSession(t *testing.T) {
	payload := AgentSessionEventPayload{
		Action: "started",
		AgentSession: AgentSessionPayload{
			ID:     "ses_abc123def",
			Title:  "Test",
			Status: "active",
		},
		Repository: RepositoryPayload{ID: 1, Name: "test"},
		Sender:     UserPayload{ID: 1, Login: "user"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	var fields map[string]any
	require.NoError(t, json.Unmarshal(encoded, &fields))

	validator := NewPayloadValidator()
	required := validator.requiredFields[EventTypeAgentSession]

	for _, field := range required {
		_, exists := fields[field]
		assert.True(t, exists, "required field %q must exist in marshaled AgentSessionEventPayload JSON", field)
	}
}
