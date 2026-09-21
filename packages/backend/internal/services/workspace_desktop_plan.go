package services

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The desktop input grammar. Every plan is validated here, in full, BEFORE a
// single byte leaves the API: the guest helper re-checks coordinates against
// live geometry, but it is not the place where an untrusted plan is first
// judged. Nothing in a plan ever reaches a shell — the normalized plan travels
// to the guest as a JSON file written over the provider's FS API, and the only
// command string the API builds carries integers and a hex nonce.

const (
	// A plan is a burst of intent, not a script. Ten actions is enough for
	// "click the address bar, type a URL, press Return" with room to spare, and
	// short enough that the caller re-observes often.
	maxDesktopPlanActions = 10
	// Typed text across the whole plan. 1024 scalars is a long URL or a
	// paragraph; anything longer is a file write, not a keystroke.
	maxDesktopPlanTypeScalars = 1024
	// Non-ASCII scalars cost ~40 ms each through xdotool's keymap remapping, so
	// they are budgeted separately and far more tightly than ASCII.
	maxDesktopPlanNonASCII = 256
	// The estimated wall-clock budget of one plan. The exec timeout is 20 s, so
	// a plan that estimates above 15 s cannot reliably finish inside it.
	maxDesktopPlanEstimateMS = 15000
	maxDesktopScrollDelta    = 20
	maxDesktopWaitMS         = 2000
	maxDesktopSettleMS       = 2000
	defaultDesktopSettleMS   = 300
	maxDesktopKeyModifiers   = 3
)

// DesktopPoint is a framebuffer coordinate.
type DesktopPoint struct {
	X *int `json:"x"`
	Y *int `json:"y"`
}

// DesktopInputAction is one requested action, as the client sends it. Absent
// and zero are different for every numeric field, so they are all pointers.
type DesktopInputAction struct {
	Action string        `json:"action,omitempty"`
	X      *int          `json:"x,omitempty"`
	Y      *int          `json:"y,omitempty"`
	From   *DesktopPoint `json:"from,omitempty"`
	To     *DesktopPoint `json:"to,omitempty"`
	Button string        `json:"button,omitempty"`
	Count  *int          `json:"count,omitempty"`
	DX     *int          `json:"dx,omitempty"`
	DY     *int          `json:"dy,omitempty"`
	Text   string        `json:"text,omitempty"`
	Combo  string        `json:"combo,omitempty"`
	MS     *int          `json:"ms,omitempty"`
}

// DesktopInputRequest is the /desktop/input body. The embedded action is
// sugar: a one-action plan may be written as the body itself
// ({"act_id":"…","action":"click","x":10,"y":20}).
type DesktopInputRequest struct {
	ActID              string                 `json:"act_id"`
	Actions            []DesktopInputAction   `json:"actions"`
	DesktopInputAction                        // sugar: a single action as the body
	Frame              *DesktopFrame          `json:"frame"`
	AllowTerminal      bool                   `json:"allow_terminal"`
	SettleMS           *int                   `json:"settle_ms"`
	Observe            *DesktopObserveRequest `json:"observe"`
}

// desktopGuestAction is the normalized, defaults-resolved action the guest
// helper executes. Field names are the guest contract.
type desktopGuestAction struct {
	Action string `json:"action"`
	X      *int   `json:"x,omitempty"`
	Y      *int   `json:"y,omitempty"`
	FromX  *int   `json:"from_x,omitempty"`
	FromY  *int   `json:"from_y,omitempty"`
	ToX    *int   `json:"to_x,omitempty"`
	ToY    *int   `json:"to_y,omitempty"`
	Button string `json:"button,omitempty"`
	Count  int    `json:"count,omitempty"`
	DX     int    `json:"dx,omitempty"`
	DY     int    `json:"dy,omitempty"`
	Text   string `json:"text,omitempty"`
	Combo  string `json:"combo,omitempty"`
	MS     int    `json:"ms,omitempty"`
}

