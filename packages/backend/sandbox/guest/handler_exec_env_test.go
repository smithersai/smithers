package guest

import (
	"context"
	"os/user"
	"strings"
	"testing"
	"time"
)

// Exec as a named user must keep the base environment (PATH etc.) and only
// override HOME/USER — previously the child got an env of just HOME/USER,
// so anything relying on PATH broke.
func TestHandler_Exec_NamedUserKeepsBaseEnv(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Skipf("cannot resolve current user: %v", err)
	}

	h := NewHandler(time.Hour)
	resp, err := h.handleExec(context.Background(), &ExecRequest{
		Command: []string{"/usr/bin/env"},
		User:    current.Username,
	})
	if err != nil {
		if strings.Contains(err.Error(), "operation not permitted") {
			t.Skipf("cannot exec with credentials as non-root: %v", err)
		}
		t.Fatalf("handleExec: %v", err)
	}
	if resp.ExitCode != 0 {
		t.Fatalf("exit code = %d, stderr: %s", resp.ExitCode, resp.Stderr)
	}

	env := map[string]string{}
	for _, line := range strings.Split(resp.Stdout, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			env[k] = v
		}
	}
	if env["PATH"] == "" {
		t.Error("PATH missing from exec env; base environment was dropped")
	}
	if env["HOME"] != current.HomeDir {
		t.Errorf("HOME = %q, want %q", env["HOME"], current.HomeDir)
	}
	if env["USER"] != current.Username {
		t.Errorf("USER = %q, want %q", env["USER"], current.Username)
	}
}
