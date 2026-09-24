package sse

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---- fakeNotifier for unit testing ----

// ---- tests ----

// ---- validateChannel tests ----

func TestValidateChannel_AcceptsValidNames(t *testing.T) {
	t.Parallel()

	valid := []string{
		"notifications",
		"agent_session_123",
		"user_42",
		"WorkflowLog",
		"a",
		"Z",
		"_",
		"_underscore_start",
	}
	for _, name := range valid {
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.NoError(t, validateChannel(name))
		})
	}
}

func TestValidateChannel_RejectsInvalidNames(t *testing.T) {
	t.Parallel()

	invalid := []string{
		"",
		"has space",
		"has-hyphen",
		"has.dot",
		"has;semicolon",
		"DROP TABLE notifications; --",
		"chan'nel",
		"chan\"nel",
		"chan$nel",
	}
	for _, name := range invalid {
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.Error(t, validateChannel(name))
		})
	}
}

func TestValidateChannel_EmptyName_ReturnsError(t *testing.T) {
	t.Parallel()
	err := validateChannel("")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "empty")
}

// ---- FormatEvent tests ----

func TestFormatEvent_WithIDAndType(t *testing.T) {
	t.Parallel()

	e := Event{Type: "notification", Data: `{"id":42}`, ID: "42"}
	got := FormatEvent(e)
	assert.Contains(t, got, "id: 42\n")
	assert.Contains(t, got, "event: notification\n")
	assert.Contains(t, got, "data: {\"id\":42}\n")
	assert.True(t, strings.HasSuffix(got, "\n\n"), "must end with double newline")
}

func TestFormatEvent_WithoutID(t *testing.T) {
	t.Parallel()

	e := Event{Type: "notification", Data: `{"id":99}`}
	got := FormatEvent(e)
	assert.NotContains(t, got, "id:")
	assert.Contains(t, got, "event: notification\n")
	assert.Contains(t, got, "data: {\"id\":99}\n")
	assert.True(t, strings.HasSuffix(got, "\n\n"))
}

func TestFormatEvent_WithoutType(t *testing.T) {
	t.Parallel()

	e := Event{Data: `hello`, ID: "1"}
	got := FormatEvent(e)
	assert.Contains(t, got, "id: 1\n")
	assert.NotContains(t, got, "event:")
	assert.Contains(t, got, "data: hello\n")
	assert.True(t, strings.HasSuffix(got, "\n\n"))
}

func TestFormatEvent_EmptyEvent(t *testing.T) {
	t.Parallel()

	e := Event{}
	got := FormatEvent(e)
	assert.Contains(t, got, "data: \n")
	assert.True(t, strings.HasSuffix(got, "\n\n"))
}
