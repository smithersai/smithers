package wsrunner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/pion/webrtc/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func runnerHRestoreSeams(t *testing.T) {
	t.Helper()

	origNewPeerConnection := newPeerConnection
	origCreateDataChannel := createDataChannel
	origCreateOffer := createOffer
	origSetLocalDescription := setLocalDescription
	origStartPTY := startPTY
	origStartPTYWithSize := startPTYWithSize
	origSetPTYSize := setPTYSize

	t.Cleanup(func() {
		newPeerConnection = origNewPeerConnection
		createDataChannel = origCreateDataChannel
		createOffer = origCreateOffer
		setLocalDescription = origSetLocalDescription
		startPTY = origStartPTY
		startPTYWithSize = origStartPTYWithSize
		setPTYSize = origSetPTYSize
	})
}

func runnerHNewTrackedSession(t *testing.T, id string) (context.Context, context.CancelFunc, *runnerCovAPI, *Runner, *Session) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	api := runnerCovNewAPI()
	r := New(Config{WorkspaceID: "ws_h", IdleTimeout: time.Hour})
	r.api = api
	sess := &Session{ID: id, api: api, runner: r, cancel: cancel}

	r.mu.Lock()
	r.sessions[id] = sess
	r.mu.Unlock()

	return ctx, cancel, api, r, sess
}

func runnerHRequireStoppedAndRemoved(t *testing.T, api *runnerCovAPI, r *Runner, sess *Session) {
	t.Helper()

	assert.Equal(t, []string{"stopped"}, runnerCovSessionStatuses(api, sess.ID))

	r.mu.Lock()
	_, exists := r.sessions[sess.ID]
	r.mu.Unlock()
	assert.False(t, exists)
}

func runnerHSignalSession(t *testing.T, sess *Session, api *runnerCovAPI) (<-chan *webrtc.DataChannel, <-chan error) {
	t.Helper()

	remote, err := runnerTestPeerConnection(webrtc.Configuration{})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, remote.Close()) })

	var mu sync.Mutex
	var pendingLocalCandidates []webrtc.ICECandidateInit
	asyncErrs := make(chan error, 16)

	api.exchangeFn = func(ctx context.Context, sessionID, sdp, iceCandidates string) (*SessionInfo, error) {
		if iceCandidates != "" {
			candidate := webrtc.ICECandidateInit{}
			if err := json.Unmarshal([]byte(iceCandidates), &candidate); err != nil {
				runnerCovRecordAsyncError(asyncErrs, err)
				return &SessionInfo{ID: sessionID}, nil
			}

			mu.Lock()
			if remote.RemoteDescription() == nil {
				pendingLocalCandidates = append(pendingLocalCandidates, candidate)
				mu.Unlock()
			} else {
				mu.Unlock()
				runnerCovRecordAsyncError(asyncErrs, remote.AddICECandidate(candidate))
			}
		}

		if sdp != "" {
			answer := runnerCovBuildAnswer(t, remote, sdp)

			mu.Lock()
			pending := append([]webrtc.ICECandidateInit(nil), pendingLocalCandidates...)
			pendingLocalCandidates = nil
			mu.Unlock()

			for _, candidate := range pending {
				require.NoError(t, remote.AddICECandidate(candidate))
			}
			require.NoError(t, sess.Peer.SetRemoteDescription(answer))
		}

		return &SessionInfo{ID: sessionID}, nil
	}

	remote.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil || sess.Peer == nil || sess.Peer.RemoteDescription() == nil {
			return
		}
		runnerCovRecordAsyncError(asyncErrs, sess.Peer.AddICECandidate(candidate.ToJSON()))
	})

	dataChannels := make(chan *webrtc.DataChannel, 1)
	remote.OnDataChannel(func(dc *webrtc.DataChannel) {
		dataChannels <- dc
	})

	return dataChannels, asyncErrs
}

func runnerHWaitForDataChannel(t *testing.T, dataChannels <-chan *webrtc.DataChannel) *webrtc.DataChannel {
	t.Helper()

	select {
	case dc := <-dataChannels:
		return dc
	case <-time.After(5 * time.Second):
		t.Fatal("remote peer did not receive data channel")
		return nil
	}
}

