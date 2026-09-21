package wsrunner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type runnerCovAPI struct {
	mu sync.Mutex

	workspaceStatuses []string
	sessionStatuses   map[string][]string
	statusCh          chan string

	workspace    *WorkspaceInfo
	workspaceErr error
	statusErr    error
	exchangeErr  error

	exchangeFn   func(context.Context, string, string, string) (*SessionInfo, error)
	getSessionFn func(context.Context, string) (*SessionInfo, error)
}

func runnerCovNewAPI() *runnerCovAPI {
	return &runnerCovAPI{
		sessionStatuses: make(map[string][]string),
		statusCh:        make(chan string, 16),
	}
}

func (a *runnerCovAPI) ReportWorkspaceStatus(ctx context.Context, workspaceID, status string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.workspaceStatuses = append(a.workspaceStatuses, status)
	return a.statusErr
}

func (a *runnerCovAPI) GetWorkspace(ctx context.Context, workspaceID string) (*WorkspaceInfo, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.workspaceErr != nil {
		return nil, a.workspaceErr
	}
	if a.workspace == nil {
		return &WorkspaceInfo{ID: workspaceID, Status: "running"}, nil
	}
	return a.workspace, nil
}

func (a *runnerCovAPI) ReportStatus(ctx context.Context, sessionID, status string) error {
	a.mu.Lock()
	if a.sessionStatuses == nil {
		a.sessionStatuses = make(map[string][]string)
	}
	a.sessionStatuses[sessionID] = append(a.sessionStatuses[sessionID], status)
	a.mu.Unlock()

	select {
	case a.statusCh <- sessionID + ":" + status:
	default:
	}
	return nil
}

func (a *runnerCovAPI) ExchangeWebRTC(ctx context.Context, sessionID, sdp, iceCandidates string) (*SessionInfo, error) {
	if a.exchangeErr != nil {
		return nil, a.exchangeErr
	}
	if a.exchangeFn != nil {
		return a.exchangeFn(ctx, sessionID, sdp, iceCandidates)
	}
	return &SessionInfo{ID: sessionID}, nil
}

func (a *runnerCovAPI) GetSession(ctx context.Context, sessionID string) (*SessionInfo, error) {
	if a.getSessionFn != nil {
		return a.getSessionFn(ctx, sessionID)
	}
	return &SessionInfo{ID: sessionID}, nil
}

func runnerCovWorkspaceStatuses(a *runnerCovAPI) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.workspaceStatuses...)
}

func runnerCovSessionStatuses(a *runnerCovAPI, sessionID string) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.sessionStatuses[sessionID]...)
}

func runnerCovWaitForStatus(t *testing.T, ch <-chan string, want string) {
	t.Helper()
	require.Eventually(t, func() bool {
		select {
		case got := <-ch:
			return got == want
		default:
			return false
		}
	}, 5*time.Second, 10*time.Millisecond, "waiting for session status %q", want)
}

func runnerCovWaitGroupDone(t *testing.T, wg *sync.WaitGroup) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("background runner functions did not stop")
	}
}

func runnerCovWaitForDataChannelOpen(t *testing.T, dc *webrtc.DataChannel) {
	t.Helper()
	require.Eventually(t, func() bool {
		return dc.ReadyState() == webrtc.DataChannelStateOpen
	}, 5*time.Second, 10*time.Millisecond, "data channel did not open")
}

func runnerCovWaitForDataChannelClosed(t *testing.T, dc *webrtc.DataChannel) {
	t.Helper()
	require.Eventually(t, func() bool {
		return dc.ReadyState() == webrtc.DataChannelStateClosed
	}, 5*time.Second, 10*time.Millisecond, "data channel did not close")
}

func runnerCovWaitForMessage(t *testing.T, messages <-chan string, contains string) {
	t.Helper()
	require.Eventually(t, func() bool {
		for {
			select {
			case msg := <-messages:
				if strings.Contains(msg, contains) {
					return true
				}
			default:
				return false
			}
		}
	}, 5*time.Second, 10*time.Millisecond, "waiting for data channel message containing %q", contains)
}

