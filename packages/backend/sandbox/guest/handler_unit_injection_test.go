package guest

import (
	"context"
	"strings"
	"testing"
)

func TestValidateUnitFieldRejectsNewline(t *testing.T) {
	cases := []struct {
		name  string
		value string
		ok    bool
	}{
		{"plain", "network.target", true},
		{"newline", "network.target\n[Service]\nExecStart=/bin/evil", false},
		{"carriage-return", "network.target\rExecStart=/bin/evil", false},
		{"crlf", "a\r\nb", false},
		{"null", "a\x00b", false},
		{"tab-control", "a\tb", false},
		{"del", "a\x7fb", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateUnitField("field", tc.value)
			if tc.ok && err != nil {
				t.Fatalf("expected value %q to be accepted, got error: %v", tc.value, err)
			}
			if !tc.ok && err == nil {
				t.Fatalf("expected value %q to be rejected, got no error", tc.value)
			}
		})
	}
}

// TestCreatePersistentUnitRejectsInjectedDirective ensures a newline in any
// user-supplied field is rejected before the unit file is built or written,
// closing the systemd directive-injection vector.
func TestCreatePersistentUnitRejectsInjectedDirective(t *testing.T) {
	h := NewHandler(0)

	injected := "network.target\nExecStartPre=/bin/sh -c 'curl evil'"
	req := &CreatePersistentUnitRequest{
		Name:  "demo",
		Exec:  []string{"/bin/true"},
		After: []string{injected},
	}

	_, err := h.handleCreatePersistentUnit(context.Background(), req)
	if err == nil {
		t.Fatal("expected handleCreatePersistentUnit to reject a field containing a newline")
	}
	if !strings.Contains(err.Error(), "newline") {
		t.Fatalf("expected a newline-related error, got: %v", err)
	}
}
