package email

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockSESClient struct {
	sendEmailFn func(ctx context.Context, from string, to []string, subject, htmlBody, textBody string) error
	calls       []sesSendCall
}

type sesSendCall struct {
	From     string
	To       []string
	Subject  string
	HTMLBody string
	TextBody string
}

func (m *mockSESClient) SendEmail(ctx context.Context, from string, to []string, subject, htmlBody, textBody string) error {
	m.calls = append(m.calls, sesSendCall{
		From:     from,
		To:       to,
		Subject:  subject,
		HTMLBody: htmlBody,
		TextBody: textBody,
	})
	if m.sendEmailFn != nil {
		return m.sendEmailFn(ctx, from, to, subject, htmlBody, textBody)
	}
	return nil
}

func TestSESTransport_Send_CallsSESV2Client(t *testing.T) {
	t.Parallel()

	client := &mockSESClient{}
	tr, err := NewSESTransport(SESConfig{Region: "us-east-1", From: "noreply@smithers.sh"}, client)
	require.NoError(t, err)

	err = tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test SES",
		HTML:    "<p>Hello</p>",
		Text:    "Hello",
	})

	require.NoError(t, err)
	require.Len(t, client.calls, 1)
	assert.Equal(t, "noreply@smithers.sh", client.calls[0].From)
	assert.Equal(t, []string{"user@example.com"}, client.calls[0].To)
	assert.Equal(t, "Test SES", client.calls[0].Subject)
	assert.Equal(t, "<p>Hello</p>", client.calls[0].HTMLBody)
	assert.Equal(t, "Hello", client.calls[0].TextBody)
}

func TestSESTransport_Send_RequiresRegion(t *testing.T) {
	t.Parallel()

	client := &mockSESClient{}
	_, err := NewSESTransport(SESConfig{Region: "", From: "noreply@smithers.sh"}, client)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "region is required")
}

func TestSESTransport_Send_RequiresClient(t *testing.T) {
	t.Parallel()

	_, err := NewSESTransport(SESConfig{Region: "us-east-1", From: "noreply@smithers.sh"}, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "client is required")
}

func TestSESTransport_Send_NoRecipients(t *testing.T) {
	t.Parallel()

	client := &mockSESClient{}
	tr, err := NewSESTransport(SESConfig{Region: "us-east-1", From: "noreply@smithers.sh"}, client)
	require.NoError(t, err)

	err = tr.Send(context.Background(), Message{
		To:      []string{},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "no recipients")
}

func TestSESTransport_Send_NoFromAddress(t *testing.T) {
	t.Parallel()

	client := &mockSESClient{}
	tr, err := NewSESTransport(SESConfig{Region: "us-east-1"}, client)
	require.NoError(t, err)

	err = tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "no from address")
}

func TestSESTransport_Send_PropagatesClientError(t *testing.T) {
	t.Parallel()

	client := &mockSESClient{
		sendEmailFn: func(_ context.Context, _ string, _ []string, _, _, _ string) error {
			return fmt.Errorf("SES throttled")
		},
	}
	tr, err := NewSESTransport(SESConfig{Region: "us-east-1", From: "noreply@smithers.sh"}, client)
	require.NoError(t, err)

	err = tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "SES throttled")
}

func TestSESTransport_Send_MessageFromOverridesConfig(t *testing.T) {
	t.Parallel()

	client := &mockSESClient{}
	tr, err := NewSESTransport(SESConfig{Region: "us-east-1", From: "default@smithers.sh"}, client)
	require.NoError(t, err)

	err = tr.Send(context.Background(), Message{
		From:    "override@smithers.sh",
		To:      []string{"user@example.com"},
		Subject: "Test",
	})

	require.NoError(t, err)
	require.Len(t, client.calls, 1)
	assert.Equal(t, "override@smithers.sh", client.calls[0].From)
}
