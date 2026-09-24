//go:build unix

package process

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestRuntimeRejectsCancelledProcessLaunches(t *testing.T) {
	for _, operation := range []string{"command", "service", "terminal"} {
		t.Run(operation, func(t *testing.T) {
			runtime := newTestRuntime(t, t.TempDir())
			workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "cancelled-launch"})
			require.NoError(t, err)
			_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
			require.NoError(t, err)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			switch operation {
			case "command":
				// Cancel after admission while the command is queued for the
				// runtime lock. It must not even resolve an executable afterward.
				runtime.mu.Lock()
				finished := make(chan error, 1)
				go func() {
					_, err := runtime.ExecuteCommand(ctx, workspace.ID, workspaceapi.Command{Args: []string{"./must-not-be-launched"}})
					finished <- err
				}()
				func() {
					defer runtime.mu.Unlock()
					require.Eventually(t, func() bool { return len(runtime.semaphore) != 0 }, time.Second, time.Millisecond)
					cancel()
				}()
				err = <-finished
			case "service":
				cancel()
				_, err = runtime.StartService(ctx, workspace.ID, workspaceapi.ServiceSpec{Name: "cancelled", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 30"}}})
			case "terminal":
				cancel()
				var terminal workspaceapi.Terminal
				terminal, err = runtime.OpenWorkspaceTerminal(ctx, workspace.ID, workspaceapi.Command{})
				if terminal != nil {
					_ = terminal.Close()
				}
			}
			require.ErrorIs(t, err, context.Canceled)
		})
	}
}
