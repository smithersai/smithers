package email

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Compile-time interface satisfaction checks.
var (
	_ Transport = (*NoopTransport)(nil)
	_ Transport = (*SMTPTransport)(nil)
	_ Transport = (*SESTransport)(nil)
)

func TestMessage_FieldsAccessible(t *testing.T) {
	t.Parallel()
	msg := Message{
		From:    "noreply@smithers.sh",
		To:      []string{"user@example.com"},
		Subject: "Test",
		HTML:    "<p>Hello</p>",
		Text:    "Hello",
	}
	assert.Equal(t, "noreply@smithers.sh", msg.From)
	assert.Equal(t, []string{"user@example.com"}, msg.To)
	assert.Equal(t, "Test", msg.Subject)
	assert.Equal(t, "<p>Hello</p>", msg.HTML)
	assert.Equal(t, "Hello", msg.Text)
}

func TestTransport_InterfaceMethodSignature(t *testing.T) {
	t.Parallel()
	// Verify the Transport interface has the expected Send method.
	var tr Transport = &NoopTransport{}
	err := tr.Send(context.Background(), Message{})
	assert.NoError(t, err)
}
