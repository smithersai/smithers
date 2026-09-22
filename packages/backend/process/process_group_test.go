//go:build unix

package process

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestRuntimeReapsDescendantsAfterLeaderExit(t *testing.T) {
	for _, redirected := range []bool{true, false} {
		t.Run(strconv.FormatBool(redirected), func(t *testing.T) {
			runtime := newTestRuntime(t, t.TempDir())
			workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "descendants"})
			require.NoError(t, err)
			_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
			require.NoError(t, err)

			command := "sleep 30 & echo $! > child.pid"
			if redirected {
				command = "sleep 30 >/dev/null 2>&1 & echo $! > child.pid"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			result, executeErr := runtime.ExecuteCommand(ctx, workspace.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", command}})
			pidBytes, err := os.ReadFile(filepath.Join(workspace.Root, "child.pid"))
			require.NoError(t, err)
			pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
			require.NoError(t, err)
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
			if redirected {
				require.NoError(t, executeErr)
			} else {
				require.ErrorIs(t, executeErr, exec.ErrWaitDelay, "inherited output pipes must have a bounded wait after leader exit")
			}
			require.Zero(t, result.ExitCode)
			require.Eventually(t, func() bool {
				return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
			}, time.Second, time.Millisecond, "descendant %d survived its command", pid)
		})
	}
}
