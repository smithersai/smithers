// internal/wsrunner/runner_128_test.go - Tests for issue #128 (session field
// races between WebRTC open/close paths) and issue #18 (PTY read loop
// leaking the session on a WebRTC send error).
package wsrunner

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// onceReader yields data once, then always returns io.EOF.
type onceReader struct {
	data []byte
	done bool
}

func (r *onceReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	n := copy(p, r.data)
	r.done = true
	if n == 0 {
		return 0, io.EOF
	}
	return n, nil
}

// Issue #18: previously the send-error branch of the PTY read loop returned
// without closing the session, leaking the PTY process, peer connection, and
// the runner.sessions map entry.
func TestSession_PumpPTY_ClosesOnSendError(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)
	sess := &Session{ID: "sess_pump_send_err", api: api, runner: r}
	r.mu.Lock()
	r.sessions[sess.ID] = sess
	r.mu.Unlock()

	reader := &onceReader{data: []byte("hello")}
	sendErr := errors.New("send failed")
	sess.pumpPTY(reader, func([]byte) error { return sendErr })

	api.mu.Lock()
	statuses := append([]string(nil), api.sessionStatuses[sess.ID]...)
	api.mu.Unlock()
	assert.Equal(t, []string{"stopped"}, statuses, "a send error must close the session")

	r.mu.Lock()
	_, exists := r.sessions[sess.ID]
	r.mu.Unlock()
	assert.False(t, exists, "a closed session must be deregistered from the runner")
}

// The sibling read-error branch already closed the session; this guards it
// against regressing when pumpPTY was extracted.
func TestSession_PumpPTY_ClosesOnReadEOF(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)
	sess := &Session{ID: "sess_pump_eof", api: api, runner: r}
	r.mu.Lock()
	r.sessions[sess.ID] = sess
	r.mu.Unlock()

	reader := &onceReader{done: true} // immediate EOF, no data
	sendCalls := 0
	sess.pumpPTY(reader, func([]byte) error { sendCalls++; return nil })

	assert.Equal(t, 0, sendCalls, "send must never be called when the read fails immediately")
	api.mu.Lock()
	statuses := append([]string(nil), api.sessionStatuses[sess.ID]...)
	api.mu.Unlock()
	assert.Equal(t, []string{"stopped"}, statuses)
}

// ptyFile() must be safe to call before anything has been published, and
// must never panic even for a zero-value Session.
func TestSession_PtyFile_NilBeforePublication(t *testing.T) {
	t.Parallel()

	sess := &Session{}
	assert.Nil(t, sess.ptyFile())
}

// publish() must reject writes once the session is closed, so a caller can
// tear down the resource it just built instead of leaking it.
func TestSession_Publish_RejectsAfterClose(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)
	sess := &Session{ID: "sess_publish_after_close", api: api, runner: r}
	r.mu.Lock()
	r.sessions[sess.ID] = sess
	r.mu.Unlock()

	sess.Close()

	published := sess.publish(func() { sess.PtyFile = &os.File{} })
	assert.False(t, published, "publish must reject once the session is closed")
	assert.Nil(t, sess.PtyFile, "assign() must not run once the session is closed")
}

// Issue #128: a Close() racing with initialize()'s in-flight OnOpen handler
// (which is blocked starting the PTY) must not leak the PTY file: once
// Close() has already run, the OnOpen handler's publish() call must lose the
// race and the handler must tear down the PTY file and process itself.
func TestSession_CloseRacesWithPTYPublish_ClosesLatePTY(t *testing.T) {
	runnerHRestoreSeams(t)

	ptyReady := make(chan struct{})
	continuePTY := make(chan struct{})
	var createdFile *os.File

	makeFile := func() *os.File {
		r, w, err := os.Pipe()
		require.NoError(t, err)
		t.Cleanup(func() { _ = w.Close() })
		return r
	}

	startPTY = func(*exec.Cmd) (*os.File, error) {
		createdFile = makeFile()
		close(ptyReady)
		<-continuePTY
		return createdFile, nil
	}
	startPTYWithSize = func(cmd *exec.Cmd, _ *pty.Winsize) (*os.File, error) {
		return startPTY(cmd)
	}

	ctx, cancel, api, _, sess := runnerHNewTrackedSession(t, "sess_publish_race")
	defer cancel()

	dataChannels, asyncErrs := runnerHSignalSession(t, sess, api)
	sess.initialize(ctx, 0, 0)

	remoteDC := runnerHWaitForDataChannel(t, dataChannels)
	runnerCovWaitForDataChannelOpen(t, remoteDC)

	// Wait until the OnOpen handler has started the (blocked) PTY.
	select {
	case <-ptyReady:
	case <-time.After(5 * time.Second):
		t.Fatal("startPTY was not invoked")
	}

	// Close the session while the OnOpen handler is still blocked inside
	// startPTY, then let startPTY return so the handler attempts to publish
	// into an already-closed session.
	sess.Close()
	close(continuePTY)

	require.Eventually(t, func() bool {
		if createdFile == nil {
			return false
		}
		// A second Close() on an *os.File returns an error once the first
		// close has already happened; use that to detect the teardown ran.
		return createdFile.Close() != nil
	}, 2*time.Second, 10*time.Millisecond, "PTY file created after Close() must still be closed")

	assert.Nil(t, sess.PtyFile, "PtyFile must never be published once the session is closed")
	runnerCovRequireNoAsyncError(t, asyncErrs)
}