// desktopGuestPlan is the JSON the guest helper reads on stdin. It contains no
// credentials and is unlinked by the wrapper before privileges drop.
type desktopGuestPlan struct {
	ActID         string               `json:"act_id"`
	AllowTerminal bool                 `json:"allow_terminal"`
	SettleMS      int                  `json:"settle_ms"`
	Frame         *DesktopFrame        `json:"frame"`
	Actions       []desktopGuestAction `json:"actions"`
	Observe       *desktopGuestObserve `json:"observe"`
}

// desktopGuestObserve is the post-plan observation request, resolved to the
// same three integers the standalone observe helper takes.
type desktopGuestObserve struct {
	Text     int `json:"text"`
	MaxWidth int `json:"max_width"`
	Quality  int `json:"quality"`
}

// desktopAuditAction is the audit-log shape of one action. Typed text is NEVER
// stored: only its length in scalars, which is what an investigator needs to
// tell "typed a URL" from "pasted a paragraph".
type desktopAuditAction struct {
	Action    string `json:"action"`
	X         *int   `json:"x,omitempty"`
	Y         *int   `json:"y,omitempty"`
	FromX     *int   `json:"from_x,omitempty"`
	FromY     *int   `json:"from_y,omitempty"`
	ToX       *int   `json:"to_x,omitempty"`
	ToY       *int   `json:"to_y,omitempty"`
	Button    string `json:"button,omitempty"`
	Count     int    `json:"count,omitempty"`
	DX        int    `json:"dx,omitempty"`
	DY        int    `json:"dy,omitempty"`
	Combo     string `json:"combo,omitempty"`
	TextChars int    `json:"text_chars,omitempty"`
	MS        int    `json:"ms,omitempty"`
}

// desktopKeysyms is the closed set of X keysyms a combo may end in. Anything
// outside it — including every keysym that could reach a window manager or a
// VT switch — is refused. Lower-case letters and digits only: a shifted
// character is expressed as shift+<key>.
var desktopKeysyms = map[string]bool{
	"Return": true, "Escape": true, "Tab": true, "BackSpace": true, "Delete": true,
	"Insert": true, "Home": true, "End": true, "Page_Up": true, "Page_Down": true,
	"Up": true, "Down": true, "Left": true, "Right": true, "space": true,
	"minus": true, "equal": true, "plus": true, "comma": true, "period": true,
	"slash": true, "backslash": true, "semicolon": true, "apostrophe": true,
	"grave": true, "bracketleft": true, "bracketright": true,
}

func init() {
	for c := 'a'; c <= 'z'; c++ {
		desktopKeysyms[string(c)] = true
	}
	for d := '0'; d <= '9'; d++ {
		desktopKeysyms[string(d)] = true
	}
	for f := 1; f <= 12; f++ {
		desktopKeysyms["F"+strconv.Itoa(f)] = true
	}
}

var desktopModifiers = map[string]bool{"ctrl": true, "alt": true, "shift": true, "super": true}

var desktopButtons = map[string]bool{"left": true, "middle": true, "right": true}

