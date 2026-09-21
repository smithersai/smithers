package wsrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/creack/pty"
	"github.com/pion/webrtc/v4"
)

// Config holds the configuration for the Workspace Runner.
type Config struct {
	WorkspaceID string
	APIURL      string
	APIToken    string
	IdleTimeout time.Duration
}

type runnerAPI interface {
	ReportWorkspaceStatus(ctx context.Context, workspaceID string, status string) error
	GetWorkspace(ctx context.Context, workspaceID string) (*WorkspaceInfo, error)
	ReportStatus(ctx context.Context, sessionID string, status string) error
	ExchangeWebRTC(ctx context.Context, sessionID, sdp, iceCandidates string) (*SessionInfo, error)
	GetSession(ctx context.Context, sessionID string) (*SessionInfo, error)
}

var (
	newPeerConnection   = webrtc.NewPeerConnection
	createDataChannel   = (*webrtc.PeerConnection).CreateDataChannel
	createOffer         = (*webrtc.PeerConnection).CreateOffer
	setLocalDescription = (*webrtc.PeerConnection).SetLocalDescription
	startPTY            = pty.Start
	startPTYWithSize    = pty.StartWithSize
	setPTYSize          = pty.Setsize
)

// Runner manages the WebRTC connections and idle tracking for the pod.
type Runner struct {
	cfg                   Config
	api                   runnerAPI
	mu                    sync.Mutex
	sessions              map[string]*Session
	lastActive            atomic.Int64 // Unix timestamp of last activity across all sessions
	cancel                context.CancelFunc
	stopOnce              sync.Once
	startBackground       func(func())
	startSessionFn        func(context.Context, SessionInfo) *Session
	exit                  func(int)
	idleCheckInterval     time.Duration
	sessionPollInterval   time.Duration
	shutdownStatusTimeout time.Duration
}

// New returns a new workspace Runner.
func New(cfg Config) *Runner {
	r := &Runner{
		cfg:                   cfg,
		api:                   NewAPIClient(cfg.APIURL, cfg.APIToken),
		sessions:              make(map[string]*Session),
		startBackground:       func(fn func()) { go fn() },
		exit:                  os.Exit,
		idleCheckInterval:     30 * time.Second,
		sessionPollInterval:   2 * time.Second,
		shutdownStatusTimeout: 5 * time.Second,
	}
	r.startSessionFn = r.startSession
	return r
}

// Start begins tracking idle time and polling/listening for sessions.
func (r *Runner) Start(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	r.cancel = cancel

	r.touchActivity()

	// 1. Mark pod as running
	if err := r.api.ReportWorkspaceStatus(ctx, r.cfg.WorkspaceID, "running"); err != nil {
		cancel()
		return fmt.Errorf("failed to report workspace running: %w", err)
	}

	// 2. Start idle tracker
	r.startBackground(func() {
		r.runIdleTracker(ctx)
	})

	// 3. Connect to SSE to listen for new sessions or signals
	// For now, in a simplified implementation, we poll the active sessions API or wait for SSE.
	// Since SSE multiplexes everything, we'll just poll occasionally in this prototype,
	// or listen to the SSE stream if implemented.
	r.startBackground(func() {
		r.runSessionPoller(ctx)
	})

	return nil
}

// Stop gracefully shuts down the runner and all sessions.
func (r *Runner) Stop() {
	r.stopOnce.Do(func() {
		if r.cancel != nil {
			r.cancel()
		}

		r.mu.Lock()
		sessions := make([]*Session, 0, len(r.sessions))
		for id, sess := range r.sessions {
			sessions = append(sessions, sess)
			delete(r.sessions, id)
		}
		r.mu.Unlock()

		for _, sess := range sessions {
			sess.Close()
		}

		ctx, cancel := context.WithTimeout(context.Background(), r.shutdownStatusTimeout)
		defer cancel()
		_ = r.api.ReportWorkspaceStatus(ctx, r.cfg.WorkspaceID, "stopped")
	})
}

func (r *Runner) touchActivity() {
	r.lastActive.Store(time.Now().Unix())
}

func (r *Runner) runIdleTracker(ctx context.Context) {
	ticker := time.NewTicker(r.idleCheckInterval)
	defer ticker.Stop()
	r.idleTracker(ctx, ticker.C)
}

func (r *Runner) idleTracker(ctx context.Context, ticks <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			last := time.Unix(r.lastActive.Load(), 0)
			if time.Since(last) > r.cfg.IdleTimeout {
				slog.Info("workspace runner idle timeout reached", "workspace_id", r.cfg.WorkspaceID, "idle_timeout", r.cfg.IdleTimeout)
				r.Stop()
				r.exit(0)
				return
			}
		}
	}
}

