package wsrunner

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeRunnerAPI struct {
	mu sync.Mutex

	workspaceStatuses []string
	sessionStatuses   map[string][]string

	workspace    *WorkspaceInfo
	workspaceErr error
	statusErr    error
	exchangeErr  error
}

func newFakeRunnerAPI() *fakeRunnerAPI {
	return &fakeRunnerAPI{sessionStatuses: make(map[string][]string)}
}

func (f *fakeRunnerAPI) ReportWorkspaceStatus(ctx context.Context, workspaceID, status string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.workspaceStatuses = append(f.workspaceStatuses, status)
	return f.statusErr
}

func (f *fakeRunnerAPI) GetWorkspace(ctx context.Context, workspaceID string) (*WorkspaceInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.workspaceErr != nil {
		return nil, f.workspaceErr
	}
	return f.workspace, nil
}

func (f *fakeRunnerAPI) ReportStatus(ctx context.Context, sessionID, status string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessionStatuses[sessionID] = append(f.sessionStatuses[sessionID], status)
	return nil
}

func (f *fakeRunnerAPI) ExchangeWebRTC(ctx context.Context, sessionID, sdp, iceCandidates string) (*SessionInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.exchangeErr != nil {
		return nil, f.exchangeErr
	}
	return &SessionInfo{ID: sessionID}, nil
}

func (f *fakeRunnerAPI) GetSession(ctx context.Context, sessionID string) (*SessionInfo, error) {
	return &SessionInfo{ID: sessionID}, nil
}

func (f *fakeRunnerAPI) recordedWorkspaceStatuses() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.workspaceStatuses...)
}

func newTestRunner(api runnerAPI) *Runner {
	r := New(Config{WorkspaceID: "ws_test", IdleTimeout: time.Hour})
	r.api = api
	r.startBackground = func(fn func()) {} // background loops driven manually in tests
	r.exit = func(int) {}
	return r
}

func TestRunner_Start_ReportsRunning(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)

	require.NoError(t, r.Start(context.Background()))
	defer r.Stop()

	assert.Equal(t, []string{"running"}, api.recordedWorkspaceStatuses())
}

func TestRunner_Start_FailsWhenStatusReportFails(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	api.statusErr = errors.New("api down")
	r := newTestRunner(api)

	err := r.Start(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to report workspace running")
}

func TestRunner_Stop_ReportsStoppedOnce(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)
	require.NoError(t, r.Start(context.Background()))

	r.Stop()
	r.Stop() // idempotent

	assert.Equal(t, []string{"running", "stopped"}, api.recordedWorkspaceStatuses())
}

func TestRunner_IdleTracker_ExitsAfterTimeout(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)
	r.cfg.IdleTimeout = time.Nanosecond

	exitCode := -1
	r.exit = func(code int) { exitCode = code }

	require.NoError(t, r.Start(context.Background()))

	// Backdate last activity so the next tick sees an expired idle window.
	r.lastActive.Store(time.Now().Add(-time.Minute).Unix())

	ticks := make(chan time.Time, 1)
	ticks <- time.Now()
	r.idleTracker(context.Background(), ticks)

	assert.Equal(t, 0, exitCode)
	assert.Equal(t, []string{"running", "stopped"}, api.recordedWorkspaceStatuses())
}

func TestRunner_IdleTracker_StaysAliveWhileActive(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)
	r.cfg.IdleTimeout = time.Hour

	exited := false
	r.exit = func(int) { exited = true }
	r.touchActivity()

	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time, 1)
	ticks <- time.Now()

	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	r.idleTracker(ctx, ticks)

	assert.False(t, exited, "active runner must not exit")
}

func TestRunner_SessionPoller_StartsNewSessionsOnce(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	api.workspace = &WorkspaceInfo{
		ID:     "ws_test",
		Status: "running",
		PendingSessions: []SessionInfo{
			{ID: "sess_a"},
			{ID: "sess_b"},
		},
	}

	r := newTestRunner(api)

	var started []string
	r.startSessionFn = func(ctx context.Context, pending SessionInfo) *Session {
		started = append(started, pending.ID)
		return &Session{ID: pending.ID, api: api, runner: r}
	}

	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time, 2)
	ticks <- time.Now()
	ticks <- time.Now() // second poll sees the same pending sessions

	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	r.sessionPoller(ctx, ticks)

	assert.Equal(t, []string{"sess_a", "sess_b"}, started, "each pending session starts exactly once")

	r.mu.Lock()
	assert.Len(t, r.sessions, 2)
	r.mu.Unlock()
}