// validateDesktopPlan turns a request into the guest plan, or an APIError. It
// is pure: no clock, no network, no guest.
func validateDesktopPlan(req DesktopInputRequest) (desktopGuestPlan, []desktopAuditAction, error) {
	actID := strings.TrimSpace(req.ActID)
	if actID == "" {
		return desktopGuestPlan{}, nil, pkgerrors.BadRequest("act_id is required")
	}
	if !isValidUUID(actID) {
		return desktopGuestPlan{}, nil, pkgerrors.BadRequest("act_id must be a uuid")
	}

	actions := req.Actions
	if sugar := req.DesktopInputAction; strings.TrimSpace(sugar.Action) != "" {
		if len(actions) > 0 {
			return desktopGuestPlan{}, nil, pkgerrors.BadRequest("send either actions or a single action, not both")
		}
		actions = []DesktopInputAction{sugar}
	}
	if len(actions) == 0 {
		return desktopGuestPlan{}, nil, pkgerrors.BadRequest("actions must contain between 1 and 10 actions")
	}
	if len(actions) > maxDesktopPlanActions {
		return desktopGuestPlan{}, nil, pkgerrors.BadRequest("actions must contain between 1 and 10 actions")
	}

	if req.Frame != nil && (req.Frame.Width <= 0 || req.Frame.Height <= 0) {
		return desktopGuestPlan{}, nil, pkgerrors.BadRequest("frame must carry width and height")
	}

	settleMS := defaultDesktopSettleMS
	if req.SettleMS != nil {
		settleMS = *req.SettleMS
		if settleMS < 0 || settleMS > maxDesktopSettleMS {
			return desktopGuestPlan{}, nil, pkgerrors.BadRequest("settle_ms must be between 0 and 2000")
		}
	}

	guestActions := make([]desktopGuestAction, 0, len(actions))
	auditActions := make([]desktopAuditAction, 0, len(actions))
	estimate := settleMS
	typedScalars := 0
	typedNonASCII := 0

	for index, action := range actions {
		guest, audit, cost, err := validateDesktopAction(index, action, &typedScalars, &typedNonASCII)
		if err != nil {
			return desktopGuestPlan{}, nil, err
		}
		estimate += cost
		guestActions = append(guestActions, guest)
		auditActions = append(auditActions, audit)
	}
	if estimate > maxDesktopPlanEstimateMS {
		return desktopGuestPlan{}, nil, pkgerrors.BadRequest(fmt.Sprintf(
			"plan is estimated at %d ms, which exceeds the %d ms budget", estimate, maxDesktopPlanEstimateMS))
	}

	observe, err := resolveDesktopGuestObserve(req.Observe)
	if err != nil {
		return desktopGuestPlan{}, nil, err
	}
	return desktopGuestPlan{
		ActID:         actID,
		AllowTerminal: req.AllowTerminal,
		SettleMS:      settleMS,
		Frame:         req.Frame,
		Actions:       guestActions,
		Observe:       observe,
	}, auditActions, nil
}

