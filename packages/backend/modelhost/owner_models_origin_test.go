package modelhost

import "testing"

func TestModelOriginAllowsLocalDockerProvider(t *testing.T) {
	for _, tc := range []struct {
		origin string
		valid  bool
	}{
		{origin: "http://host.docker.internal:8123", valid: true},
		{origin: "http://example.com:8123", valid: false},
		{origin: "http://host.docker.internal.evil.example:8123", valid: false},
		{origin: "https://example.com", valid: true},
	} {
		got, ok := modelOrigin(tc.origin)
		if ok != tc.valid || (ok && got != tc.origin) {
			t.Errorf("modelOrigin(%q) = (%q, %v), want valid=%v", tc.origin, got, ok, tc.valid)
		}
	}
}
