package sandbox

import (
	"strings"
	"testing"
)

func TestStatusErrorDoesNotInventProvider(t *testing.T) {
	err := (&StatusError{StatusCode: 503, Message: "unavailable"}).Error()
	if strings.Contains(err, "microsandbox") || !strings.Contains(err, "sandbox api returned status 503") {
		t.Fatalf("unspecified provider must remain neutral: %s", err)
	}
	named := (&StatusError{StatusCode: 503, Provider: "isolated-runtime"}).Error()
	if !strings.HasPrefix(named, "isolated-runtime api") {
		t.Fatalf("explicit provider identity was lost: %s", named)
	}
}