// validateDesktopAction validates one action and returns its guest form, its
// audit form, and its estimated cost in milliseconds.
func validateDesktopAction(index int, action DesktopInputAction, typedScalars, typedNonASCII *int) (desktopGuestAction, desktopAuditAction, int, error) {
	position := "action " + strconv.Itoa(index+1)
	guest := desktopGuestAction{Action: strings.TrimSpace(action.Action)}
	audit := desktopAuditAction{Action: guest.Action}

	switch guest.Action {
	case "move":
		x, y, err := requireDesktopCoordinates(position, action.X, action.Y)
		if err != nil {
			return guest, audit, 0, err
		}
		guest.X, guest.Y = &x, &y
		audit.X, audit.Y = &x, &y
		return guest, audit, 50, nil

	case "click":
		x, y, err := optionalDesktopCoordinates(position, action.X, action.Y)
		if err != nil {
			return guest, audit, 0, err
		}
		guest.X, guest.Y, audit.X, audit.Y = x, y, x, y
		button, err := desktopButton(position, action.Button)
		if err != nil {
			return guest, audit, 0, err
		}
		count := 1
		if action.Count != nil {
			count = *action.Count
			if count < 1 || count > 3 {
				return guest, audit, 0, pkgerrors.BadRequest(position + " count must be between 1 and 3")
			}
		}
		guest.Button, guest.Count = button, count
		audit.Button, audit.Count = button, count
		return guest, audit, 100 + 60*(count-1), nil

	case "drag":
		fromX, fromY, err := requireDesktopPoint(position+" from", action.From)
		if err != nil {
			return guest, audit, 0, err
		}
		toX, toY, err := requireDesktopPoint(position+" to", action.To)
		if err != nil {
			return guest, audit, 0, err
		}
		button, err := desktopButton(position, action.Button)
		if err != nil {
			return guest, audit, 0, err
		}
		guest.FromX, guest.FromY, guest.ToX, guest.ToY = &fromX, &fromY, &toX, &toY
		guest.Button = button
		audit.FromX, audit.FromY, audit.ToX, audit.ToY = &fromX, &fromY, &toX, &toY
		audit.Button = button
		return guest, audit, 400, nil

	case "scroll":
		x, y, err := optionalDesktopCoordinates(position, action.X, action.Y)
		if err != nil {
			return guest, audit, 0, err
		}
		guest.X, guest.Y, audit.X, audit.Y = x, y, x, y
		dx, err := desktopScrollDelta(position, "dx", action.DX)
		if err != nil {
			return guest, audit, 0, err
		}
		dy, err := desktopScrollDelta(position, "dy", action.DY)
		if err != nil {
			return guest, audit, 0, err
		}
		if dx == 0 && dy == 0 {
			return guest, audit, 0, pkgerrors.BadRequest(position + " scroll needs a non-zero dx or dy")
		}
		guest.DX, guest.DY, audit.DX, audit.DY = dx, dy, dx, dy
		steps := abs(dx) + abs(dy)
		return guest, audit, 50 + 40*steps, nil

	case "type":
		ascii, nonASCII, err := validateDesktopText(position, action.Text)
		if err != nil {
			return guest, audit, 0, err
		}
		*typedScalars += ascii + nonASCII
		*typedNonASCII += nonASCII
		if *typedScalars > maxDesktopPlanTypeScalars {
			return guest, audit, 0, pkgerrors.BadRequest(fmt.Sprintf(
				"typed text exceeds %d characters across the plan", maxDesktopPlanTypeScalars))
		}
		if *typedNonASCII > maxDesktopPlanNonASCII {
			return guest, audit, 0, pkgerrors.BadRequest(fmt.Sprintf(
				"typed text exceeds %d non-ASCII characters across the plan", maxDesktopPlanNonASCII))
		}
		guest.Text = action.Text
		audit.TextChars = ascii + nonASCII
		return guest, audit, 150 + 12*ascii + 40*nonASCII, nil

	case "key":
		combo, err := normalizeDesktopCombo(position, action.Combo)
		if err != nil {
			return guest, audit, 0, err
		}
		guest.Combo, audit.Combo = combo, combo
		return guest, audit, 100, nil

	case "wait":
		if action.MS == nil {
			return guest, audit, 0, pkgerrors.BadRequest(position + " ms is required")
		}
		if *action.MS < 1 || *action.MS > maxDesktopWaitMS {
			return guest, audit, 0, pkgerrors.BadRequest(position + " ms must be between 1 and 2000")
		}
		guest.MS, audit.MS = *action.MS, *action.MS
		return guest, audit, *action.MS, nil

	case "":
		return guest, audit, 0, pkgerrors.BadRequest(position + " is missing an action")
	default:
		return guest, audit, 0, pkgerrors.BadRequest(position + " has an unknown action " + strconv.Quote(guest.Action))
	}
}

// validateDesktopText enforces the typeable-rune set and returns the ASCII and
// non-ASCII scalar counts. Control characters other than newline and tab are
// refused: xdotool would turn them into keysyms nobody asked for, and they are
// the obvious channel for smuggling terminal escape sequences onto a screen.
func validateDesktopText(position, text string) (ascii, nonASCII int, err error) {
	if text == "" {
		return 0, 0, pkgerrors.BadRequest(position + " text is required")
	}
	if !utf8.ValidString(text) {
		return 0, 0, pkgerrors.BadRequest(position + " text is not valid UTF-8")
	}
	for _, r := range text {
		switch {
		case r == '\n' || r == '\t':
		case r < 0x20 || r == 0x7F || (r >= 0x80 && r <= 0x9F):
			return 0, 0, pkgerrors.BadRequest(position + " text contains a control character")
		}
		if r < 0x80 {
			ascii++
		} else {
			nonASCII++
		}
	}
	// Cheap per-action ceiling so one action cannot blow the plan budget before
	// the cross-action totals are consulted.
	if ascii+nonASCII > maxDesktopPlanTypeScalars {
		return 0, 0, pkgerrors.BadRequest(fmt.Sprintf(
			"typed text exceeds %d characters across the plan", maxDesktopPlanTypeScalars))
	}
	return ascii, nonASCII, nil
}

