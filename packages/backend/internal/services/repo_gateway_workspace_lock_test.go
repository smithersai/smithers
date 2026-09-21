package services

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A Linux kernel/Node-process check of util-linux's --no-fork lifetime. Opt in
// with the already-pulled node:22-bookworm image; ordinary Go checks never pull
// an image or start a daemon unexpectedly.
func TestWorkspaceGateway_LinuxHostLockLifetime(t *testing.T) {
	image := os.Getenv("SMITHERS_GATEWAY_LOCK_TEST_IMAGE")
	if image == "" {
		t.Skip("set SMITHERS_GATEWAY_LOCK_TEST_IMAGE=node:22-bookworm for the Linux process proof")
	}
	script, err := os.ReadFile("testdata/workspace-coding-host-lock.sh")
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "-i", image, "sh")
	cmd.Stdin = strings.NewReader(string(script))
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, "%s", output)
	require.Contains(t, string(output), "second host refused before Node initialization (75)")
	require.Contains(t, string(output), "replacement acquired after first exit")
	require.NotContains(t, string(output), "UNEXPECTED SECOND HOST")
}
