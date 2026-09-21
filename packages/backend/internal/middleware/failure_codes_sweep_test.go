package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// TestRateLimiterUnavailablePacesInTheBody covers the fail-closed arm of the
// rate limiter.
//
// It used to set Retry-After as a header and write a code-less 503 body, so
// WriteError backfilled `service_unavailable` with retry_after absent. The
// Cloudflare Worker in front of plue reads the BODY, never the upstream
// headers — so a caller behind the Worker was told to fail closed and given no
// pacing at all. The pacing now lives in the registry row, which puts it in
// both places.
func TestRateLimiterUnavailablePacesInTheBody(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	rec.Header().Set("Retry-After", "1")
	errors.WriteError(rec, errors.New(errors.CodeRateLimiterUnavailable, "rate limiter unavailable"))

	var body errors.APIError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Equal(t, errors.CodeRateLimiterUnavailable, body.Code)
	assert.Equal(t, errors.FaultInfra, body.Fault,
		"the caller is inside its budget; plue just cannot prove it")
	assert.Equal(t, 1, body.RetryAfter, "a Worker that never sees the header still learns the pacing")
	assert.Equal(t, "1", rec.Header().Get("Retry-After"))
}

// TestSharedBearerRefusalIsTheOneEnvelope covers the internal server-to-server
// gate. It answered with http.Error's text/plain "Unauthorized\n". One of the
// routes behind it is the Worker-only GitHub token exchange, and the Worker in
// front of plue classifies by reading the body — so that refusal was opaque to
// the one consumer that most needed to read it.
func TestSharedBearerRefusalIsTheOneEnvelope(t *testing.T) {
	t.Parallel()

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })

	for name, setup := range map[string]struct {
		expected string
		header   string
	}{
		"no token configured": {expected: "", header: "Bearer anything"},
		"no Authorization":    {expected: "secret", header: ""},
		"not a Bearer":        {expected: "secret", header: "Basic secret"},
		"wrong token":         {expected: "secret", header: "Bearer nope"},
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/internal/thing", nil)
			if setup.header != "" {
				req.Header.Set("Authorization", setup.header)
			}
			rec := httptest.NewRecorder()
			RequireSharedBearerToken(setup.expected)(next).ServeHTTP(rec, req)

			require.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.Equal(t, "application/json", rec.Header().Get("Content-Type"),
				"a refusal in text/plain cannot be classified by anything downstream")

			var body errors.APIError
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), "body was %q", rec.Body.String())
			assert.Equal(t, errors.CodeUnauthorized, body.Code)
			assert.Equal(t, errors.FaultUser, body.Fault)
			assert.NotEmpty(t, body.Message)
		})
	}
}
