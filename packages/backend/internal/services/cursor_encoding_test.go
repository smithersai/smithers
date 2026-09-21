package services

import (
	"encoding/base64"
	"testing"
)

// Landing-request and notification list pagination emit their next-page cursor via
// encodeIssueNumberCursor. routes.decodeIDCursor base64-decodes the cursor FIRST,
// so a plain-decimal cursor (which is itself valid base64url) decodes to garbage
// and resolves to 0 — pinning the client to page 1. The cursor must therefore be
// the canonical base64(decimal) form, which round-trips through decodeIDCursor.
func TestEncodeIssueNumberCursorRoundTripsAsBase64(t *testing.T) {
	enc := encodeIssueNumberCursor(40)
	if enc == "40" {
		t.Fatal("cursor must be base64-encoded, not plain decimal (plain decimal pins pagination to page 1)")
	}
	dec, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil || string(dec) != "40" {
		t.Fatalf("encodeIssueNumberCursor(40) = %q (decoded %q, err %v); want base64 of \"40\"", enc, string(dec), err)
	}
}
