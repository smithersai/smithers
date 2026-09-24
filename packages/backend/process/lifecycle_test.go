//go:build unix

package process

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestRuntimeWorkspaceCleanupDoesNotWaitForCommandResultDelivery(t *testing.T) {
	for _, operation := range []string{"stop", "delete"} {
		t.Run(operation, func(t *testing.T) {
			runtime := newTestRuntime(t, t.TempDir())
			workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "cleanup"})
			require.NoError(t, err)
			_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
			require.NoError(t, err)

			finished := make(chan error, 1)
			go func() {
				_, err := runtime.ExecuteCommand(context.Background(), workspace.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 30"}})
				finished <- err
			}()

			var process *managedProcess
			require.Eventually(t, func() bool {
				runtime.mu.Lock()
				defer runtime.mu.Unlock()
				for child := range runtime.workspaces[workspace.ID].processes {
					process = child
				}
				return process != nil
			}, time.Second, time.Millisecond)

			// A command can be reaped before ExecuteCommand delivers its result
			// and unregisters it. Hold that interval open without delaying exit.
			stdout := process.cmd.Stdout.(*limitedBuffer)
			stdout.mu.Lock()
			defer func() {
				stdout.mu.Unlock()
				select {
				case err := <-finished:
					require.NoError(t, err)
				case <-time.After(time.Second):
					t.Error("command result did not finish after cleanup")
				}
			}()

			switch operation {
			case "stop":
				require.NoError(t, runtime.StopWorkspace(context.Background(), workspace.ID))
				runtime.mu.Lock()
				remaining := len(runtime.workspaces[workspace.ID].processes)
				runtime.mu.Unlock()
				require.Zero(t, remaining, "stopped workspace retained a reaped command")
			case "delete":
				require.NoError(t, runtime.DeleteWorkspace(context.Background(), workspace.ID))
				_, err := runtime.InspectWorkspace(context.Background(), workspace.ID)
				require.ErrorIs(t, err, workspaceapi.ErrWorkspaceNotFound)
			}
		})
	}
}

func TestRuntimeWorkspaceStopReportsIntentionalServiceStops(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "stop-services"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	for _, name := range []string{"live", "failed"} {
		command := "sleep 30"
		if name == "failed" {
			command = "sleep 0.02; exit 7"
		}
		_, err = runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{Name: name, Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", command}}})
		require.NoError(t, err)
	}
	require.Eventually(t, func() bool {
		observed, err := runtime.InspectService(context.Background(), workspace.ID, "failed")
		return err == nil && observed.State == workspaceapi.ServiceFailed
	}, time.Second, time.Millisecond)
	require.NoError(t, runtime.StopWorkspace(context.Background(), workspace.ID))
	live, err := runtime.InspectService(context.Background(), workspace.ID, "live")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.ServiceStopped, live.State)
	failed, err := runtime.InspectService(context.Background(), workspace.ID, "failed")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.ServiceFailed, failed.State, "workspace stop must preserve a prior failure")
}

func TestRuntimeCommandCleanupUsesCanonicalWorkspaceID(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "canonical"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	_, err = runtime.ExecuteCommand(context.Background(), " \t"+workspace.ID+"\n", workspaceapi.Command{Args: []string{"/bin/sh", "-c", "printf done"}})
	require.NoError(t, err)
	runtime.mu.Lock()
	remaining := len(runtime.workspaces[workspace.ID].processes)
	runtime.mu.Unlock()
	require.Zero(t, remaining, "accepted workspace IDs must also resolve during command cleanup")
}
