//go:build unix

package process

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestRuntimeReadFileRejectsNamedPipesWithoutWaitingForWriter(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "special-files"})
	require.NoError(t, err)
	pipe := filepath.Join(workspace.Root, "pipe")
	require.NoError(t, syscall.Mkfifo(pipe, 0o600))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		_, err := runtime.ReadFile(ctx, workspace.ID, "pipe")
		finished <- err
	}()
	select {
	case err = <-finished:
	case <-time.After(100 * time.Millisecond):
		// Release an old implementation blocked in open so failure does not
		// leave a goroutine or named-pipe descriptor behind.
		writer, openErr := os.OpenFile(pipe, os.O_WRONLY, 0)
		require.NoError(t, openErr)
		require.NoError(t, writer.Close())
		err = <-finished
		t.Error("ReadFile waited for a named-pipe writer after its context expired")
	}
	require.ErrorContains(t, err, "regular file")
}