func TestRunner_H_InitializeInjectedSetupFailuresCloseSession(t *testing.T) {
	tests := []struct {
		name   string
		inject func()
	}{
		{
			name: "peer connection",
			inject: func() {
				newPeerConnection = func(webrtc.Configuration) (*webrtc.PeerConnection, error) {
					return nil, errors.New("peer failed")
				}
			},
		},
		{
			name: "data channel",
			inject: func() {
				createDataChannel = func(*webrtc.PeerConnection, string, *webrtc.DataChannelInit) (*webrtc.DataChannel, error) {
					return nil, errors.New("data channel failed")
				}
			},
		},
		{
			name: "offer",
			inject: func() {
				createOffer = func(*webrtc.PeerConnection, *webrtc.OfferOptions) (webrtc.SessionDescription, error) {
					return webrtc.SessionDescription{}, errors.New("offer failed")
				}
			},
		},
		{
			name: "local description",
			inject: func() {
				setLocalDescription = func(*webrtc.PeerConnection, webrtc.SessionDescription) error {
					return errors.New("local description failed")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runnerHRestoreSeams(t)
			tt.inject()

			ctx, cancel, api, r, sess := runnerHNewTrackedSession(t, "sess_h_"+tt.name)
			defer cancel()

			sess.initialize(ctx, 0, 0)

			runnerHRequireStoppedAndRemoved(t, api, r, sess)
		})
	}
}

func TestRunner_H_InitializePTYStartErrorReturnsFromOpenHandler(t *testing.T) {
	runnerHRestoreSeams(t)

	startCalled := make(chan struct{})
	startPTY = func(*exec.Cmd) (*os.File, error) {
		close(startCalled)
		return nil, errors.New("pty start failed")
	}

	ctx, cancel, api, _, sess := runnerHNewTrackedSession(t, "sess_h_pty_start")
	defer cancel()
	defer sess.Close()

	dataChannels, asyncErrs := runnerHSignalSession(t, sess, api)
	sess.initialize(ctx, 0, 0)

	remoteDC := runnerHWaitForDataChannel(t, dataChannels)
	runnerCovWaitForDataChannelOpen(t, remoteDC)

	select {
	case <-startCalled:
	case <-time.After(5 * time.Second):
		t.Fatal("PTY start seam was not called")
	}
	runnerCovRequireNoAsyncError(t, asyncErrs)
	assert.Empty(t, runnerCovSessionStatuses(api, sess.ID))
}

func TestRunner_H_InitializePTYReadNonEOFClosesSession(t *testing.T) {
	runnerHRestoreSeams(t)

	// The PTY seam hands the session the read end of a pipe. The read error
	// is injected only after the data channel is open on both sides and the
	// session reports running: an already-closed file failed the very first
	// Read, so the session tore its peer down while the remote data channel
	// was still opening and the open wait below raced that teardown.
	ptyReader, ptyWriter, err := os.Pipe()
	require.NoError(t, err)
	t.Cleanup(func() { _ = ptyWriter.Close() })
	startPTY = func(*exec.Cmd) (*os.File, error) {
		return ptyReader, nil
	}
	startPTYWithSize = func(*exec.Cmd, *pty.Winsize) (*os.File, error) {
		return startPTY(nil)
	}

	ctx, cancel, api, _, sess := runnerHNewTrackedSession(t, "sess_h_pty_read")
	defer cancel()

	dataChannels, asyncErrs := runnerHSignalSession(t, sess, api)
	sess.initialize(ctx, 80, 24)

	remoteDC := runnerHWaitForDataChannel(t, dataChannels)
	runnerCovWaitForDataChannelOpen(t, remoteDC)
	runnerCovWaitForStatus(t, api.statusCh, sess.ID+":running")
	// Closing the file under the pump's blocked Read makes it return a
	// non-EOF error (os.ErrClosed), the condition under test.
	require.NoError(t, ptyReader.Close())
	runnerCovWaitForStatus(t, api.statusCh, sess.ID+":stopped")

	runnerCovRequireNoAsyncError(t, asyncErrs)
	assert.Contains(t, runnerCovSessionStatuses(api, sess.ID), "stopped")
}
