package sse

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// TestSSEErrorHasNoCollidingErrorsKey is the point of the SSE conversion.
//
// writeSSEError used to emit {"message":…,"errors":["…"]} — `errors` as an
// array of STRINGS. APIError emits `errors` as an array of
// {resource, field, code} OBJECTS. Same API, same field name, two
// irreconcilable types: a generated client can be right about one of them and
// breaks on the other. The duplicate sentence carried no information, so the
// key is gone rather than retyped.
func TestSSEErrorHasNoCollidingErrorsKey(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeSSEError(rec, pkgerrors.CodeInternal, "streaming not supported")

	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw), "body was %q", rec.Body.String())
	assert.NotContains(t, raw, "errors",
		"an SSE refusal must not put a string array where the API's errors key holds field objects")

	// And it decodes as the one envelope every other refusal uses.
	var body pkgerrors.APIError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, pkgerrors.CodeInternal, body.Code)
	assert.Equal(t, pkgerrors.FaultBug, body.Fault)
	assert.Equal(t, "streaming not supported", body.Message)
}

// TestSSEListenerFailureIsInfraNotADefect covers the two arms where plue's own
// LISTEN tier refused the stream. They answered 500 with no code, so a client
// was told plue is defective and given no pacing; nothing was established, so
// reconnecting is exactly the right move and 503 + Retry-After says so.
func TestSSEListenerFailureIsInfraNotADefect(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeSSEError(rec, pkgerrors.CodeSSEUnavailable, "failed to start SSE listener")

	var body pkgerrors.APIError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Equal(t, pkgerrors.CodeSSEUnavailable, body.Code)
	assert.Equal(t, pkgerrors.FaultInfra, body.Fault)
	assert.Equal(t, 1, body.RetryAfter)
	assert.Equal(t, "1", rec.Header().Get("Retry-After"))
}
