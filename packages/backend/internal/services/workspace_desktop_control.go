package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// Desktop observe and input: the seam that lets an agent SEE a kind=desktop
// box and DRIVE it. Both routes run one guest helper under one flock, so a
// plan and the observation that follows it describe the same screen.
//
// SECURITY. /desktop/input is root code execution inside the box: the
// `developer` user has passwordless sudo and its login shell carries the
// repository's git credential. The screen text and the JPEG this file returns
// are attacker-controlled: a page the box visited chose those bytes, and a
// consumer that treats them as instructions has handed the page the agent.
// The controls are write-scope auth, the consumer's grant policy, the
// focus_terminal guard, and the audit row. Never route a secret through here.
//
// NO USER BYTE EVER REACHES A SHELL. The provider's exec API takes a shell
// string, not argv, so the plan travels as JSON written with WriteFile and is
// read by a guest helper; the command strings built here vary only in
// integers, a 16-hex nonce and a validated UUID, which
// TestInputDesktop_HostileTypeTextCannotReachAShell and
// TestObserveDesktopCommandShapeIsFixed assert byte for byte.

const (
	// The helpers ship in the system profile, which the image bakes into
	// /usr/local/bin so exec works before NixOS activation links
	// /run/current-system. Both paths are tried, exactly as the password
	// rotation shim does.
	desktopObserveHelper = "smithers-desktop-observe"
	desktopInputHelper   = "smithers-desktop-input"
	desktopPlanDir       = "/run/smithers-desktop/agent"

	// Exit codes the helpers use. The map from code to HTTP status is the
	// guest contract in docs/specs/workspaces.md; keep them in sync.
	desktopExitImageTooLarge = 47
	desktopExitBadPlan       = 64
	desktopExitOutOfBounds   = 65
	desktopExitFrameChanged  = 66
	desktopExitFocusTerminal = 67
	desktopExitNotActivated  = 69
	desktopExitToolFailure   = 70
	desktopExitBusy          = 75
	desktopExitActRepeated   = 76
	desktopExitMissing       = 127

	// Image bounds. The upper bound is the framebuffer's own width, and the
	// lower one is the smallest capture an agent can still read UI text in.
	minDesktopImageWidth        = 320
	maxDesktopImageWidth        = 1920
	defaultDesktopImageMaxWidth = 1280
	minDesktopImageQuality      = 30
	maxDesktopImageQuality      = 85
	defaultDesktopImageQuality  = 60
	// The decoded JPEG ceiling, the same 1 MiB the workspace file reader uses:
	// it travels the same way, base64 over exec stdout.
	maxDesktopImageBytes = MaxWorkspaceFileBytes

	// Response caps. A window list is for orientation, not for inventory.
	maxDesktopWindows     = 20
	maxDesktopWindowTitle = 120
	maxDesktopWindowClass = 40
	maxDesktopText        = 2048

	// Exec budgets. Both leave 1500 ms of the request deadline for the
	// round trip and the response, and both floor at 3 s so a nearly expired
	// deadline produces a clean 504 rather than a truncated capture.
	desktopObserveExecCeilingMS = 15000
	desktopInputExecCeilingMS   = 20000
	desktopExecDeadlineMarginMS = 1500
	desktopExecFloorMS          = 3000
	desktopPlanWriteTimeout     = 5 * time.Second
	desktopAuditTimeout         = 5 * time.Second
)