func TestRunner_SessionPoller_ToleratesAPIErrors(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	api.workspaceErr = errors.New("transient failure")

	r := newTestRunner(api)
	r.startSessionFn = func(ctx context.Context, pending SessionInfo) *Session {
		t.Error("no session should start when GetWorkspace fails")
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time, 1)
	ticks <- time.Now()

	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	r.sessionPoller(ctx, ticks)

	r.mu.Lock()
	assert.Empty(t, r.sessions)
	r.mu.Unlock()
}

// After Stop drained the session map, a racing poller tick must not insert a
// new session that would never be closed.
func TestRunner_SessionPoller_DoesNotInsertAfterStop(t *testing.T) {
	t.Parallel()

	for i := 0; i < 20; i++ {
		api := newFakeRunnerAPI()
		api.workspace = &WorkspaceInfo{
			ID:              "ws_test",
			Status:          "running",
			PendingSessions: []SessionInfo{{ID: "sess_late"}},
		}

		r := newTestRunner(api)
		require.NoError(t, r.Start(context.Background()))
		ctx, cancel := context.WithCancel(context.Background())
		r.startSessionFn = func(ctx context.Context, pending SessionInfo) *Session {
			return &Session{ID: pending.ID, api: api, runner: r}
		}

		// Simulate Stop racing a poll tick: ctx cancelled with a tick queued.
		cancel()
		r.Stop()
		ticks := make(chan time.Time, 1)
		ticks <- time.Now()
		r.sessionPoller(ctx, ticks)

		r.mu.Lock()
		leaked := len(r.sessions)
		r.mu.Unlock()
		require.Zero(t, leaked, "poller inserted a session after Stop")
	}
}

// Every initialize error path must close the session so it is removed from
// the runner's map and the poller can retry it.
func TestSession_Initialize_ExchangeFailureClosesSession(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	api.exchangeErr = errors.New("signaling down")
	r := newTestRunner(api)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sess := &Session{ID: "sess_fail", api: api, runner: r, cancel: cancel}
	r.mu.Lock()
	r.sessions["sess_fail"] = sess
	r.mu.Unlock()

	sess.initialize(ctx, 0, 0)

	r.mu.Lock()
	_, exists := r.sessions["sess_fail"]
	r.mu.Unlock()
	assert.False(t, exists, "failed session must be deregistered so the poller retries")

	api.mu.Lock()
	statuses := append([]string(nil), api.sessionStatuses["sess_fail"]...)
	api.mu.Unlock()
	assert.Equal(t, []string{"stopped"}, statuses)
}

func TestSession_Close_ReportsStoppedAndDeregisters(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)

	sess := &Session{ID: "sess_x", api: api, runner: r}
	r.mu.Lock()
	r.sessions["sess_x"] = sess
	r.mu.Unlock()

	sess.Close()
	sess.Close() // idempotent

	api.mu.Lock()
	assert.Equal(t, []string{"stopped"}, api.sessionStatuses["sess_x"])
	api.mu.Unlock()

	r.mu.Lock()
	assert.NotContains(t, r.sessions, "sess_x")
	r.mu.Unlock()
}

func TestRunner_Stop_ClosesTrackedSessions(t *testing.T) {
	t.Parallel()

	api := newFakeRunnerAPI()
	r := newTestRunner(api)
	require.NoError(t, r.Start(context.Background()))

	sess := &Session{ID: "sess_y", api: api, runner: r}
	r.mu.Lock()
	r.sessions["sess_y"] = sess
	r.mu.Unlock()

	r.Stop()

	api.mu.Lock()
	assert.Equal(t, []string{"stopped"}, api.sessionStatuses["sess_y"])
	api.mu.Unlock()
}
