package services

import (
	"encoding/base64"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestEncodeIssueNumberCursor_RoundTrip guards the production pagination bug
// where multi-digit cursors decoded to 0 and pinned the client to page 1.
//
// The route handlers (ListIssues, ListIssueComments) decode the returned cursor
// with routes.decodeIDCursor, which tries base64 FIRST. A plain decimal cursor
// like "71" is itself valid base64, so it decoded to garbage bytes, failed to
// parse, and returned 0 (first-page sentinel). The encoder must therefore use
// the SAME base64 scheme as routes.encodeIDCursor/decodeIDCursor.
func TestEncodeIssueNumberCursor_RoundTrip(t *testing.T) {
	t.Parallel()

	// Spans the digit-lengths that broke in prod (2..5 digits) plus edges.
	numbers := []int64{1, 7, 42, 71, 100, 255, 1000, 12345, 999999}

	for _, n := range numbers {
		n := n
		t.Run(strconv.FormatInt(n, 10), func(t *testing.T) {
			cursor := encodeIssueNumberCursor(n)
			require.NotEmpty(t, cursor)

			// (1) Round-trips through the service decoder.
			assert.Equal(t, n, decodeIssueNumberCursor(cursor), "decodeIssueNumberCursor must round-trip")

			// (2) Byte-identical to the routes.encodeIDCursor formula, which is
			// what the route handlers decode with. This is the cross-package
			// invariant: decodeIDCursor(encodeIssueNumberCursor(n)) == n.
			wantEncoding := base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(n, 10)))
			assert.Equal(t, wantEncoding, cursor, "must use the same base64 scheme as routes.encodeIDCursor")

			// (3) Decoding the way routes.decodeIDCursor does (base64-first)
			// yields the original number — NOT the 0 first-page sentinel.
			raw, err := base64.RawURLEncoding.DecodeString(cursor)
			require.NoError(t, err)
			got, err := strconv.ParseInt(string(raw), 10, 64)
			require.NoError(t, err)
			assert.Equal(t, n, got, "route-side base64 decode must recover the number, not 0")
		})
	}
}

// encodeIssueNumberCursor(0) and below is the empty first-page cursor.
func TestEncodeIssueNumberCursor_NonPositive(t *testing.T) {
	t.Parallel()
	assert.Empty(t, encodeIssueNumberCursor(0))
	assert.Empty(t, encodeIssueNumberCursor(-5))
	assert.Zero(t, decodeIssueNumberCursor(""))
}
