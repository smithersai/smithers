package email

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sendgrid/sendgrid-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSendgrid_Cov_SendRequestFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("request should fail before reaching the closed server")
	}))
	server.Close()

	tr, err := NewSendGridTransport(SendGridConfig{
		APIKey: "SG.test-key",
		From:   "noreply@smithers.sh",
	})
	require.NoError(t, err)

	req := sendgrid.GetRequest("SG.test-key", "/v3/mail/send", server.URL)
	req.Method = http.MethodPost
	tr.client = &sendgrid.Client{Request: req}

	err = tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "delivery failure",
		Text:    "hello",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "email: sendgrid request failed")
}

func TestSendgrid_Cov_SendEmptyBodyAddsPlainTextContent(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]any
	tr := newTestSendGridTransport(t, func(w http.ResponseWriter, r *http.Request) {
		err := json.NewDecoder(r.Body).Decode(&receivedPayload)
		require.NoError(t, err)
		w.WriteHeader(http.StatusAccepted)
	})

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "empty body",
	})

	require.NoError(t, err)
	content := receivedPayload["content"].([]any)
	require.Len(t, content, 1)
	assert.Equal(t, "text/plain", content[0].(map[string]any)["type"])
	_, hasValue := content[0].(map[string]any)["value"]
	assert.False(t, hasValue, "SendGrid omits empty content values from JSON")
}

func TestSendgrid_Cov_CustomHeadersDoNotOverrideUnsubscribe(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]any
	tr := newTestSendGridTransport(t, func(w http.ResponseWriter, r *http.Request) {
		err := json.NewDecoder(r.Body).Decode(&receivedPayload)
		require.NoError(t, err)
		w.WriteHeader(http.StatusAccepted)
	})

	err := tr.Send(context.Background(), Message{
		To:             []string{"user@example.com"},
		Subject:        "custom headers",
		Text:           "hello",
		UnsubscribeURL: "https://smithers.sh/unsubscribe?token=abc",
		Headers: map[string]string{
			"List-Unsubscribe":      "<https://evil.example/unsub>",
			"List-Unsubscribe-Post": "ignored",
			"X-Campaign-ID":         "digest-42",
		},
	})

	require.NoError(t, err)
	headers := receivedPayload["headers"].(map[string]any)
	assert.Equal(t, "<https://smithers.sh/unsubscribe?token=abc>", headers["List-Unsubscribe"])
	assert.Equal(t, "List-Unsubscribe=One-Click", headers["List-Unsubscribe-Post"])
	assert.Equal(t, "digest-42", headers["X-Campaign-ID"])
}

func TestSendgrid_Cov_ValidateRecipients(t *testing.T) {
	t.Parallel()

	err := ValidateSendGridRecipients([]string{"a@example.com", "b@example.com"})
	require.NoError(t, err)

	err = ValidateSendGridRecipients([]string{"a@example.com", "missing-at-sign"})
	require.Error(t, err)
	assert.Equal(t, `email: invalid recipient "missing-at-sign"`, err.Error())
}