func (r *Runner) runSessionPoller(ctx context.Context) {
	ticker := time.NewTicker(r.sessionPollInterval)
	defer ticker.Stop()
	r.sessionPoller(ctx, ticker.C)
}

func (r *Runner) sessionPoller(ctx context.Context, ticks <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			ws, err := r.api.GetWorkspace(ctx, r.cfg.WorkspaceID)
			if err != nil {
				slog.Warn("failed to get workspace", "workspace_id", r.cfg.WorkspaceID, "error", err)
				continue
			}

			for _, pending := range ws.PendingSessions {
				r.mu.Lock()
				if ctx.Err() != nil {
					// Stop already drained the session map; do not insert a
					// session that would never be closed.
					r.mu.Unlock()
					return
				}
				if _, exists := r.sessions[pending.ID]; !exists {
					slog.Info("found new pending workspace session", "workspace_id", r.cfg.WorkspaceID, "session_id", pending.ID)
					sess := r.startSessionFn(ctx, pending)
					r.sessions[pending.ID] = sess
				}
				r.mu.Unlock()
			}
		}
	}
}

// Session represents a single terminal connection (PTY + WebRTC)
//
// Issue #128: PtyFile/Cmd are assigned from the pion OnOpen callback goroutine
// and Peer/DataChan are assigned from the initialize goroutine, while Close
// and OnMessage read/close them concurrently from other goroutines. mu
// guards all of that field access; closed (checked/set under mu) lets a
// publish that races with Close tear down the just-created resource instead
// of leaking it (e.g. a PTY started after Close already ran).
type Session struct {
	ID     string
	api    runnerAPI
	runner *Runner
	cancel context.CancelFunc

	mu        sync.Mutex
	closed    bool
	PtyFile   *os.File
	Cmd       *exec.Cmd
	Peer      *webrtc.PeerConnection
	DataChan  *webrtc.DataChannel
	closeOnce sync.Once
}

// publish runs assign() and stores its result under the session lock, unless
// the session has already been closed. It returns false if the session was
// already closed, in which case the caller must tear down any resource it
// just created (assign must not itself do so, since assign runs under lock).
func (s *Session) publish(assign func()) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	assign()
	return true
}

// ptyFile returns the session's current PTY file handle (nil if not yet
// started, or if the session has been closed), for safe concurrent reads
// from OnMessage.
func (s *Session) ptyFile() *os.File {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.PtyFile
}

func (r *Runner) startSession(ctx context.Context, pending SessionInfo) *Session {
	ctx, cancel := context.WithCancel(ctx)

	s := &Session{
		ID:     pending.ID,
		api:    r.api,
		runner: r,
		cancel: cancel,
	}

	go s.initialize(ctx, pending.Cols, pending.Rows)
	return s
}

