package webhook

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type deliveryCovRoundTripper struct {
	fn func(*http.Request) (*http.Response, error)
}

func (rt deliveryCovRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return rt.fn(req)
}

type deliveryCovErrBody struct{}

func (deliveryCovErrBody) Read(_ []byte) (int, error) {
	return 0, errors.New("read failed")
}

func (deliveryCovErrBody) Close() error {
	return nil
}

func TestDelivery_Cov_InvalidURLReturnsRequestError(t *testing.T) {
	t.Parallel()

	status, body, err := Deliver(context.Background(), http.DefaultClient, DeliveryRequest{
		URL:     "http://[::1",
		Payload: []byte(`{}`),
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "missing ']' in host")
	assert.Equal(t, 0, status)
	assert.Empty(t, body)
}

func TestDelivery_Cov_ResponseBodyReadErrorReturnsStatus(t *testing.T) {
	t.Parallel()

	client := &http.Client{
		Transport: deliveryCovRoundTripper{fn: func(req *http.Request) (*http.Response, error) {
			assert.Equal(t, http.MethodPost, req.Method)
			return &http.Response{
				StatusCode: http.StatusTeapot,
				Header:     make(http.Header),
				Body:       deliveryCovErrBody{},
				Request:    req,
			}, nil
		}},
	}

	status, body, err := Deliver(context.Background(), client, DeliveryRequest{
		URL:        "https://example.com/hook",
		Secret:     "secret",
		EventType:  "test_event",
		DeliveryID: "delivery-read-error",
		Payload:    []byte(`{"ok":true}`),
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "read failed")
	assert.Equal(t, http.StatusTeapot, status)
	assert.Empty(t, body)
}

func TestDelivery_Cov_VerifyPayloadSignatureRejectsMalformedHex(t *testing.T) {
	t.Parallel()

	signature := "sha256=" + strings.Repeat("z", sha256.Size*2)

	assert.False(t, VerifyPayloadSignature("secret", []byte(`{"ok":true}`), signature))
}
