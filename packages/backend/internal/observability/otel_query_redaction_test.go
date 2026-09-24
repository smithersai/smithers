package observability

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestNewTracerProvider_RedactsCredentialQueryKeysFromClientSpan(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := NewTracerProvider(exporter, 1.0)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	secrets := []string{
		"token=t0ps3cret", "access_token=at1", "refresh_token=rt1", "id_token=it1",
		"code=authcode1", "state=st1", "key=k1", "api_key=ak1", "sig=sg1",
		"signature=sn1", "X-Goog-Signature=gs1", "X-Goog-Credential=gc1",
		"X-Amz-Signature=as1", "X-Amz-Credential=ac1", "X-Amz-Security-Token=ast1",
		"client_secret=cs1", "github_token=gh1",
	}
	client := &http.Client{Transport: otelhttp.NewTransport(otelTestRoundTripper{}, otelhttp.WithTracerProvider(provider))}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		"https://user:hunter2@preview.internal/app?page=2&"+strings.Join(secrets, "&"), nil)
	require.NoError(t, err)
	resp, err := client.Do(req)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())

	require.NoError(t, provider.ForceFlush(context.Background()))
	spans := exporter.GetSpans()
	require.Len(t, spans, 1)
	full, ok := otelTestAttr(spans[0].Attributes, "url.full")
	require.True(t, ok)
	assert.Contains(t, full, "page=2")
	assert.NotContains(t, full, "hunter2")
	for _, pair := range secrets {
		key, value, _ := strings.Cut(pair, "=")
		assert.NotContains(t, full, value, "query key %s leaks", key)
		assert.Contains(t, full, key+"=REDACTED")
	}
}
