package webhooks

import (
	"encoding/json"
	"fmt"
)

// PayloadValidator provides schema validation for webhook event payloads.
type PayloadValidator struct {
	// requiredFields maps event types to their required top-level field names
	requiredFields map[EventType][]string
}

// NewPayloadValidator creates a validator with predefined schemas for each event type.
func NewPayloadValidator() *PayloadValidator {
	return &PayloadValidator{
		requiredFields: map[EventType][]string{
			EventTypeIssues:                {"action", "issue", "repository", "sender"},
			EventTypeIssueComment:          {"action", "issue", "comment", "repository", "sender"},
			EventTypeStatus:                {"commit_status", "repository", "sender"},
			EventTypePush:                  {"ref", "repository", "sender"},
			EventTypeLandingRequest:        {"action", "landing_request", "repository", "sender"},
			EventTypeLandingRequestReview:  {"action", "review", "landing_request", "repository", "sender"},
			EventTypeLandingRequestComment: {"action", "comment", "landing_request", "repository", "sender"},
			EventTypeStar:                  {"action", "repository", "sender"},
			EventTypeWatch:                 {"action", "repository", "sender"},
			EventTypeCreate:                {"action", "repository", "sender"},
			EventTypeDelete:                {"action", "repository", "sender"},
			EventTypeMember:                {"action", "repository", "sender"},
			EventTypeTeam:                  {"action", "repository", "sender"},
			EventTypeOrganization:          {"action", "sender"},
			EventTypeWorkflowRun:           {"action", "workflow_run", "repository", "sender"},
			EventTypeWorkflowArtifact:      {"action", "artifact", "repository", "sender"},
			EventTypeRelease:               {"action", "release", "repository", "sender"},
			EventTypePing:                  {"zen", "hook_id"},
			EventTypeAgentSession:          {"action", "agent_session", "repository", "sender"},
			EventTypeAgentMessage:          {"action", "message", "repository", "sender"},
			EventTypeLandingConflict:       {"action", "landing_request", "repository", "sender"},
			EventWiki:                      {"action", "page", "repository", "sender"},
		},
	}
}

// ValidationError represents a schema validation failure.
type ValidationError struct {
	EventType     EventType
	MissingFields []string
	InvalidFields map[string]string
	RawPayload    []byte
	ParseError    error
}

func (e *ValidationError) Error() string {
	if e.ParseError != nil {
		return fmt.Sprintf("payload validation failed for %s: JSON parse error: %v", e.EventType, e.ParseError)
	}
	if len(e.MissingFields) > 0 {
		return fmt.Sprintf("payload validation failed for %s: missing required fields: %v", e.EventType, e.MissingFields)
	}
	if len(e.InvalidFields) > 0 {
		return fmt.Sprintf("payload validation failed for %s: invalid fields: %v", e.EventType, e.InvalidFields)
	}
	return fmt.Sprintf("payload validation failed for %s", e.EventType)
}

// Validate checks if a payload matches the expected schema for the given event type.
func (v *PayloadValidator) Validate(eventType EventType, payload []byte) error {
	// Parse JSON
	var data map[string]interface{}
	if err := json.Unmarshal(payload, &data); err != nil {
		return &ValidationError{
			EventType:  eventType,
			ParseError: err,
			RawPayload: payload,
		}
	}

	// Get required fields for this event type
	required, ok := v.requiredFields[eventType]
	if !ok {
		// Unknown event type - allow through with warning
		return nil
	}

	// Check for missing required fields
	var missing []string
	for _, field := range required {
		if _, exists := data[field]; !exists {
			missing = append(missing, field)
		}
	}

	if len(missing) > 0 {
		return &ValidationError{
			EventType:     eventType,
			MissingFields: missing,
			RawPayload:    payload,
		}
	}

	return nil
}

// ValidatePayload is a convenience function for one-off validation.
func ValidatePayload(eventType EventType, payload []byte) error {
	validator := NewPayloadValidator()
	return validator.Validate(eventType, payload)
}

// ValidateRepositoryPayload validates the repository object structure.
func ValidateRepositoryPayload(repo map[string]interface{}) error {
	if repo == nil {
		return fmt.Errorf("repository is nil")
	}

	required := []string{"id", "name"}
	for _, field := range required {
		val, exists := repo[field]
		if !exists {
			return fmt.Errorf("repository missing required field: %s", field)
		}
		if val == nil {
			return fmt.Errorf("repository field %s is nil", field)
		}
	}

	// Validate types
	if _, ok := repo["id"].(float64); !ok {
		return fmt.Errorf("repository.id must be a number")
	}
	if _, ok := repo["name"].(string); !ok {
		return fmt.Errorf("repository.name must be a string")
	}

	return nil
}

// ValidateUserPayload validates the sender/user object structure.
func ValidateUserPayload(user map[string]interface{}) error {
	if user == nil {
		return fmt.Errorf("user is nil")
	}

	required := []string{"id", "login"}
	for _, field := range required {
		val, exists := user[field]
		if !exists {
			return fmt.Errorf("user missing required field: %s", field)
		}
		if val == nil {
			return fmt.Errorf("user field %s is nil", field)
		}
	}

	// Validate types
	if _, ok := user["id"].(float64); !ok {
		return fmt.Errorf("user.id must be a number")
	}
	if _, ok := user["login"].(string); !ok {
		return fmt.Errorf("user.login must be a string")
	}

	return nil
}

// IsValidationError checks if an error is a payload validation error.
func IsValidationError(err error) bool {
	_, ok := err.(*ValidationError)
	return ok
}
