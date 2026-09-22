//go:build darwin || linux

package flowmanifest

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLoadRejectsFIFOManifest(t *testing.T) {
	const helperPath = "SMITHERS_FLOWMANIFEST_FIFO_TEST"
	if path := os.Getenv(helperPath); path != "" {
		if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "regular file") {
			t.Fatalf("non-regular manifest was not rejected: %v", err)
		}
		return
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, symlink := range []bool{false, true} {
		name := "fifo"
		if symlink {
			name = "symlink_to_fifo"
		}
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "manifest.fifo")
			if err := syscall.Mkfifo(path, 0o600); err != nil {
				t.Fatal(err)
			}
			if symlink {
				link := path + ".json"
				if err := os.Symlink(path, link); err != nil {
					t.Fatal(err)
				}
				path = link
			}
			// A subprocess lets a blocked open fail without leaking a goroutine
			// or opening a writer that would hide the startup hang.
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestLoadRejectsFIFOManifest$")
			command.Env = []string{helperPath + "=" + path}
			output, err := command.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatalf("Load blocked opening a FIFO manifest without a writer: %v", ctx.Err())
			}
			if err != nil {
				t.Fatalf("manifest rejection failed: %v\n%s", err, output)
			}
		})
	}
}
