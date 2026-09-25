package smitherscli

import "os"

// A release binary ignores test-only environment hooks.
var testSeamsEnabled bool

func testSeamEnv(name string) string {
	if !testSeamsEnabled {
		return ""
	}
	return os.Getenv(name)
}
