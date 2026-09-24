package ssh

import (
	"context"
	"testing"
	"time"

	gssh "github.com/gliderlabs/ssh"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestServer_Shutdown_BeforeListen_IsNoop verifies that calling Shutdown
// on a server that hasn't started ListenAndServe is a safe no-op.
func TestServer_Shutdown_BeforeListen_IsNoop(t *testing.T) {
	t.Parallel()

	srv := &Server{
		Addr: ":0",
	}

	err := srv.Shutdown(context.Background())
	assert.NoError(t, err, "Shutdown before ListenAndServe should be a no-op and not panic")
}

// TestServer_ListenAndServe_ThenShutdown_ReturnsErrServerClosed verifies that
// calling Shutdown after ListenAndServe causes ListenAndServe to return
// ErrServerClosed, and Shutdown itself returns nil.
func TestServer_ListenAndServe_ThenShutdown_ReturnsErrServerClosed(t *testing.T) {
	t.Parallel()

	// Create a minimal server with a temp host key directory
	hostKeyDir := t.TempDir()
	srv := &Server{
		Addr:       ":0", // random port
		HostKeyDir: hostKeyDir,
	}

	listenErrCh := make(chan error, 1)
	go func() {
		listenErrCh <- srv.ListenAndServe()
	}()

	// Give the server a moment to start listening
	time.Sleep(200 * time.Millisecond)

	// Now shut it down
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	shutdownErr := srv.Shutdown(ctx)
	assert.NoError(t, shutdownErr, "Shutdown should return nil for clean shutdown")

	// ListenAndServe should return ErrServerClosed
	select {
	case listenErr := <-listenErrCh:
		require.Error(t, listenErr)
		assert.ErrorIs(t, listenErr, gssh.ErrServerClosed,
			"ListenAndServe should return ErrServerClosed after Shutdown")
	case <-time.After(5 * time.Second):
		t.Fatal("ListenAndServe did not return after Shutdown")
	}
}
