package webhooks

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNewPayloadValidator_HasAllSpecEventTypes verifies that the validator is
// configured with all event types defined in the spec.
func TestNewPayloadValidator_HasAllSpecEventTypes(t *testing.T) {
	t.Parallel()

	v := NewPayloadValidator()

	specTypes := []EventType{
		EventTypeIssues,
		EventTypeIssueComment,
		EventTypeStatus,
		EventTypePush,
		EventTypeLandingRequest,
		EventTypeLandingRequestReview,
		EventTypeLandingRequestComment,
		EventTypeStar,
		EventTypeWatch,
		EventTypeCreate,
		EventTypeDelete,
		EventTypeMember,
		EventTypeTeam,
		EventTypeOrganization,
		EventTypeWorkflowRun,
		EventTypeWorkflowArtifact,
		EventTypeRelease,
		EventTypePing,
		EventTypeAgentSession,
		EventTypeAgentMessage,
		EventTypeLandingConflict,
	}

	for _, et := range specTypes {
		_, ok := v.requiredFields[et]
		assert.True(t, ok, "validator should have required fields for event type %q", et)
	}
}

// TestPayloadValidator_Validate_AllEventTypes checks that a properly constructed
// payload for each event type passes validation.
func TestPayloadValidator_Validate_AllEventTypes(t *testing.T) {
	t.Parallel()

	repo := RepositoryPayload{ID: 1, Name: "demo", FullName: "alice/demo"}
	sender := UserPayload{ID: 9, Login: "alice"}
	issue := IssuePayload{
		ID: 10, Number: 1, Title: "t", Body: "b", State: "open",
		Author: sender, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}

	payloads := map[EventType]any{
		EventTypeIssues: IssueEventPayload{
			Action: "opened", Issue: issue, Repository: repo, Sender: sender,
		},
		EventTypeIssueComment: IssueCommentEventPayload{
			Action: "created",
			Issue:  issue,
			Comment: IssueCommentPayload{
				ID: 1, IssueID: 10, Body: "hi", Commenter: "alice",
				User: sender, CreatedAt: time.Now(), UpdatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypeStatus: CommitStatusEventPayload{
			CommitStatus: CommitStatusPayload{
				ID: 1, SHA: "abc123", Context: "ci/test", Status: "success",
			},
			Repository: repo, Sender: sender,
		},
		EventTypePush: PushEventPayload{
			Ref: "refs/heads/main", Repository: repo, Sender: sender,
		},
		EventTypeLandingRequest: LandingRequestEventPayload{
			Action: "opened",
			LandingRequest: LandingRequestPayload{
				Number: 1, Title: "fix bug", State: "open",
				Author: sender, ChangeIDs: []string{"abc"}, TargetBookmark: "main",
				ConflictStatus: "clean", StackSize: 1, CreatedAt: time.Now(), UpdatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypeLandingRequestReview: LandingRequestReviewEventPayload{
			Action: "submitted",
			Review: LandingReviewPayload{
				ID: 1, LandingRequestID: 1, Type: "approve", Body: "", State: "approved",
				Reviewer: sender,
			},
			LandingRequest: LandingRequestPayload{
				Number: 1, Title: "fix bug", State: "open", Author: sender,
				ChangeIDs: []string{"abc"}, TargetBookmark: "main",
				ConflictStatus: "clean", StackSize: 1, CreatedAt: time.Now(), UpdatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypeLandingRequestComment: LandingRequestCommentEventPayload{
			Action: "created",
			Comment: LandingCommentPayload{
				ID: 1, LandingRequestID: 1, Path: "main.go", Line: 5,
				Side: "right", Body: "looks good", User: sender,
			},
			LandingRequest: LandingRequestPayload{
				Number: 1, Title: "fix bug", State: "open", Author: sender,
				ChangeIDs: []string{"abc"}, TargetBookmark: "main",
				ConflictStatus: "clean", StackSize: 1, CreatedAt: time.Now(), UpdatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypeStar: RepositoryEventPayload{
			Action: "starred", Repository: repo, Sender: sender,
		},
		EventTypeWatch: RepositoryEventPayload{
			Action: "started", Repository: repo, Sender: sender,
		},
		EventTypeCreate: RepositoryEventPayload{
			Action: "created", Repository: repo, Sender: sender,
		},
		EventTypeDelete: RepositoryEventPayload{
			Action: "deleted", Repository: repo, Sender: sender,
		},
		EventTypeMember: RepositoryEventPayload{
			Action: "added", Repository: repo, Sender: sender,
		},
		EventTypeTeam: TeamEventPayload{
			Action: "created", Repository: repo, Sender: sender,
		},
		EventTypeOrganization: OrganizationEventPayload{
			Action: "member_added", Sender: sender,
		},
		EventTypeWorkflowRun: WorkflowRunEventPayload{
			Action: "queued",
			WorkflowRun: WorkflowRunPayload{
				ID: 1, Name: "CI", Status: "queued",
				TriggerEvent: "push", CreatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypeWorkflowArtifact: WorkflowArtifactEventPayload{
			Action: "ready",
			Artifact: WorkflowArtifactPayload{
				ID:             1,
				WorkflowRunID:  7,
				Name:           "research.md",
				Size:           128,
				ContentType:    "text/markdown",
				Status:         "ready",
				SourceWorkflow: "Research",
				CreatedAt:      time.Now(),
				UpdatedAt:      time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypeRelease: ReleaseEventPayload{
			Action: "published",
			Release: ReleasePayload{
				ID: 1, TagName: "v1.0.0", Title: "v1.0.0", Body: "release notes",
				IsDraft: false, IsPrerelease: false, Author: sender,
				Assets: []ReleaseAssetPayload{}, CreatedAt: time.Now(), UpdatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypePing: map[string]any{
			"zen":     "Keep it logically awesome.",
			"hook_id": float64(1),
		},
		EventTypeAgentSession: AgentSessionEventPayload{
			Action: "started",
			AgentSession: AgentSessionPayload{
				ID: "ses_abc123", Title: "Fix bug", Status: "active",
				CreatedAt: time.Now(), UpdatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypeAgentMessage: AgentMessageEventPayload{
			Action: "created",
			Message: AgentMessagePayload{
				ID: 1, SessionID: "ses_abc123", Role: "assistant",
				Sequence: 1, CreatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
		EventTypeLandingConflict: LandingConflictEventPayload{
			Action:         "conflict_detected",
			PreviousStatus: "clean",
			LandingRequest: LandingRequestPayload{
				Number: 1, Title: "fix bug", State: "open", Author: sender,
				ChangeIDs: []string{"abc"}, TargetBookmark: "main",
				ConflictStatus: "conflicted", StackSize: 1, CreatedAt: time.Now(), UpdatedAt: time.Now(),
			},
			Repository: repo, Sender: sender,
		},
	}

	v := NewPayloadValidator()

	for eventType, payload := range payloads {
		eventType := eventType
		payload := payload
		t.Run(string(eventType), func(t *testing.T) {
			t.Parallel()

			data, err := json.Marshal(payload)
			require.NoError(t, err)

			err = v.Validate(eventType, data)
			assert.NoError(t, err, "event type %q should pass validation with well-formed payload", eventType)
		})
	}
}

// TestPayloadValidator_Validate_MissingFields checks that validation fails
// when required fields are absent.
func TestPayloadValidator_Validate_MissingFields(t *testing.T) {
	t.Parallel()

	v := NewPayloadValidator()

	missingCases := []struct {
		name      string
		eventType EventType
		payload   []byte
		missing   string
	}{
		{
			name:      "issues missing action",
			eventType: EventTypeIssues,
			payload:   []byte(`{"issue":{},"repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`),
			missing:   "action",
		},
		{
			name:      "issues missing issue",
			eventType: EventTypeIssues,
			payload:   []byte(`{"action":"opened","repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`),
			missing:   "issue",
		},
		{
			name:      "issues missing repository",
			eventType: EventTypeIssues,
			payload:   []byte(`{"action":"opened","issue":{},"sender":{"id":1,"login":"u"}}`),
			missing:   "repository",
		},
		{
			name:      "issues missing sender",
			eventType: EventTypeIssues,
			payload:   []byte(`{"action":"opened","issue":{},"repository":{"id":1,"name":"r"}}`),
			missing:   "sender",
		},
		{
			name:      "status missing commit_status",
			eventType: EventTypeStatus,
			payload:   []byte(`{"repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`),
			missing:   "commit_status",
		},
		{
			name:      "push missing ref",
			eventType: EventTypePush,
			payload:   []byte(`{"repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`),
			missing:   "ref",
		},
		{
			name:      "ping missing zen",
			eventType: EventTypePing,
			payload:   []byte(`{"hook_id":1}`),
			missing:   "zen",
		},
		{
			name:      "ping missing hook_id",
			eventType: EventTypePing,
			payload:   []byte(`{"zen":"Keep it logically awesome."}`),
			missing:   "hook_id",
		},
		{
			name:      "agent.session missing agent_session",
			eventType: EventTypeAgentSession,
			payload:   []byte(`{"action":"started","repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`),
			missing:   "agent_session",
		},
		{
			name:      "workflow_run missing workflow_run",
			eventType: EventTypeWorkflowRun,
			payload:   []byte(`{"action":"queued","repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`),
			missing:   "workflow_run",
		},
		{
			name:      "workflow_artifact missing artifact",
			eventType: EventTypeWorkflowArtifact,
			payload:   []byte(`{"action":"ready","repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`),
			missing:   "artifact",
		},
		{
			name:      "landing.conflict missing landing_request",
			eventType: EventTypeLandingConflict,
			payload:   []byte(`{"action":"conflict_detected","repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`),
			missing:   "landing_request",
		},
	}

	for _, tc := range missingCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			err := v.Validate(tc.eventType, tc.payload)
			require.Error(t, err)

			var validErr *ValidationError
			require.ErrorAs(t, err, &validErr)
			assert.Equal(t, tc.eventType, validErr.EventType)
			assert.Contains(t, validErr.MissingFields, tc.missing)
		})
	}
}

// TestPayloadValidator_Validate_InvalidJSON checks that invalid JSON is reported correctly.
func TestPayloadValidator_Validate_InvalidJSON(t *testing.T) {
	t.Parallel()

	v := NewPayloadValidator()
	err := v.Validate(EventTypeIssues, []byte("not json"))
	require.Error(t, err)

	var validErr *ValidationError
	require.ErrorAs(t, err, &validErr)
	assert.NotNil(t, validErr.ParseError)
	assert.Equal(t, EventTypeIssues, validErr.EventType)
}

// TestPayloadValidator_Validate_UnknownEventType verifies that unknown event
// types are allowed through without error.
func TestPayloadValidator_Validate_UnknownEventType(t *testing.T) {
	t.Parallel()

	v := NewPayloadValidator()
	err := v.Validate("unknown.event.type", []byte(`{"some":"field"}`))
	assert.NoError(t, err)
}

// TestValidatePayload_ConvenienceFunction verifies that ValidatePayload works
// identically to using a validator directly.
func TestValidatePayload_ConvenienceFunction(t *testing.T) {
	t.Parallel()

	// Valid payload should pass.
	validPayload := []byte(`{"action":"opened","issue":{},"repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`)
	err := ValidatePayload(EventTypeIssues, validPayload)
	assert.NoError(t, err)

	// Invalid payload should fail.
	invalidPayload := []byte(`{"issue":{},"repository":{"id":1,"name":"r"},"sender":{"id":1,"login":"u"}}`)
	err = ValidatePayload(EventTypeIssues, invalidPayload)
	require.Error(t, err)
	assert.True(t, IsValidationError(err))
}

// TestValidateRepositoryPayload_ValidInput checks that a valid repository object passes.
func TestValidateRepositoryPayload_ValidInput(t *testing.T) {
	t.Parallel()

	err := ValidateRepositoryPayload(map[string]interface{}{
		"id":   float64(1),
		"name": "demo",
	})
	assert.NoError(t, err)
}

// TestValidateRepositoryPayload_MissingFields checks each required field.
func TestValidateRepositoryPayload_MissingFields(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		input map[string]interface{}
	}{
		{
			name:  "nil repo",
			input: nil,
		},
		{
			name:  "missing id",
			input: map[string]interface{}{"name": "demo"},
		},
		{
			name:  "missing name",
			input: map[string]interface{}{"id": float64(1)},
		},
		{
			name:  "id is nil",
			input: map[string]interface{}{"id": nil, "name": "demo"},
		},
		{
			name:  "name is nil",
			input: map[string]interface{}{"id": float64(1), "name": nil},
		},
		{
			name:  "id is wrong type",
			input: map[string]interface{}{"id": "not_a_number", "name": "demo"},
		},
		{
			name:  "name is wrong type",
			input: map[string]interface{}{"id": float64(1), "name": float64(123)},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			err := ValidateRepositoryPayload(tc.input)
			assert.Error(t, err, "expected error for case %q", tc.name)
		})
	}
}

// TestValidateUserPayload_ValidInput checks that a valid user object passes.
func TestValidateUserPayload_ValidInput(t *testing.T) {
	t.Parallel()

	err := ValidateUserPayload(map[string]interface{}{
		"id":    float64(9),
		"login": "alice",
	})
	assert.NoError(t, err)
}

// TestValidateUserPayload_MissingFields checks each required field.
func TestValidateUserPayload_MissingFields(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		input map[string]interface{}
	}{
		{
			name:  "nil user",
			input: nil,
		},
		{
			name:  "missing id",
			input: map[string]interface{}{"login": "alice"},
		},
		{
			name:  "missing login",
			input: map[string]interface{}{"id": float64(9)},
		},
		{
			name:  "id is nil",
			input: map[string]interface{}{"id": nil, "login": "alice"},
		},
		{
			name:  "login is nil",
			input: map[string]interface{}{"id": float64(9), "login": nil},
		},
		{
			name:  "id is wrong type",
			input: map[string]interface{}{"id": "not_a_number", "login": "alice"},
		},
		{
			name:  "login is wrong type",
			input: map[string]interface{}{"id": float64(9), "login": float64(123)},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			err := ValidateUserPayload(tc.input)
			assert.Error(t, err, "expected error for case %q", tc.name)
		})
	}
}

// TestIsValidationError checks the type predicate helper.
func TestIsValidationError(t *testing.T) {
	t.Parallel()

	assert.True(t, IsValidationError(&ValidationError{EventType: EventTypeIssues}))
	assert.False(t, IsValidationError(nil))

	// A plain Go error is not a validation error.
	assert.False(t, IsValidationError(assert.AnError))
}

// TestValidationError_Error_Formats verifies the string representations of each error form.
func TestValidationError_Error_Formats(t *testing.T) {
	t.Parallel()

	parseErrCase := &ValidationError{
		EventType:  EventTypeIssues,
		ParseError: assert.AnError,
	}
	assert.Contains(t, parseErrCase.Error(), "JSON parse error")
	assert.Contains(t, parseErrCase.Error(), "issues")

	missingFieldCase := &ValidationError{
		EventType:     EventTypeIssues,
		MissingFields: []string{"action", "sender"},
	}
	assert.Contains(t, missingFieldCase.Error(), "missing required fields")
	assert.Contains(t, missingFieldCase.Error(), "action")
	assert.Contains(t, missingFieldCase.Error(), "sender")

	invalidFieldCase := &ValidationError{
		EventType:     EventTypeIssues,
		InvalidFields: map[string]string{"state": "must be open or closed"},
	}
	assert.Contains(t, invalidFieldCase.Error(), "invalid fields")

	genericCase := &ValidationError{EventType: EventTypeIssues}
	assert.Contains(t, genericCase.Error(), "issues")
}

// TestLandingConflictEventPayload_ConflictsbyChange verifies that the
// ConflictsByChange map is correctly serialized.
func TestLandingConflictEventPayload_ConflictsbyChange(t *testing.T) {
	t.Parallel()

	payload := LandingConflictEventPayload{
		Action:         "conflict_detected",
		PreviousStatus: "clean",
		LandingRequest: LandingRequestPayload{
			Number: 1, Title: "fix", State: "open", Author: UserPayload{ID: 1, Login: "alice"},
			ChangeIDs: []string{"k1", "k2"}, TargetBookmark: "main",
			ConflictStatus: "conflicted", StackSize: 2, CreatedAt: time.Now(), UpdatedAt: time.Now(),
		},
		ConflictsByChange: map[string][]ConflictDetail{
			"k1": {{FilePath: "main.go", ConflictType: "content"}},
			"k2": {{FilePath: "README.md", ConflictType: "content"}},
		},
		Repository: RepositoryPayload{ID: 1, Name: "repo"},
		Sender:     UserPayload{ID: 1, Login: "alice"},
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	conflictsByChange, ok := decoded["conflicts_by_change"].(map[string]any)
	require.True(t, ok, "conflicts_by_change should be an object")
	assert.Len(t, conflictsByChange, 2)
	assert.Contains(t, conflictsByChange, "k1")
	assert.Contains(t, conflictsByChange, "k2")

	k1Conflicts, ok := conflictsByChange["k1"].([]any)
	require.True(t, ok)
	require.Len(t, k1Conflicts, 1)
	firstConflict, ok := k1Conflicts[0].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "main.go", firstConflict["file_path"])
	assert.Equal(t, "content", firstConflict["conflict_type"])
}

// TestOrganizationEventPayload_NoRepository verifies that OrganizationEventPayload
// can be serialized without a repository field (org-level events).
func TestOrganizationEventPayload_NoRepository(t *testing.T) {
	t.Parallel()

	payload := OrganizationEventPayload{
		Action: "member_added",
		Sender: UserPayload{ID: 1, Login: "alice"},
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "member_added", decoded["action"])
	// organization events don't have repository
	_, hasRepo := decoded["repository"]
	assert.False(t, hasRepo, "OrganizationEventPayload should not include repository")

	v := NewPayloadValidator()
	err = v.Validate(EventTypeOrganization, data)
	assert.NoError(t, err)
}

// TestAgentMessageEventPayload_JSONShape verifies correct serialization.
func TestAgentMessageEventPayload_JSONShape(t *testing.T) {
	t.Parallel()

	payload := AgentMessageEventPayload{
		Action: "created",
		Message: AgentMessagePayload{
			ID:        42,
			SessionID: "ses_abc",
			Role:      "assistant",
			Sequence:  3,
			CreatedAt: time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
		},
		Repository: RepositoryPayload{ID: 1, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "created", decoded["action"])

	msg, ok := decoded["message"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, float64(42), msg["id"])
	assert.Equal(t, "ses_abc", msg["session_id"])
	assert.Equal(t, "assistant", msg["role"])
	assert.Equal(t, float64(3), msg["sequence"])

	v := NewPayloadValidator()
	err = v.Validate(EventTypeAgentMessage, data)
	assert.NoError(t, err)
}