// DesktopFrame is the Xvnc framebuffer geometry. It is not a constant: the
// viewer connects with resize=remote and Xvnc runs with
// -AcceptSetDesktopSize=1 (nix/modules/desktop.nix), so opening the box in a
// browser window of another shape changes it.
type DesktopFrame struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// DesktopPointer is the pointer position in framebuffer pixels.
type DesktopPointer struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// DesktopWindow describes one mapped top-level window.
type DesktopWindow struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Class  string `json:"class"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Width  int    `json:"w"`
	Height int    `json:"h"`
}

// DesktopWindowEntry is a window in the list, which also says whether it holds
// the input focus.
type DesktopWindowEntry struct {
	DesktopWindow
	Focused bool `json:"focused"`
}

// DesktopImage is a JPEG capture of the whole framebuffer.
type DesktopImage struct {
	ContentType string `json:"content_type"`
	Encoding    string `json:"encoding"`
	// Image is base64; Bytes is the DECODED size.
	Image       string  `json:"image"`
	Bytes       int     `json:"bytes"`
	ImageWidth  int     `json:"image_width"`
	ImageHeight int     `json:"image_height"`
	Scale       float64 `json:"scale"`
}

// DesktopImageRequest asks for a capture. Absent means no capture at all:
// most agent turns need the window list and the focused tab's text, and a
// JPEG is two orders of magnitude more bytes than either.
type DesktopImageRequest struct {
	MaxWidth *int `json:"max_width"`
	Quality  *int `json:"quality"`
}

// DesktopObserveRequest is the /desktop/observe body, and the `observe` field
// of an /desktop/input body.
type DesktopObserveRequest struct {
	Text  *bool                `json:"text"`
	Image *DesktopImageRequest `json:"image"`
}

// DesktopObservation is one atomic read of the box's screen.
type DesktopObservation struct {
	WorkspaceID string               `json:"workspace_id"`
	CapturedAt  time.Time            `json:"captured_at"`
	Frame       DesktopFrame         `json:"frame"`
	Pointer     DesktopPointer       `json:"pointer"`
	Focused     *DesktopWindow       `json:"focused"`
	Windows     []DesktopWindowEntry `json:"windows"`
	// Text is the focused Chrome tab's document text, read over CDP on
	// loopback. UNTRUSTED: a page chose these bytes.
	Text       *string       `json:"text"`
	TextSource *string       `json:"text_source"`
	Image      *DesktopImage `json:"image"`
}

// DesktopInputError is a non-fatal failure of the post-plan observation: the
// plan itself ran.
type DesktopInputError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// DesktopInputResponse reports what ran. It is NOT idempotent beyond the
// guest's act_id ledger: a 5xx says nothing about whether the plan executed,
// so a client observes rather than retries.
type DesktopInputResponse struct {
	WorkspaceID  string              `json:"workspace_id"`
	ActID        string              `json:"act_id"`
	Completed    int                 `json:"completed"`
	Frame        DesktopFrame        `json:"frame"`
	CompletedAt  time.Time           `json:"completed_at"`
	Observation  *DesktopObservation `json:"observation"`
	ObserveError *DesktopInputError  `json:"observe_error"`
}

// desktopFrameChangedDetails is the 409 frame_changed payload.
type desktopFrameChangedDetails struct {
	Frame       DesktopFrame        `json:"frame"`
	Observation *DesktopObservation `json:"observation"`
}

// desktopOutOfBoundsDetails is the 422 desktop_input_out_of_bounds payload.
type desktopOutOfBoundsDetails struct {
	Width     int `json:"width"`
	Height    int `json:"height"`
	Index     int `json:"index"`
	Completed int `json:"completed"`
}

// workspaceDesktopAuditRecorder is the optional audit surface (generated sqlc
// has it; test fakes need not).
type workspaceDesktopAuditRecorder interface {
	InsertAuditLog(ctx context.Context, arg db.InsertAuditLogParams) error
}

// desktopLocks serializes observe/input per workspace WITHIN this API pod. It
// fails instead of queueing: a caller blocked behind another agent's plan
// would spend its whole 30 s budget waiting to act on a screen that is being
// changed underneath it. Across pods the guest's flock is the arbiter, and it
// reports the same verdict (exit 75).
var desktopLocks sync.Map // workspace id -> struct{}

func acquireDesktopLock(workspaceID string) (release func(), ok bool) {
	if _, loaded := desktopLocks.LoadOrStore(workspaceID, struct{}{}); loaded {
		return nil, false
	}
	return func() { desktopLocks.Delete(workspaceID) }, true
}

// ObserveDesktop reads the box's screen: geometry, pointer, window list, the
// focused Chrome tab's text, and optionally a JPEG.
func (s *WorkspaceService) ObserveDesktop(ctx context.Context, workspaceID string, repositoryID, userID int64, request DesktopObserveRequest) (DesktopObservation, error) {
	observe, err := resolveDesktopGuestObserve(&request)
	if err != nil {
		return DesktopObservation{}, err
	}
	s.applyDesktopObserveTextSwitch(observe)
	workspace, client, err := s.desktopControlTarget(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return DesktopObservation{}, err
	}
	release, ok := acquireDesktopLock(workspace.ID)
	if !ok {
		return DesktopObservation{}, pkgerrors.DesktopBusy("this box is busy with another desktop action")
	}
	defer release()

	command := desktopObserveCommand(*observe)
	result, execErr := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{
		Command:   command,
		TimeoutMS: desktopExecTimeoutMS(ctx, desktopObserveExecCeilingMS),
	})
	if execErr != nil {
		return DesktopObservation{}, s.desktopTransportError(ctx, workspace, execErr)
	}
	if err := desktopExitError(result); err != nil {
		return DesktopObservation{}, err
	}
	observation, err := parseDesktopObservation(workspace.ID, result.Stdout)
	if err != nil {
		return DesktopObservation{}, err
	}
	s.finishDesktopControl(ctx, workspace, "workspace.desktop.observe", map[string]any{
		"workspace_id":  workspace.ID,
		"repository_id": workspace.RepositoryID,
		"vm_id":         workspace.VmID,
		"frame":         observation.Frame,
		"image_width":   desktopImageWidth(observation.Image),
		"image_height":  desktopImageHeight(observation.Image),
		"bytes":         desktopImageBytes(observation.Image),
	}, userID)
	return observation, nil
}

// InputDesktop validates a plan, writes it into the guest, and runs it under
// the guest lock. The plan is fully judged here before any byte leaves the
// API; the guest re-checks coordinates against live geometry action by action,
// because the human sharing the screen can move a window mid-plan.
func (s *WorkspaceService) InputDesktop(ctx context.Context, workspaceID string, repositoryID, userID int64, request DesktopInputRequest) (DesktopInputResponse, error) {
	plan, auditActions, err := validateDesktopPlan(request)
	if err != nil {
		return DesktopInputResponse{}, err
	}
	s.applyDesktopObserveTextSwitch(plan.Observe)
	workspace, client, err := s.desktopControlTarget(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return DesktopInputResponse{}, err
	}
	release, ok := acquireDesktopLock(workspace.ID)
	if !ok {
		return DesktopInputResponse{}, pkgerrors.DesktopBusy("this box is busy with another desktop action")
	}
	defer release()

	encoded, marshalErr := json.Marshal(plan)
	if marshalErr != nil {
		return DesktopInputResponse{}, pkgerrors.Internal("encode desktop plan: " + marshalErr.Error())
	}
	nonce := randomHex(8)
	planPath := desktopPlanDir + "/plan-" + nonce + ".json"
	writeCtx, cancelWrite := context.WithTimeout(ctx, desktopPlanWriteTimeout)
	writeErr := client.WriteFile(writeCtx, workspace.VmID, planPath, sandbox.WriteFileRequest{Content: string(encoded)})
	cancelWrite()
	if writeErr != nil {
		return DesktopInputResponse{}, s.desktopTransportError(ctx, workspace, writeErr)
	}

	result, execErr := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{
		Command:   desktopInputCommand(nonce, plan.ActID),
		TimeoutMS: desktopExecTimeoutMS(ctx, desktopInputExecCeilingMS),
	})
	if execErr != nil {
		return DesktopInputResponse{}, s.desktopTransportError(ctx, workspace, execErr)
	}
	// A guarded refusal still prints geometry, the completed count and a
	// failure payload, so the caller learns what the screen looks like now.
	guest, parseErr := parseDesktopInputOutput(workspace.ID, result.Stdout)
	if err := desktopExitError(result); err != nil {
		return DesktopInputResponse{}, decorateDesktopInputError(err, guest, parseErr)
	}
	if parseErr != nil {
		return DesktopInputResponse{}, parseErr
	}

	response := DesktopInputResponse{
		WorkspaceID: workspace.ID,
		ActID:       plan.ActID,
		Completed:   guest.completed,
		Frame:       guest.frame,
		CompletedAt: time.Now().UTC(),
		Observation: guest.observation,
	}
	if plan.Observe != nil && guest.observation == nil {
		response.ObserveError = &DesktopInputError{
			Code:    "desktop_observe_failed",
			Message: "the plan ran but the box could not be observed afterwards",
		}
	}
	s.finishDesktopControl(ctx, workspace, "workspace.desktop.input", map[string]any{
		"workspace_id":  workspace.ID,
		"repository_id": workspace.RepositoryID,
		"vm_id":         workspace.VmID,
		"act_id":        plan.ActID,
		"actions":       auditActions,
		"completed":     guest.completed,
		"frame":         guest.frame,
		"image_width":   desktopImageWidth(imageOf(guest.observation)),
		"image_height":  desktopImageHeight(imageOf(guest.observation)),
		"bytes":         desktopImageBytes(imageOf(guest.observation)),
	}, userID)
	return response, nil
}

// desktopControlTarget resolves the workspace and the exec client. It NEVER
// auto-resumes: a suspended box takes a minute to come back, which does not
// fit a 30 s request, and the consumer has a Resume button for exactly this.
func (s *WorkspaceService) desktopControlTarget(ctx context.Context, workspaceID string, repositoryID, userID int64) (db.Workspace, workspaceDesktopVMClient, error) {
	if s == nil || s.q == nil {
		return db.Workspace{}, nil, pkgerrors.Internal("workspace store unavailable")
	}
	workspace, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return db.Workspace{}, nil, err
	}
	if normalizeWorkspaceKind(workspace.Kind) != "desktop" {
		return db.Workspace{}, nil, pkgerrors.BadRequest("this box has no desktop")
	}
	if workspace.Status != "running" || strings.TrimSpace(workspace.VmID) == "" {
		return db.Workspace{}, nil, pkgerrors.DesktopNotRunning("this box is not running; resume it first")
	}
	client, ok := s.sandbox.(workspaceDesktopVMClient)
	if !ok {
		return db.Workspace{}, nil, pkgerrors.Internal("sandbox provider cannot drive desktops")
	}
	return workspace, client, nil
}

// desktopTransportError turns a failed Execute/WriteFile into a verdict. A
// transport failure is ambiguous — the guest may have been suspended out from
// under the request — so ask the provider once rather than reporting a 500 for
// something the caller can fix with Resume.
func (s *WorkspaceService) desktopTransportError(ctx context.Context, workspace db.Workspace, cause error) error {
	if s.sandbox == nil {
		return pkgerrors.Internal("desktop guest unreachable: " + cause.Error())
	}
	vm, inspectErr := s.sandbox.InspectSandbox(ctx, workspace.VmID)
	if inspectErr != nil {
		if vmAlreadyGone(inspectErr) {
			return pkgerrors.DesktopNotRunning("this box is not running; resume it first")
		}
		return pkgerrors.Internal("desktop guest unreachable: " + cause.Error())
	}
	if vm.State != sandbox.StateRunning {
		return pkgerrors.DesktopNotRunning("this box is not running; resume it first")
	}
	return pkgerrors.Internal("desktop guest unreachable: " + cause.Error())
}

// finishDesktopControl records activity and writes the audit row. Both are
// side effects of a request that already succeeded, so neither may fail it,
// and the audit write outlives the request context (a client that hangs up
// still performed the action).
func (s *WorkspaceService) finishDesktopControl(ctx context.Context, workspace db.Workspace, eventType string, metadata map[string]any, userID int64) {
	_ = s.q.TouchWorkspaceActivity(ctx, workspace.ID)
	recorder, ok := s.q.(workspaceDesktopAuditRecorder)
	if !ok {
		return
	}
	detached := context.WithoutCancel(ctx)
	payload, err := json.Marshal(metadata)
	if err != nil {
		payload = []byte("{}")
	}
	actor := userID
	SafeGo("workspace-desktop-audit", func() {
		auditCtx, cancel := context.WithTimeout(detached, desktopAuditTimeout)
		defer cancel()
		if err := recorder.InsertAuditLog(auditCtx, db.InsertAuditLogParams{
			EventType:  eventType,
			ActorID:    pgtype.Int8{Int64: actor, Valid: actor > 0},
			TargetType: "workspace",
			TargetName: workspace.ID,
			Action:     strings.TrimPrefix(eventType, "workspace.desktop."),
			Metadata:   json.RawMessage(payload),
		}); err != nil {
			slog.Error("workspace desktop audit write failed", "workspace_id", workspace.ID,
				"event_type", eventType, "actor_id", actor, "error", err)
		}
	})
}

// applyDesktopObserveTextSwitch turns off screen-text reading when the
// deployment has disabled it. It is applied after validation so a client that
// asks for text still gets a valid 200 with text: null, rather than a 400 for
// a field it cannot know is disabled.
func (s *WorkspaceService) applyDesktopObserveTextSwitch(observe *desktopGuestObserve) {
	if observe != nil && !s.desktopObserveText {
		observe.Text = 0
	}
}

// resolveDesktopGuestObserve validates the observation request and resolves it
// to the three integers the guest helper takes.
func resolveDesktopGuestObserve(request *DesktopObserveRequest) (*desktopGuestObserve, error) {
	if request == nil {
		return nil, nil
	}
	observe := desktopGuestObserve{Text: 1, Quality: defaultDesktopImageQuality}
	if request.Text != nil && !*request.Text {
		observe.Text = 0
	}
	if request.Image == nil {
		return &observe, nil
	}
	observe.MaxWidth = defaultDesktopImageMaxWidth
	if request.Image.MaxWidth != nil {
		observe.MaxWidth = *request.Image.MaxWidth
		if observe.MaxWidth < minDesktopImageWidth || observe.MaxWidth > maxDesktopImageWidth {
			return nil, pkgerrors.BadRequest("max_width must be between 320 and 1920")
		}
	}
	if request.Image.Quality != nil {
		observe.Quality = *request.Image.Quality
		if observe.Quality < minDesktopImageQuality || observe.Quality > maxDesktopImageQuality {
			return nil, pkgerrors.BadRequest("quality must be between 30 and 85")
		}
	}
	return &observe, nil
}

// desktopObserveCommand builds the observe exec. Every byte of it is fixed
// except three integers this function bounded itself.
func desktopObserveCommand(observe desktopGuestObserve) string {
	args := strconv.Itoa(observe.Text) + " " + strconv.Itoa(observe.MaxWidth) + " " + strconv.Itoa(observe.Quality)
	return desktopHelperCommand(desktopObserveHelper, args)
}

// desktopInputCommand builds the input exec. Two tokens reach the guest's
// argv and neither is free text: a 16-hex nonce this process generated, and
// the act_id, which validateDesktopPlan already proved is an 8-4-4-4-12 hex
// UUID. The plan — the only part a caller authored — travels as a file.
//
// The act_id is an argument rather than a field of the plan because the guest
// keeps its replay ledger as root, before the wrapper drops to the desktop
// user; a wrapper that had to parse the plan's JSON to find the act_id would
// be parsing caller-authored bytes in shell.
func desktopInputCommand(nonce, actID string) string {
	return desktopHelperCommand(desktopInputHelper, "'"+nonce+"' '"+actID+"'")
}

// desktopHelperCommand is the shim-then-profile lookup the desktop password
// rotation already uses, with the activation check in front of it so a guest
// that is merely still booting is told apart from one whose image predates the
// helpers entirely. Exit 69 means "not activated yet, retry"; exit 127 means
// "this image will never have them".
func desktopHelperCommand(helper, args string) string {
	if args != "" {
		args = " " + args
	}
	return "state=$(systemctl is-system-running 2>/dev/null || true)\n" +
		"case \"$state\" in running|degraded) ;; *) exit " + strconv.Itoa(desktopExitNotActivated) + " ;; esac\n" +
		"if [ -x /usr/local/bin/" + helper + " ]; then exec /usr/local/bin/" + helper + args + "; fi\n" +
		"if [ -x /run/current-system/sw/bin/" + helper + " ]; then exec /run/current-system/sw/bin/" + helper + args + "; fi\n" +
		"exit " + strconv.Itoa(desktopExitMissing)
}

// desktopExecTimeoutMS fits the guest's budget inside the request deadline,
// leaving room for the round trip and the response.
func desktopExecTimeoutMS(ctx context.Context, ceilingMS int64) *int64 {
	timeout := ceilingMS
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline).Milliseconds() - desktopExecDeadlineMarginMS
		if remaining < timeout {
			timeout = remaining
		}
	}
	if timeout < desktopExecFloorMS {
		timeout = desktopExecFloorMS
	}
	return &timeout
}

// desktopExitError maps a helper's exit code onto the API verdict. Details for
// the guarded refusals are filled in by decorateDesktopInputError, which has
// the guest's stdout.
func desktopExitError(result sandbox.ExecResult) error {
	status := int32(0)
	if result.StatusCode != nil {
		status = *result.StatusCode
	}
	switch status {
	case 0:
		return nil
	case desktopExitImageTooLarge:
		return pkgerrors.Internal("desktop capture stayed above 1 MiB after downscaling")
	case desktopExitBadPlan:
		return pkgerrors.Internal("desktop helper rejected the plan: " + desktopStderrDetail(result))
	case desktopExitOutOfBounds:
		return pkgerrors.DesktopInputOutOfBounds("an action fell outside the desktop", nil)
	case desktopExitFrameChanged:
		return pkgerrors.DesktopFrameChanged("the desktop changed size since that observation; nothing was done", nil)
	case desktopExitFocusTerminal:
		return pkgerrors.DesktopFocusTerminal("a terminal window has focus; set allow_terminal to type into it", nil)
	case desktopExitNotActivated:
		return pkgerrors.DesktopNotReady("this box's desktop is still starting; retry shortly")
	case desktopExitToolFailure:
		if desktopDisplayUnreachable(result) {
			return pkgerrors.DesktopNotReady("this box's desktop is still starting; retry shortly")
		}
		return pkgerrors.Internal("desktop helper failed: " + desktopStderrDetail(result))
	case desktopExitBusy:
		return pkgerrors.DesktopBusy("this box is busy with another desktop action")
	case desktopExitActRepeated:
		return pkgerrors.DesktopActRepeated("that act_id already ran on this box")
	case desktopExitMissing:
		return pkgerrors.DesktopToolsUnavailable("this box's image has no desktop tools; open a new box to get them")
	default:
		return pkgerrors.Internal("desktop helper exited " + strconv.Itoa(int(status)) + ": " + desktopStderrDetail(result))
	}
}

// desktopDisplayUnreachable separates "X is not up yet" from a genuine tool
// failure. Both are exit 70 from xdotool and ImageMagick.
func desktopDisplayUnreachable(result sandbox.ExecResult) bool {
	message := strings.ToLower(result.Stderr)
	return strings.Contains(message, "unable to open x server") || strings.Contains(message, "can't open display")
}

// desktopStderrDetail bounds guest stderr before it enters a 5xx message. The
// route sanitizes 5xx messages anyway; this keeps the server-side log honest
// without letting a runaway helper write a megabyte into it.
func desktopStderrDetail(result sandbox.ExecResult) string {
	detail := strings.TrimSpace(result.Stderr)
	if len(detail) > 512 {
		detail = detail[:512]
	}
	if detail == "" {
		return "no detail"
	}
	return detail
}

// decorateDesktopInputError fills a guarded refusal with what the guest saw.
func decorateDesktopInputError(err error, guest desktopInputOutput, parseErr error) error {
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || parseErr != nil {
		return err
	}
	switch apiErr.Code {
	case pkgerrors.CodeDesktopFrameChanged:
		apiErr.Details = desktopFrameChangedDetails{Frame: guest.frame, Observation: guest.observation}
	case pkgerrors.CodeDesktopFocusTerminal:
		apiErr.Details = map[string]any{"focused": guest.focused}
	case pkgerrors.CodeDesktopInputOutOfBounds:
		apiErr.Details = desktopOutOfBoundsDetails{
			Width: guest.frame.Width, Height: guest.frame.Height,
			Index: guest.failIndex, Completed: guest.completed,
		}
		apiErr.Message = fmt.Sprintf("action %d at %d,%d is outside the %dx%d desktop",
			guest.failIndex, guest.failX, guest.failY, guest.frame.Width, guest.frame.Height)
	}
	return apiErr
}

// desktopInputOutput is everything the input helper printed.
type desktopInputOutput struct {
	frame       DesktopFrame
	completed   int
	failIndex   int
	failX       int
	failY       int
	focused     *DesktopWindow
	observation *DesktopObservation
}

// parseDesktopInputOutput reads the input helper's stdout:
//
//	geometry <w> <h>
//	completed <n>
//	[fail <json>]
//	[<observe block>]
func parseDesktopInputOutput(workspaceID, stdout string) (desktopInputOutput, error) {
	out := desktopInputOutput{}
	lines := desktopLines(stdout)
	if len(lines) < 2 {
		return out, pkgerrors.Internal("desktop helper returned no result")
	}
	frame, err := parseDesktopGeometry(lines[0])
	if err != nil {
		return out, err
	}
	out.frame = frame
	completed, ok := strings.CutPrefix(lines[1], "completed ")
	if !ok {
		return out, pkgerrors.Internal("desktop helper returned no completion count")
	}
	count, convErr := strconv.Atoi(strings.TrimSpace(completed))
	if convErr != nil || count < 0 {
		return out, pkgerrors.Internal("desktop helper returned an invalid completion count")
	}
	out.completed = count

	rest := lines[2:]
	if len(rest) > 0 {
		if payload, isFail := strings.CutPrefix(rest[0], "fail "); isFail {
			var failure struct {
				Index   int            `json:"index"`
				X       int            `json:"x"`
				Y       int            `json:"y"`
				Focused *DesktopWindow `json:"focused"`
			}
			if json.Unmarshal([]byte(payload), &failure) != nil {
				return out, pkgerrors.Internal("desktop helper returned an invalid failure payload")
			}
			out.failIndex, out.failX, out.failY, out.focused = failure.Index, failure.X, failure.Y, failure.Focused
			rest = rest[1:]
		}
	}
	if len(rest) > 0 {
		observation, observeErr := parseDesktopObservationLines(workspaceID, rest)
		if observeErr == nil {
			out.observation = &observation
		}
	}
	return out, nil
}

// parseDesktopObservation reads the observe helper's stdout.
func parseDesktopObservation(workspaceID, stdout string) (DesktopObservation, error) {
	return parseDesktopObservationLines(workspaceID, desktopLines(stdout))
}

// parseDesktopObservationLines reads the observe block:
//
//	geometry <w> <h>
//	pointer <x> <y>
//	focused <json>|-
//	windows <json>
//	text <base64>|-
//	[image <bytes> <width> <height>]
//	[<base64 jpeg>]
func parseDesktopObservationLines(workspaceID string, lines []string) (DesktopObservation, error) {
	if len(lines) < 5 {
		return DesktopObservation{}, pkgerrors.Internal("desktop helper returned an incomplete observation")
	}
	observation := DesktopObservation{WorkspaceID: workspaceID, CapturedAt: time.Now().UTC(), Windows: []DesktopWindowEntry{}}

	frame, err := parseDesktopGeometry(lines[0])
	if err != nil {
		return DesktopObservation{}, err
	}
	observation.Frame = frame

	pointer, ok := strings.CutPrefix(lines[1], "pointer ")
	if !ok {
		return DesktopObservation{}, pkgerrors.Internal("desktop helper returned no pointer")
	}
	x, y, err := parseDesktopPair(pointer)
	if err != nil {
		return DesktopObservation{}, err
	}
	observation.Pointer = DesktopPointer{X: x, Y: y}

	focused, ok := strings.CutPrefix(lines[2], "focused ")
	if !ok {
		return DesktopObservation{}, pkgerrors.Internal("desktop helper returned no focus")
	}
	if strings.TrimSpace(focused) != "-" {
		var window DesktopWindow
		if json.Unmarshal([]byte(focused), &window) != nil {
			return DesktopObservation{}, pkgerrors.Internal("desktop helper returned an invalid focused window")
		}
		observation.Focused = boundDesktopWindow(&window)
	}

	windows, ok := strings.CutPrefix(lines[3], "windows ")
	if !ok {
		return DesktopObservation{}, pkgerrors.Internal("desktop helper returned no window list")
	}
	var entries []DesktopWindowEntry
	if json.Unmarshal([]byte(windows), &entries) != nil {
		return DesktopObservation{}, pkgerrors.Internal("desktop helper returned an invalid window list")
	}
	if len(entries) > maxDesktopWindows {
		entries = entries[:maxDesktopWindows]
	}
	for index := range entries {
		boundDesktopWindow(&entries[index].DesktopWindow)
	}
	if entries != nil {
		observation.Windows = entries
	}

	text, ok := strings.CutPrefix(lines[4], "text ")
	if !ok {
		return DesktopObservation{}, pkgerrors.Internal("desktop helper returned no text field")
	}
	if trimmed := strings.TrimSpace(text); trimmed != "-" {
		decoded, decodeErr := base64.StdEncoding.DecodeString(trimmed)
		if decodeErr != nil {
			return DesktopObservation{}, pkgerrors.Internal("desktop helper returned invalid screen text").WithCause(decodeErr)
		}
		screen := boundDesktopText(string(decoded))
		source := "chrome-cdp"
		observation.Text, observation.TextSource = &screen, &source
	}

	if len(lines) >= 7 {
		image, imageErr := parseDesktopImage(lines[5], lines[6], observation.Frame)
		if imageErr != nil {
			return DesktopObservation{}, imageErr
		}
		observation.Image = image
	}
	return observation, nil
}

func parseDesktopImage(header, payload string, frame DesktopFrame) (*DesktopImage, error) {
	fields := strings.Fields(strings.TrimPrefix(header, "image "))
	if !strings.HasPrefix(header, "image ") || len(fields) != 3 {
		return nil, pkgerrors.Internal("desktop helper returned an invalid image header")
	}
	declared, err := strconv.Atoi(fields[0])
	if err != nil || declared < 0 || declared > maxDesktopImageBytes {
		return nil, pkgerrors.Internal("desktop helper returned an out-of-range image size")
	}
	width, widthErr := strconv.Atoi(fields[1])
	height, heightErr := strconv.Atoi(fields[2])
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return nil, pkgerrors.Internal("desktop helper returned invalid image dimensions")
	}
	decoded, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(payload))
	if decodeErr != nil || len(decoded) != declared {
		return nil, pkgerrors.Internal("desktop helper returned a truncated image")
	}
	scale := 0.0
	if frame.Width > 0 {
		scale = float64(width) / float64(frame.Width)
	}
	return &DesktopImage{
		ContentType: "image/jpeg",
		Encoding:    "base64",
		Image:       strings.TrimSpace(payload),
		Bytes:       declared,
		ImageWidth:  width,
		ImageHeight: height,
		Scale:       scale,
	}, nil
}

func parseDesktopGeometry(line string) (DesktopFrame, error) {
	value, ok := strings.CutPrefix(line, "geometry ")
	if !ok {
		return DesktopFrame{}, pkgerrors.Internal("desktop helper returned no geometry")
	}
	width, height, err := parseDesktopPair(value)
	if err != nil {
		return DesktopFrame{}, err
	}
	if width <= 0 || height <= 0 {
		return DesktopFrame{}, pkgerrors.Internal("desktop helper returned an empty framebuffer")
	}
	return DesktopFrame{Width: width, Height: height}, nil
}

func parseDesktopPair(value string) (int, int, error) {
	fields := strings.Fields(value)
	if len(fields) != 2 {
		return 0, 0, pkgerrors.Internal("desktop helper returned a malformed coordinate pair")
	}
	first, firstErr := strconv.Atoi(fields[0])
	second, secondErr := strconv.Atoi(fields[1])
	if firstErr != nil || secondErr != nil {
		return 0, 0, pkgerrors.Internal("desktop helper returned a malformed coordinate pair")
	}
	return first, second, nil
}

func desktopLines(stdout string) []string {
	lines := strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// boundDesktopWindow trims a window's strings to the response contract. The
// title is page-controlled text, so it is bounded here rather than trusted.
func boundDesktopWindow(window *DesktopWindow) *DesktopWindow {
	if window == nil {
		return nil
	}
	window.Title = truncateRunes(window.Title, maxDesktopWindowTitle)
	window.Class = truncateRunes(window.Class, maxDesktopWindowClass)
	window.ID = truncateRunes(window.ID, maxDesktopWindowClass)
	return window
}

// boundDesktopText caps screen text and strips control characters. The guest
// strips them too; doing it again costs nothing and means a helper regression
// cannot put an ANSI escape into a consumer's terminal.
func boundDesktopText(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	for _, r := range text {
		switch {
		case r == '\n' || r == '\t':
			builder.WriteRune(r)
		case r < 0x20 || r == 0x7F || (r >= 0x80 && r <= 0x9F):
		default:
			builder.WriteRune(r)
		}
	}
	return truncateRunes(builder.String(), maxDesktopText)
}

func truncateRunes(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func imageOf(observation *DesktopObservation) *DesktopImage {
	if observation == nil {
		return nil
	}
	return observation.Image
}

func desktopImageWidth(image *DesktopImage) int {
	if image == nil {
		return 0
	}
	return image.ImageWidth
}

func desktopImageHeight(image *DesktopImage) int {
	if image == nil {
		return 0
	}
	return image.ImageHeight
}

func desktopImageBytes(image *DesktopImage) int {
	if image == nil {
		return 0
	}
	return image.Bytes
}