// normalizeDesktopCombo parses "ctrl+shift+t" into a canonical, sorted combo.
// Canonicalizing here means the guest never has to parse user intent, and the
// audit row records one spelling per chord.
func normalizeDesktopCombo(position, raw string) (string, error) {
	combo := strings.TrimSpace(raw)
	if combo == "" {
		return "", pkgerrors.BadRequest(position + " combo is required")
	}
	parts := strings.Split(combo, "+")
	if len(parts) > maxDesktopKeyModifiers+1 {
		return "", pkgerrors.BadRequest(position + " combo allows at most 3 modifiers")
	}
	seen := map[string]bool{}
	modifiers := make([]string, 0, maxDesktopKeyModifiers)
	key := ""
	for i, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			return "", pkgerrors.BadRequest(position + " combo is not a valid key combination")
		}
		if i == len(parts)-1 {
			key = part
			break
		}
		lowered := strings.ToLower(part)
		if !desktopModifiers[lowered] {
			return "", pkgerrors.BadRequest(position + " combo modifier " + strconv.Quote(part) + " is not allowed")
		}
		if seen[lowered] {
			return "", pkgerrors.BadRequest(position + " combo repeats the modifier " + strconv.Quote(lowered))
		}
		seen[lowered] = true
		modifiers = append(modifiers, lowered)
	}
	if len(modifiers) > maxDesktopKeyModifiers {
		return "", pkgerrors.BadRequest(position + " combo allows at most 3 modifiers")
	}
	if !desktopKeysyms[key] {
		return "", pkgerrors.BadRequest(position + " combo key " + strconv.Quote(key) + " is not allowed")
	}
	// ctrl+alt+BackSpace kills the X server and ctrl+alt+Delete is the
	// session's logout chord: either ends the box's desktop mid-plan and
	// strands the human sharing the screen.
	if seen["ctrl"] && seen["alt"] && (key == "BackSpace" || key == "Delete") {
		return "", pkgerrors.BadRequest(position + " combo ctrl+alt+" + key + " is not allowed")
	}
	sort.Strings(modifiers)
	return strings.Join(append(modifiers, key), "+"), nil
}

func desktopButton(position, raw string) (string, error) {
	button := strings.ToLower(strings.TrimSpace(raw))
	if button == "" {
		return "left", nil
	}
	if !desktopButtons[button] {
		return "", pkgerrors.BadRequest(position + " button must be left, middle, or right")
	}
	return button, nil
}

func desktopScrollDelta(position, field string, value *int) (int, error) {
	if value == nil {
		return 0, nil
	}
	if *value < -maxDesktopScrollDelta || *value > maxDesktopScrollDelta {
		return 0, pkgerrors.BadRequest(position + " " + field + " must be between -20 and 20")
	}
	return *value, nil
}

func requireDesktopCoordinates(position string, x, y *int) (int, int, error) {
	if x == nil || y == nil {
		return 0, 0, pkgerrors.BadRequest(position + " needs both x and y")
	}
	if *x < 0 || *y < 0 {
		return 0, 0, pkgerrors.BadRequest(position + " coordinates must not be negative")
	}
	return *x, *y, nil
}

func optionalDesktopCoordinates(position string, x, y *int) (*int, *int, error) {
	if x == nil && y == nil {
		return nil, nil, nil
	}
	resolvedX, resolvedY, err := requireDesktopCoordinates(position, x, y)
	if err != nil {
		return nil, nil, err
	}
	return &resolvedX, &resolvedY, nil
}

func requireDesktopPoint(position string, point *DesktopPoint) (int, int, error) {
	if point == nil {
		return 0, 0, pkgerrors.BadRequest(position + " is required")
	}
	return requireDesktopCoordinates(position, point.X, point.Y)
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