func runnerCovRecordAsyncError(ch chan<- error, err error) {
	if err == nil {
		return
	}
	select {
	case ch <- err:
	default:
	}
}

func runnerCovRequireNoAsyncError(t *testing.T, ch <-chan error) {
	t.Helper()
	select {
	case err := <-ch:
		require.NoError(t, err)
	default:
	}
}

func runnerCovBuildAnswer(t *testing.T, remote *webrtc.PeerConnection, offerJSON string) webrtc.SessionDescription {
	t.Helper()

	var offer webrtc.SessionDescription
	require.NoError(t, json.Unmarshal([]byte(offerJSON), &offer))
	require.NoError(t, remote.SetRemoteDescription(offer))

	answer, err := remote.CreateAnswer(nil)
	require.NoError(t, err)
	require.NoError(t, remote.SetLocalDescription(answer))

	select {
	case <-webrtc.GatheringCompletePromise(remote):
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for remote ICE gathering")
	}

	local := remote.LocalDescription()
	require.NotNil(t, local)
	return *local
}

func TestRunner_Cov_NewDefaultsAndBackgroundStarter(t *testing.T) {
	t.Parallel()

	r := New(Config{
		WorkspaceID: "ws_cov",
		APIURL:      "http://api.example",
		APIToken:    "token-123",
		IdleTimeout: 42 * time.Second,
	})

	require.NotNil(t, r)
	assert.Equal(t, "ws_cov", r.cfg.WorkspaceID)
	assert.Empty(t, r.sessions)
	assert.Equal(t, 30*time.Second, r.idleCheckInterval)
	assert.Equal(t, 2*time.Second, r.sessionPollInterval)
	assert.Equal(t, 5*time.Second, r.shutdownStatusTimeout)

	apiClient, ok := r.api.(*APIClient)
	require.True(t, ok)
	assert.Equal(t, "http://api.example", apiClient.baseURL)
	assert.Equal(t, "token-123", apiClient.agentToken)

	done := make(chan struct{})
	r.startBackground(func() { close(done) })

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("default background starter did not run callback")
	}
}

func TestRunner_Cov_StartRunsBackgroundLoops(t *testing.T) {
	t.Parallel()

	api := runnerCovNewAPI()
	r := New(Config{WorkspaceID: "ws_cov", IdleTimeout: time.Hour})
	r.api = api
	r.idleCheckInterval = time.Hour
	r.sessionPollInterval = time.Hour

	started := make(chan struct{}, 2)
	var wg sync.WaitGroup
	r.startBackground = func(fn func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started <- struct{}{}
			fn()
		}()
	}

	require.NoError(t, r.Start(context.Background()))
	require.Eventually(t, func() bool { return len(started) == 2 }, time.Second, 10*time.Millisecond)

	r.Stop()
	runnerCovWaitGroupDone(t, &wg)
	assert.Equal(t, []string{"running", "stopped"}, runnerCovWorkspaceStatuses(api))
}

func TestRunner_Cov_StartSessionInitializesAndClosesOnExchangeFailure(t *testing.T) {
	t.Parallel()

	api := runnerCovNewAPI()
	api.exchangeErr = errors.New("signaling unavailable")
	r := New(Config{WorkspaceID: "ws_cov", IdleTimeout: time.Hour})
	r.api = api

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sess := r.startSession(ctx, SessionInfo{ID: "sess_start", Cols: 80, Rows: 24})
	require.NotNil(t, sess)
	assert.Equal(t, "sess_start", sess.ID)
	assert.Same(t, r, sess.runner)

	runnerCovWaitForStatus(t, api.statusCh, "sess_start:stopped")
	assert.Equal(t, []string{"stopped"}, runnerCovSessionStatuses(api, "sess_start"))
}

func TestRunner_Cov_PollForAnswerReturnsOnCanceledContext(t *testing.T) {
	t.Parallel()

	peer, err := runnerTestPeerConnection(webrtc.Configuration{})
	require.NoError(t, err)
	defer func() { require.NoError(t, peer.Close()) }()

	api := runnerCovNewAPI()
	sess := &Session{ID: "sess_cancel", api: api, Peer: peer}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		sess.pollForAnswer(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("pollForAnswer did not return after context cancellation")
	}
}

