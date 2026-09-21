package email

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewTransport_SelectsSendGridWhenAPIKeyConfigured(t *testing.T) {
	t.Parallel()

	tr, err := NewTransport(TransportConfig{
		SendGrid: SendGridConfig{
			APIKey: "SG.test-key",
			From:   "noreply@smithers.sh",
		},
	})

	require.NoError(t, err)
	_, ok := tr.(*SendGridTransport)
	assert.True(t, ok, "should return SendGridTransport when SendGrid API key is configured")
}

func TestNewTransport_SendGridTakesPrecedenceOverSMTP(t *testing.T) {
	t.Parallel()

	tr, err := NewTransport(TransportConfig{
		SendGrid: SendGridConfig{
			APIKey: "SG.test-key",
			From:   "noreply@smithers.sh",
		},
		SMTP: SMTPConfig{
			Host: "smtp.example.com",
			Port: 587,
			From: "noreply@smithers.sh",
		},
	})

	require.NoError(t, err)
	_, ok := tr.(*SendGridTransport)
	assert.True(t, ok, "SendGrid should take precedence over SMTP when both are configured")
}

func TestNewTransport_SelectsSMTPWhenHostConfigured(t *testing.T) {
	t.Parallel()

	tr, err := NewTransport(TransportConfig{
		SMTP: SMTPConfig{
			Host: "smtp.example.com",
			Port: 587,
			From: "noreply@smithers.sh",
		},
	})

	require.NoError(t, err)
	_, ok := tr.(*SMTPTransport)
	assert.True(t, ok, "should return SMTPTransport when SMTP host is configured")
}

func TestNewTransport_SelectsSESWhenRegionConfigured(t *testing.T) {
	t.Parallel()

	tr, err := NewTransport(TransportConfig{
		SES: SESConfig{
			Region: "us-east-1",
			From:   "noreply@smithers.sh",
		},
		SESClient: &mockSESClient{},
	})

	require.NoError(t, err)
	_, ok := tr.(*SESTransport)
	assert.True(t, ok, "should return SESTransport when SES region is configured")
}

func TestNewTransport_SMTPTakesPrecedenceOverSES(t *testing.T) {
	t.Parallel()

	tr, err := NewTransport(TransportConfig{
		SMTP: SMTPConfig{
			Host: "smtp.example.com",
			Port: 587,
			From: "noreply@smithers.sh",
		},
		SES: SESConfig{
			Region: "us-east-1",
			From:   "noreply@smithers.sh",
		},
		SESClient: &mockSESClient{},
	})

	require.NoError(t, err)
	_, ok := tr.(*SMTPTransport)
	assert.True(t, ok, "SMTP should take precedence over SES when both are configured")
}

func TestNewTransport_FallsBackToNoopWhenNothingConfigured(t *testing.T) {
	t.Parallel()

	tr, err := NewTransport(TransportConfig{})

	require.NoError(t, err)
	_, ok := tr.(*NoopTransport)
	assert.True(t, ok, "should return NoopTransport when nothing is configured")
}

func TestNewTransport_SESWithoutClientFailsFast(t *testing.T) {
	t.Parallel()

	tr, err := NewTransport(TransportConfig{
		SES: SESConfig{
			Region: "us-east-1",
			From:   "noreply@smithers.sh",
		},
		// No SESClient
	})

	require.Error(t, err)
	assert.Nil(t, tr)
	assert.Contains(t, err.Error(), "SES client is nil")
}
