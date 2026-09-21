package repohostserver

import (
	"errors"
	"strings"
	"testing"
)

func TestErrors_Cov_AppErrorErrorIncludesCause(t *testing.T) {
	cause := errors.New("disk full")
	err := internalError("create repo storage path", cause)

	got := err.Error()
	if !strings.Contains(got, "create repo storage path") || !strings.Contains(got, "disk full") {
		t.Fatalf("Error() = %q, want message and cause", got)
	}
}