func TestRunner_Cov_PollForAnswerContinuesAfterGetSessionError(t *testing.T) {
	t.Parallel()

	peer, err := runnerTestPeerConnection(webrtc.Configuration{})
	require.NoError(t, err)
	defer func() { require.NoError(t, peer.Close()) }()

	ctx, cancel := context.WithCancel(context.Background())
	api := runnerCovNewAPI()
	api.getSessionFn = func(context.Context, string) (*SessionInfo, error) {
		cancel()
		return nil, errors.New("temporary API failure")
	}
	sess := &Session{ID: "sess_retry", api: api, Peer: peer}

	done := make(chan struct{})
	go func() {
		sess.pollForAnswer(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("pollForAnswer did not return after canceled retry")
	}
}

func TestRunner_Cov_PollForAnswerSetsRemoteDescription(t *testing.T) {
	t.Parallel()

	local, err := runnerTestPeerConnection(webrtc.Configuration{})
	require.NoError(t, err)
	defer func() { require.NoError(t, local.Close()) }()

	_, err = local.CreateDataChannel("terminal", nil)
	require.NoError(t, err)

	offer, err := local.CreateOffer(nil)
	require.NoError(t, err)
	require.NoError(t, local.SetLocalDescription(offer))

	remote, err := runnerTestPeerConnection(webrtc.Configuration{})
	require.NoError(t, err)
	defer func() { require.NoError(t, remote.Close()) }()

	answer := runnerCovBuildAnswer(t, remote, runnerCovMustJSON(t, offer))
	answerJSON := runnerCovMustJSON(t, answer)

	api := runnerCovNewAPI()
	api.getSessionFn = func(context.Context, string) (*SessionInfo, error) {
		return &SessionInfo{ID: "sess_answer", ClientSDP: answerJSON}, nil
	}
	sess := &Session{ID: "sess_answer", api: api, Peer: local}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		sess.pollForAnswer(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("pollForAnswer did not apply the answer")
	}
	require.NotNil(t, local.RemoteDescription())
	assert.Equal(t, webrtc.SDPTypeAnswer, local.RemoteDescription().Type)
}

func TestRunner_Cov_InitializePanicRecoveryClosesSession(t *testing.T) {
	t.Parallel()

	api := runnerCovNewAPI()
	api.exchangeFn = func(context.Context, string, string, string) (*SessionInfo, error) {
		panic("signaling panic")
	}
	r := New(Config{WorkspaceID: "ws_cov", IdleTimeout: time.Hour})
	r.api = api

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sess := &Session{ID: "sess_panic", api: api, runner: r, cancel: cancel}
	r.mu.Lock()
	r.sessions[sess.ID] = sess
	r.mu.Unlock()

	sess.initialize(ctx, 0, 0)
	runnerCovWaitForStatus(t, api.statusCh, "sess_panic:stopped")

	r.mu.Lock()
	_, exists := r.sessions[sess.ID]
	r.mu.Unlock()
	assert.False(t, exists)
	assert.Equal(t, []string{"stopped"}, runnerCovSessionStatuses(api, sess.ID))
}

func TestRunner_Cov_InitializeConnectsDataChannelAndPTY(t *testing.T) {
	tests := []struct {
		name string
		cols int32
		rows int32
	}{
		{name: "explicit size", cols: 80, rows: 24},
		{name: "default size", cols: 0, rows: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			api := runnerCovNewAPI()
			r := New(Config{WorkspaceID: "ws_cov", IdleTimeout: time.Hour})
			r.api = api

			sess := &Session{ID: "sess_data_" + tt.name, api: api, runner: r, cancel: cancel}
			r.mu.Lock()
			r.sessions[sess.ID] = sess
			r.mu.Unlock()

			remote, err := runnerTestPeerConnection(webrtc.Configuration{})
			require.NoError(t, err)
			defer func() { require.NoError(t, remote.Close()) }()

			var candidateMu sync.Mutex
			var pendingLocalCandidates []webrtc.ICECandidateInit
			asyncErrs := make(chan error, 8)
			api.exchangeFn = func(ctx context.Context, sessionID, sdp, iceCandidates string) (*SessionInfo, error) {
				if iceCandidates != "" {
					var candidate webrtc.ICECandidateInit
					if err := json.Unmarshal([]byte(iceCandidates), &candidate); err != nil {
						runnerCovRecordAsyncError(asyncErrs, err)
						return &SessionInfo{ID: sessionID}, nil
					}
					candidateMu.Lock()
					if remote.RemoteDescription() == nil {
						pendingLocalCandidates = append(pendingLocalCandidates, candidate)
					} else {
						runnerCovRecordAsyncError(asyncErrs, remote.AddICECandidate(candidate))
					}
					candidateMu.Unlock()
				}
				if sdp != "" {
					answer := runnerCovBuildAnswer(t, remote, sdp)
					candidateMu.Lock()
					for _, candidate := range pendingLocalCandidates {
						require.NoError(t, remote.AddICECandidate(candidate))
					}
					pendingLocalCandidates = nil
					candidateMu.Unlock()
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

			sess.initialize(ctx, tt.cols, tt.rows)
			defer sess.Close()
			require.NotNil(t, sess.Peer)
			require.NotNil(t, sess.DataChan)

			var remoteDC *webrtc.DataChannel
			select {
			case remoteDC = <-dataChannels:
			case <-time.After(5 * time.Second):
				t.Fatal("remote peer did not receive data channel")
			}

			messages := make(chan string, 16)
			remoteDC.OnMessage(func(msg webrtc.DataChannelMessage) {
				messages <- string(msg.Data)
			})
			runnerCovWaitForDataChannelOpen(t, remoteDC)
			runnerCovWaitForStatus(t, api.statusCh, sess.ID+":running")
			require.NotNil(t, sess.PtyFile)
			require.NotNil(t, sess.Cmd)

			require.NoError(t, remoteDC.SendText(`{"type":"resize","cols":81,"rows":25}`))
			require.NoError(t, remoteDC.Send([]byte("echo wsrunner_cov\n")))
			runnerCovWaitForMessage(t, messages, "wsrunner_cov")
			runnerCovRequireNoAsyncError(t, asyncErrs)

			if tt.cols > 0 {
				require.NoError(t, remoteDC.Send([]byte("sleep 0.2; echo after_remote_close\n")))
				require.NoError(t, remoteDC.Close())
				runnerCovWaitForDataChannelClosed(t, remoteDC)
				time.Sleep(500 * time.Millisecond)
				sess.Close()
			} else {
				require.NoError(t, sess.Cmd.Process.Kill())
				runnerCovWaitForStatus(t, api.statusCh, sess.ID+":stopped")
			}
			assert.Contains(t, runnerCovSessionStatuses(api, sess.ID), "stopped")
		})
	}
}

func TestRunner_Cov_CloseClosesPTYAndKillsCommand(t *testing.T) {
	t.Parallel()

	api := runnerCovNewAPI()
	r := New(Config{WorkspaceID: "ws_cov", IdleTimeout: time.Hour})
	r.api = api

	tmp, err := os.CreateTemp(t.TempDir(), "pty-like-*")
	require.NoError(t, err)

	cmd := exec.Command("sh", "-c", "sleep 30")
	require.NoError(t, cmd.Start())

	sess := &Session{ID: "sess_close", api: api, runner: r, PtyFile: tmp, Cmd: cmd}
	r.mu.Lock()
	r.sessions[sess.ID] = sess
	r.mu.Unlock()

	sess.Close()

	_, writeErr := tmp.Write([]byte("closed"))
	require.Error(t, writeErr)

	waitErr := cmd.Wait()
	require.Error(t, waitErr)

	r.mu.Lock()
	_, exists := r.sessions[sess.ID]
	r.mu.Unlock()
	assert.False(t, exists)
	assert.Equal(t, []string{"stopped"}, runnerCovSessionStatuses(api, sess.ID))
}

func runnerCovMustJSON(t *testing.T, value interface{}) string {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	return string(raw)
}
