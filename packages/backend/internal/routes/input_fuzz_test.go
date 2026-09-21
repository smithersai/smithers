package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// FuzzSessionCookieName fuzzes the session cookie name resolver.
func FuzzSessionCookieName(f *testing.F) {
	f.Add("smithers_session")
	f.Add("")
	f.Add("   ")
	f.Add("custom-session-name")
	f.Add(strings.Repeat("a", 10000))
	f.Add("\x00\x01\x02")
	f.Add("\n\r\t")

	f.Fuzz(func(t *testing.T, configuredName string) {
		// Must never panic.
		result := sessionCookieName(configuredName)
		// Must always return a non-empty string.
		if result == "" {
			t.Error("sessionCookieName returned empty string")
		}
	})
}

// FuzzOAuthStateVerifierFromRequest fuzzes the OAuth state cookie extraction.
func FuzzOAuthStateVerifierFromRequest(f *testing.F) {
	f.Add("valid-state-verifier")
	f.Add("")
	f.Add("   ")
	f.Add(strings.Repeat("a", 10000))
	f.Add("\x00\x01\x02")
	f.Add("state with spaces")
	f.Add("state\nwith\nnewlines")

	f.Fuzz(func(t *testing.T, cookieValue string) {
		req := httptest.NewRequest(http.MethodGet, "/callback", nil)
		req.AddCookie(&http.Cookie{
			Name:  oauthStateCookieName,
			Value: cookieValue,
		})
		// Must never panic.
		_ = oauthStateVerifierFromRequest(req)
	})
}

// FuzzWriteRouteError fuzzes the route error writer to ensure it never panics
// on arbitrary error types. This is important because panics in error handling
// could mask security issues or cause crashes.
func FuzzWriteRouteError(f *testing.F) {
	f.Add("internal server error")
	f.Add("")
	f.Add(strings.Repeat("a", 10000))
	f.Add("\x00\x01\x02")
	f.Add("error with <html> tags")
	f.Add("error\nwith\nnewlines")
	f.Add("{\"json\": \"payload\"}")

	f.Fuzz(func(t *testing.T, errMsg string) {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		// Must never panic when given a plain error.
		writeRouteError(w, r, &testFuzzError{msg: errMsg})
	})
}

// testFuzzError is a simple error type for fuzzing writeRouteError.
type testFuzzError struct {
	msg string
}

func (e *testFuzzError) Error() string { return e.msg }

// FuzzPostKeyAuthVerifyRequestParsing fuzzes JSON parsing of the key auth
// verify request body. This is the entry point for untrusted authentication input.
func FuzzPostKeyAuthVerifyRequestParsing(f *testing.F) {
	// Valid JSON.
	f.Add(`{"message":"hello","signature":"0xdead"}`)

	// Empty JSON object.
	f.Add(`{}`)

	// Empty body.
	f.Add(``)

	// Invalid JSON.
	f.Add(`{invalid`)
	f.Add(`{"message":`)

	// Very large JSON.
	f.Add(`{"message":"` + strings.Repeat("a", 10000) + `","signature":"` + strings.Repeat("b", 10000) + `"}`)

	// Null values.
	f.Add(`{"message":null,"signature":null}`)

	// Numeric values where strings expected.
	f.Add(`{"message":12345,"signature":67890}`)

	// Array values.
	f.Add(`{"message":["a","b"],"signature":["c","d"]}`)

	// Nested objects.
	f.Add(`{"message":{"nested":"value"},"signature":{}}`)

	// Extra fields.
	f.Add(`{"message":"hello","signature":"world","extra":"field","__proto__":"polluted"}`)

	// Unicode edge cases.
	f.Add(`{"message":"\u0000","signature":"\uffff"}`)

	// Extremely nested JSON.
	f.Add(strings.Repeat(`{"a":`, 100) + `"deep"` + strings.Repeat(`}`, 100))

	f.Fuzz(func(t *testing.T, body string) {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")

		// Test the JSON parsing step in isolation (no service call).
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic during JSON parsing: %v", r)
				}
			}()

			var parsed postKeyAuthVerifyRequest
			bodyBytes, _ := io.ReadAll(req.Body)
			if len(bodyBytes) > 0 {
				_ = json.Unmarshal(bodyBytes, &parsed)
			}
			// Validate the parsed result.
			_ = strings.TrimSpace(parsed.Message)
			_ = strings.TrimSpace(parsed.Signature)
		}()
	})
}

// FuzzCreateRepoRequestParsing fuzzes JSON parsing of the repo creation request.
func FuzzCreateRepoRequestParsing(f *testing.F) {
	f.Add(`{"name":"my-repo","description":"test","private":false}`)
	f.Add(`{}`)
	f.Add(``)
	f.Add(`{"name":"` + strings.Repeat("a", 10000) + `"}`)
	f.Add(`{"name":null}`)
	f.Add(`{"name":123}`)
	f.Add(`{"private":"not-a-bool"}`)
	f.Add(`{invalid json`)

	f.Fuzz(func(t *testing.T, body string) {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic during JSON parsing: %v", r)
			}
		}()

		var parsed CreateRepoRequest
		if len(body) > 0 {
			_ = json.Unmarshal([]byte(body), &parsed)
		}
		_ = strings.TrimSpace(parsed.Name)
	})
}

// FuzzNormalizeTokenScopeViaMiddleware fuzzes the token scope normalizer from
// the middleware package. This is security-critical because token scopes control
// API access permissions.
func FuzzNormalizeTokenScopeViaMiddleware(f *testing.F) {
	// Known valid scopes.
	f.Add("repo")
	f.Add("repository")
	f.Add("write:repository")
	f.Add("read:repository")
	f.Add("org")
	f.Add("organization")
	f.Add("write:organization")
	f.Add("read:organization")
	f.Add("user")
	f.Add("write:user")
	f.Add("read:user")
	f.Add("admin")
	f.Add("all")

	// Invalid scopes.
	f.Add("")
	f.Add("   ")
	f.Add("invalid")
	f.Add("ADMIN")
	f.Add("Admin")
	f.Add("read:")
	f.Add(":read")
	f.Add("write:invalid")

	// Edge cases.
	f.Add(strings.Repeat("a", 10000))
	f.Add("\x00admin")
	f.Add("admin\x00")
	f.Add("\n\r\t")

	f.Fuzz(func(t *testing.T, raw string) {
		// Must never panic.
		_ = middleware.NormalizeTokenScope(raw)
	})
}
