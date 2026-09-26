package smitherscli

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRemoteShellTimeoutBoundsInheritedPipes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("XDG_STATE_HOME", dir)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	pidPath := filepath.Join(dir, "child.pid")
	t.Setenv("SMITHERS_TEST_PIPE_PID", pidPath)
	if err := os.WriteFile(filepath.Join(dir, "ssh"), []byte("#!/bin/sh\n/bin/sleep 3 &\nprintf '%s' \"$!\" > \"$SMITHERS_TEST_PIPE_PID\"\nwait\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		raw, _ := os.ReadFile(pidPath)
		pid, _ := strconv.Atoi(string(raw))
		if pid > 0 {
			if child, err := os.FindProcess(pid); err == nil {
				_ = child.Kill()
				_ = child.Release()
			}
		}
	})
	start := time.Now()
	_, err := runRemoteShellCommand("ssh user@example.test", "true", "test shell", false, 500*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("timeout error=%v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("500ms timeout waited %s for an inherited stdout pipe", elapsed)
	}
	if _, err := os.Stat(pidPath); err != nil {
		t.Fatalf("fixture did not create a descendant before timeout: %v", err)
	}
}
