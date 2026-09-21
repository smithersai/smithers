package email

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNoopTransport_Send_ReturnsNil(t *testing.T) {
	t.Parallel()
	tr := &NoopTransport{}
	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
		HTML:    "<p>Hello</p>",
		Text:    "Hello",
	})
	require.NoError(t, err)
}

func TestNoopTransport_Send_CapturesMessages(t *testing.T) {
	t.Parallel()
	tr := &NoopTransport{}
	msg := Message{
		From:    "noreply@smithers.sh",
		To:      []string{"a@example.com", "b@example.com"},
		Subject: "Captured",
		HTML:    "<b>hi</b>",
		Text:    "hi",
	}
	err := tr.Send(context.Background(), msg)
	require.NoError(t, err)
	require.Len(t, tr.Sent, 1)
	assert.Equal(t, msg, tr.Sent[0])
}

func TestNoopTransport_Send_MultipleCalls(t *testing.T) {
	t.Parallel()
	tr := &NoopTransport{}
	_ = tr.Send(context.Background(), Message{Subject: "First"})
	_ = tr.Send(context.Background(), Message{Subject: "Second"})
	require.Len(t, tr.Sent, 2)
	assert.Equal(t, "First", tr.Sent[0].Subject)
	assert.Equal(t, "Second", tr.Sent[1].Subject)
}