func (s *Session) initialize(ctx context.Context, cols, rows int32) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("workspace session panicked", "session_id", s.ID, "panic", r)
			s.Close()
		}
	}()

	// 1. Create WebRTC PeerConnection
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302"},
			},
		},
	}

	peer, err := newPeerConnection(config)
	if err != nil {
		slog.Error("failed to create workspace peer connection", "session_id", s.ID, "error", err)
		s.Close()
		return
	}
	if !s.publish(func() { s.Peer = peer }) {
		// Close already ran (e.g. a concurrent Stop()/Close()) before we could
		// publish; tear down the peer connection we just created ourselves,
		// since Close() ran without knowledge of it.
		_ = peer.Close()
		return
	}

	// Track ICE candidates to send to API
	peer.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cJSON, _ := json.Marshal(c.ToJSON())
		// In a real implementation we'd batch these or append, but for simplicity
		// we just send the latest one. A better approach is to collect them until gathering is complete.
		_, _ = s.api.ExchangeWebRTC(ctx, s.ID, "", string(cJSON))
	})

	// Create Data Channel for terminal
	ordered := true
	dataChannel, err := createDataChannel(peer, "terminal", &webrtc.DataChannelInit{
		Ordered: &ordered,
	})
	if err != nil {
		slog.Error("failed to create workspace data channel", "session_id", s.ID, "error", err)
		s.Close()
		return
	}
	if !s.publish(func() { s.DataChan = dataChannel }) {
		_ = dataChannel.Close()
		return
	}

	// Handle Data Channel Open
	dataChannel.OnOpen(func() {
		slog.Info("workspace data channel opened", "session_id", s.ID)

		// Create PTY
		cmd := exec.Command("/bin/sh") // In production would use user's shell e.g bash or zsh
		cmd.Env = append(os.Environ(), "TERM=xterm-256color")

		// Use a callback-local error variable; writing the enclosing
		// initialize() err from this asynchronous callback is a data race.
		var ptyFile *os.File
		var ptyErr error
		if cols > 0 && rows > 0 {
			ptyFile, ptyErr = startPTYWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
		} else {
			ptyFile, ptyErr = startPTY(cmd)
		}

		if ptyErr != nil {
			slog.Error("failed to start workspace pty", "session_id", s.ID, "error", ptyErr)
			return
		}

		if !s.publish(func() {
			s.PtyFile = ptyFile
			s.Cmd = cmd
		}) {
			// Close already ran while we were starting the PTY; tear down the
			// process and file we just created ourselves instead of leaking
			// them (issue #128).
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			_ = ptyFile.Close()
			return
		}

		_ = s.api.ReportStatus(ctx, s.ID, "running")

		// Read from PTY and send to WebRTC.
		go s.pumpPTY(ptyFile, func(b []byte) error { return dataChannel.Send(b) })
	})

	// Handle Data Channel Messages (Input from browser)
	dataChannel.OnMessage(func(msg webrtc.DataChannelMessage) {
		s.runner.touchActivity()

		// Msg could be keystrokes or a resize command.
		// For simplicity, we assume pure binary is keystrokes, and string is JSON command.
		if msg.IsString {
			var cmd struct {
				Type string `json:"type"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if err := json.Unmarshal(msg.Data, &cmd); err == nil && cmd.Type == "resize" {
				if pf := s.ptyFile(); pf != nil {
					_ = setPTYSize(pf, &pty.Winsize{Cols: cmd.Cols, Rows: cmd.Rows})
				}
			}
		} else {
			if pf := s.ptyFile(); pf != nil {
				_, _ = pf.Write(msg.Data)
			}
		}
	})

	// Create Offer
	offer, err := createOffer(peer, nil)
	if err != nil {
		slog.Error("failed to create workspace offer", "session_id", s.ID, "error", err)
		s.Close()
		return
	}

	if err := setLocalDescription(peer, offer); err != nil {
		slog.Error("failed to set workspace local description", "session_id", s.ID, "error", err)
		s.Close()
		return
	}

	// Send Offer to API
	offerJSON, _ := json.Marshal(offer)
	_, err = s.api.ExchangeWebRTC(ctx, s.ID, string(offerJSON), "")
	if err != nil {
		slog.Error("failed to exchange workspace offer", "session_id", s.ID, "error", err)
		s.Close()
		return
	}

	// In a complete implementation we would need to poll or listen via SSE for the Client's Answer
	// and set it via RemoteDescription.
	go s.pollForAnswer(ctx)
}

func (s *Session) pollForAnswer(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Fetch session info
			sessInfo, err := s.api.GetSession(ctx, s.ID)
			if err != nil {
				continue
			}

			if sessInfo.ClientSDP != "" && s.Peer.RemoteDescription() == nil {
				var answer webrtc.SessionDescription
				if err := json.Unmarshal([]byte(sessInfo.ClientSDP), &answer); err == nil {
					if err := s.Peer.SetRemoteDescription(answer); err == nil {
						slog.Info("workspace remote description set", "session_id", s.ID)
						return
					}
				}
			}

			// TODO: parse and add ICE candidates when full signaling is implemented
		}
	}
}

// Close terminates the PTY and WebRTC connection.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		// Mark closed and snapshot the fields to close under the lock, then
		// perform the actual closes/kill outside the lock (issue #128): this
		// avoids holding s.mu across the API call and runner.mu acquisition
		// below, while guaranteeing any publish() racing with this Close sees
		// s.closed and tears down its own just-created resource instead of
		// us reading a half-published field.
		s.mu.Lock()
		s.closed = true
		ptyFile := s.PtyFile
		cmd := s.Cmd
		peer := s.Peer
		s.mu.Unlock()

		if s.cancel != nil {
			s.cancel()
		}
		if ptyFile != nil {
			_ = ptyFile.Close()
		}
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		if peer != nil {
			_ = peer.Close()
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.api.ReportStatus(ctx, s.ID, "stopped")

		if s.runner != nil {
			s.runner.mu.Lock()
			delete(s.runner.sessions, s.ID)
			s.runner.mu.Unlock()
		}
	})
}

// pumpPTY reads from ptyFile and forwards each chunk via send until either
// the read or the send fails, closing the session in both cases. Issue #18:
// the send-error branch previously returned without calling s.Close(),
// leaking the session (PTY process, peer connection, and runner.sessions
// entry) whenever the WebRTC data channel send failed.
func (s *Session) pumpPTY(ptyFile io.Reader, send func([]byte) error) {
	buf := make([]byte, 4096)
	for {
		n, err := ptyFile.Read(buf)
		if err != nil {
			if err != io.EOF {
				slog.Warn("workspace pty read error", "session_id", s.ID, "error", err)
			}
			s.Close()
			return
		}
		s.runner.touchActivity()
		if err := send(buf[:n]); err != nil {
			slog.Warn("workspace webrtc send error", "session_id", s.ID, "error", err)
			s.Close()
			return
		}
	}
}
