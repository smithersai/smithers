package smitherscli

import (
	"fmt"
	"strings"

	incur "github.com/smithersai/incur"
)

func objectSchema(required []string, properties map[string]*incur.JSONSchema) *incur.JSONSchema {
	return &incur.JSONSchema{
		Type:       "object",
		Properties: properties,
		Required:   required,
	}
}

func stringSchema(description string) *incur.JSONSchema {
	return &incur.JSONSchema{Type: "string", Description: description}
}

func booleanSchema(description string, defaultValue bool) *incur.JSONSchema {
	return &incur.JSONSchema{Type: "boolean", Description: description, Default: defaultValue}
}

func numberSchema(description string, defaultValue any) *incur.JSONSchema {
	return &incur.JSONSchema{Type: "number", Description: description, Default: defaultValue}
}

func arraySchema(description string) *incur.JSONSchema {
	return &incur.JSONSchema{
		Type:        "array",
		Description: description,
		Items:       &incur.JSONSchema{Type: "string"},
		Default:     []any{},
	}
}

func enumSchema(description string, values []string, defaultValue string) *incur.JSONSchema {
	enum := make([]any, len(values))
	for i, value := range values {
		enum[i] = value
	}
	return &incur.JSONSchema{Type: "string", Description: description, Enum: enum, Default: defaultValue}
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return fmt.Sprint(value)
}

func stringSliceValue(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, stringValue(item))
		}
		return out
	default:
		return nil
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func displayNullable(value any) string {
	if value == nil {
		return "(not set)"
	}
	text := fmt.Sprint(value)
	if text == "" {
		return "(not set)"
	}
	return text
}

func joinLines(lines []string) string {
	return strings.Join(lines, "\n")
}
