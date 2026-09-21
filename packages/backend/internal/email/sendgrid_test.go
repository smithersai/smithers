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

// newTestSendGridTransport creates a SendGridTransport pointed at a test server.
func newTestSendGridTransport(t *testing.T, handler http.HandlerFunc) *SendGridTransport {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	tr, err := NewSendGridTransport(SendGridConfig{
		APIKey: "SG.test-key",
		From:   "noreply@smithers.sh",
	})
	require.NoError(t, err)

	// Point the SDK client at our test server.
	req := sendgrid.GetRequest("SG.test-key", "/v3/mail/send", server.URL)
	req.Method = http.MethodPost
	tr.client = &sendgrid.Client{Request: req}

	return tr
}

func TestNewSendGridTransport_RequiresAPIKey(t *testing.T) {
	t.Parallel()

	_, err := NewSendGridTransport(SendGridConfig{From: "noreply@smithers.sh"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "API key is required")
}

func TestNewSendGridTransport_Success(t *testing.T) {
	t.Parallel()

	tr, err := NewSendGridTransport(SendGridConfig{
		APIKey: "SG.test-key",
		From:   "noreply@smithers.sh",
	})
	require.NoError(t, err)
	assert.NotNil(t, tr)
}

func TestSendGridTransport_Send_CallsAPI(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]any
	var receivedAuth string

	tr := newTestSendGridTransport(t, func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		err := json.NewDecoder(r.Body).Decode(&receivedPayload)
		require.NoError(t, err)
		w.WriteHeader(http.StatusAccepted)
	})

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test SendGrid",
		HTML:    "<p>Hello</p>",
		Text:    "Hello",
	})

	require.NoError(t, err)
	assert.Equal(t, "Bearer SG.test-key", receivedAuth)

	from := receivedPayload["from"].(map[string]any)
	assert.Equal(t, "noreply@smithers.sh", from["email"])
	assert.Equal(t, "Test SendGrid", receivedPayload["subject"])

	personalizations := receivedPayload["personalizations"].([]any)
	require.Len(t, personalizations, 1)
	p := personalizations[0].(map[string]any)
	tos := p["to"].([]any)
	require.Len(t, tos, 1)
	assert.Equal(t, "user@example.com", tos[0].(map[string]any)["email"])

	content := receivedPayload["content"].([]any)
	require.Len(t, content, 2)
	assert.Equal(t, "text/plain", content[0].(map[string]any)["type"])
	assert.Equal(t, "Hello", content[0].(map[string]any)["value"])
	assert.Equal(t, "text/html", content[1].(map[string]any)["type"])
	assert.Equal(t, "<p>Hello</p>", content[1].(map[string]any)["value"])
}

func TestSendGridTransport_Send_NoRecipients(t *testing.T) {
	t.Parallel()

	tr, err := NewSendGridTransport(SendGridConfig{
		APIKey: "SG.test-key",
		From:   "noreply@smithers.sh",
	})
	require.NoError(t, err)

	err = tr.Send(context.Background(), Message{
		To:      []string{},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "no recipients")
}

func TestSendGridTransport_Send_NoFromAddress(t *testing.T) {
	t.Parallel()

	tr, err := NewSendGridTransport(SendGridConfig{APIKey: "SG.test-key"})
	require.NoError(t, err)

	err = tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "no from address")
}

func TestSendGridTransport_Send_MessageFromOverridesConfig(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]any

	tr := newTestSendGridTransport(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusAccepted)
	})

	err := tr.Send(context.Background(), Message{
		From:    "override@smithers.sh",
		To:      []string{"user@example.com"},
		Subject: "Test",
		Text:    "Hello",
	})

	require.NoError(t, err)
	from := receivedPayload["from"].(map[string]any)
	assert.Equal(t, "override@smithers.sh", from["email"])
}

func TestSendGridTransport_Send_APIError(t *testing.T) {
	t.Parallel()

	tr := newTestSendGridTransport(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"errors":[{"message":"The provided API key is not valid"}]}`))
	})

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
		Text:    "Hello",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "sendgrid returned 403")
}

func TestSendGridTransport_Send_WithUnsubscribeURL(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]any

	tr := newTestSendGridTransport(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusAccepted)
	})

	err := tr.Send(context.Background(), Message{
		To:             []string{"user@example.com"},
		Subject:        "Test",
		Text:           "Hello",
		UnsubscribeURL: "https://smithers.sh/unsubscribe?token=abc",
	})

	require.NoError(t, err)
	headers := receivedPayload["headers"].(map[string]any)
	assert.Equal(t, "<https://smithers.sh/unsubscribe?token=abc>", headers["List-Unsubscribe"])
	assert.Equal(t, "List-Unsubscribe=One-Click", headers["List-Unsubscribe-Post"])
}

func TestSendGridTransport_Send_MultipleRecipients(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]any

	tr := newTestSendGridTransport(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusAccepted)
	})

	err := tr.Send(context.Background(), Message{
		To:      []string{"a@example.com", "b@example.com"},
		Subject: "Test",
		Text:    "Hello",
	})

	require.NoError(t, err)
	personalizations := receivedPayload["personalizations"].([]any)
	tos := personalizations[0].(map[string]any)["to"].([]any)
	require.Len(t, tos, 2)
	assert.Equal(t, "a@example.com", tos[0].(map[string]any)["email"])
	assert.Equal(t, "b@example.com", tos[1].(map[string]any)["email"])
}

func TestSendGridTransport_Send_HTMLOnly(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]any

	tr := newTestSendGridTransport(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusAccepted)
	})

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
		HTML:    "<h1>Hello</h1>",
	})

	require.NoError(t, err)
	content := receivedPayload["content"].([]any)
	require.Len(t, content, 1)
	assert.Equal(t, "text/html", content[0].(map[string]any)["type"])
}
