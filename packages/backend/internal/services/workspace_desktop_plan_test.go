package services

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testActID = "11111111-2222-3333-4444-555555555555"

func planWith(actions ...DesktopInputAction) DesktopInputRequest {
	return DesktopInputRequest{ActID: testActID, Actions: actions}
}

func TestValidateDesktopPlan_ResolvesDefaults(t *testing.T) {
	plan, audit, err := validateDesktopPlan(planWith(
		DesktopInputAction{Action: "click", X: intPtr(10), Y: intPtr(20)},
		DesktopInputAction{Action: "key", Combo: "Shift+CTRL+t"},
		DesktopInputAction{Action: "scroll", DY: intPtr(3)},
	))
	require.NoError(t, err)

	assert.Equal(t, defaultDesktopSettleMS, plan.SettleMS)
	assert.Equal(t, "left", plan.Actions[0].Button, "an unstated button is the left one")
	assert.Equal(t, 1, plan.Actions[0].Count)
	// A combo is canonicalized here so the guest never parses intent and the
	// audit row has one spelling per chord.
	assert.Equal(t, "ctrl+shift+t", plan.Actions[1].Combo)
	assert.Equal(t, 3, plan.Actions[2].DY)
	assert.Nil(t, plan.Actions[2].X, "scroll without coordinates scrolls where the pointer is")

	require.Len(t, audit, 3)
	assert.Equal(t, "click", audit[0].Action)
	assert.Equal(t, "ctrl+shift+t", audit[1].Combo)
}

// TestValidateDesktopPlan_AuditNeverCarriesTypedText is a privacy property: an
// audit row says how much was typed, never what.
func TestValidateDesktopPlan_AuditNeverCarriesTypedText(t *testing.T) {
	_, audit, err := validateDesktopPlan(planWith(
		DesktopInputAction{Action: "type", Text: "correct horse battery staple"},
	))
	require.NoError(t, err)
	require.Len(t, audit, 1)
	assert.Equal(t, 28, audit[0].TextChars)

	encoded := mustJSON(t, audit)
	assert.NotContains(t, encoded, "correct horse")
	assert.NotContains(t, encoded, `"text"`)
	assert.Contains(t, encoded, `"text_chars":28`)
}

func TestValidateDesktopPlan_RejectsBadPlans(t *testing.T) {
	long := strings.Repeat("a", maxDesktopPlanTypeScalars+1)
	tenActions := make([]DesktopInputAction, 11)
	for i := range tenActions {
		tenActions[i] = DesktopInputAction{Action: "wait", MS: intPtr(1)}
	}

	for _, test := range []struct {
		name    string
		request DesktopInputRequest
		message string
	}{
		{"no act_id", DesktopInputRequest{Actions: []DesktopInputAction{{Action: "wait", MS: intPtr(1)}}}, "act_id is required"},
		{"act_id is not a uuid", DesktopInputRequest{ActID: "act-1", Actions: []DesktopInputAction{{Action: "wait", MS: intPtr(1)}}}, "act_id must be a uuid"},
		{"no actions", DesktopInputRequest{ActID: testActID}, "actions must contain between 1 and 10 actions"},
		{"too many actions", DesktopInputRequest{ActID: testActID, Actions: tenActions}, "actions must contain between 1 and 10 actions"},
		{"unknown action", planWith(DesktopInputAction{Action: "screenshot"}), `action 1 has an unknown action "screenshot"`},
		{"move without coordinates", planWith(DesktopInputAction{Action: "move"}), "action 1 needs both x and y"},
		{"negative coordinates", planWith(DesktopInputAction{Action: "move", X: intPtr(-1), Y: intPtr(0)}), "action 1 coordinates must not be negative"},
		{"half a click position", planWith(DesktopInputAction{Action: "click", X: intPtr(5)}), "action 1 needs both x and y"},
		{"bad button", planWith(DesktopInputAction{Action: "click", Button: "thumb"}), "action 1 button must be left, middle, or right"},
		{"quadruple click", planWith(DesktopInputAction{Action: "click", Count: intPtr(4)}), "action 1 count must be between 1 and 3"},
		{"drag without from", planWith(DesktopInputAction{Action: "drag", To: &DesktopPoint{X: intPtr(1), Y: intPtr(1)}}), "action 1 from is required"},
		{"scroll goes nowhere", planWith(DesktopInputAction{Action: "scroll", DX: intPtr(0), DY: intPtr(0)}), "action 1 scroll needs a non-zero dx or dy"},
		{"scroll too far", planWith(DesktopInputAction{Action: "scroll", DY: intPtr(21)}), "action 1 dy must be between -20 and 20"},
		{"empty text", planWith(DesktopInputAction{Action: "type"}), "action 1 text is required"},
		{"control character", planWith(DesktopInputAction{Action: "type", Text: "ok\x1b[31m"}), "action 1 text contains a control character"},
		{"c1 control character", planWith(DesktopInputAction{Action: "type", Text: "ok\u009b31m"}), "action 1 text contains a control character"},
		{"delete character", planWith(DesktopInputAction{Action: "type", Text: "ok\x7f"}), "action 1 text contains a control character"},
		{"text too long", planWith(DesktopInputAction{Action: "type", Text: long}), "typed text exceeds 1024 characters across the plan"},
		{"no combo", planWith(DesktopInputAction{Action: "key"}), "action 1 combo is required"},
		{"unknown keysym", planWith(DesktopInputAction{Action: "key", Combo: "ctrl+XF86PowerOff"}), `action 1 combo key "XF86PowerOff" is not allowed`},
		{"unknown modifier", planWith(DesktopInputAction{Action: "key", Combo: "hyper+a"}), `action 1 combo modifier "hyper" is not allowed`},
		{"four modifiers", planWith(DesktopInputAction{Action: "key", Combo: "ctrl+alt+shift+super+a"}), "action 1 combo allows at most 3 modifiers"},
		{"repeated modifier", planWith(DesktopInputAction{Action: "key", Combo: "ctrl+ctrl+a"}), `action 1 combo repeats the modifier "ctrl"`},
		{"kills the x server", planWith(DesktopInputAction{Action: "key", Combo: "ctrl+alt+BackSpace"}), "action 1 combo ctrl+alt+BackSpace is not allowed"},
		{"logs the session out", planWith(DesktopInputAction{Action: "key", Combo: "alt+ctrl+Delete"}), "action 1 combo ctrl+alt+Delete is not allowed"},
		{"wait without ms", planWith(DesktopInputAction{Action: "wait"}), "action 1 ms is required"},
		{"wait too long", planWith(DesktopInputAction{Action: "wait", MS: intPtr(2001)}), "action 1 ms must be between 1 and 2000"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := validateDesktopPlan(test.request)
			apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
			assert.Equal(t, test.message, apiErr.Message)
		})
	}
}

// TestValidateDesktopPlan_AllowedCombos pins the far side of the allowlist:
// these are the chords an agent actually needs and they must keep working.
func TestValidateDesktopPlan_AllowedCombos(t *testing.T) {
	for raw, want := range map[string]string{
		"ctrl+l":            "ctrl+l",
		"Return":            "Return",
		"ctrl+shift+Tab":    "ctrl+shift+Tab",
		"alt+F4":            "alt+F4",
		"super+d":           "super+d",
		"ctrl+alt+t":        "alt+ctrl+t",
		"shift+Page_Down":   "shift+Page_Down",
		"ctrl+shift+alt+F5": "alt+ctrl+shift+F5",
		"ctrl+minus":        "ctrl+minus",
		"ctrl+bracketleft":  "ctrl+bracketleft",
	} {
		plan, _, err := validateDesktopPlan(planWith(DesktopInputAction{Action: "key", Combo: raw}))
		require.NoError(t, err, raw)
		assert.Equal(t, want, plan.Actions[0].Combo, raw)
	}
}

func TestValidateDesktopPlan_EnforcesTheTimeBudget(t *testing.T) {
	// Eight 2 s waits is 16 s of plan; the exec timeout is 20 s, so it could
	// not reliably finish and is refused before anything is injected.
	actions := make([]DesktopInputAction, 8)
	for i := range actions {
		actions[i] = DesktopInputAction{Action: "wait", MS: intPtr(2000)}
	}
	_, _, err := validateDesktopPlan(planWith(actions...))
	apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
	assert.Contains(t, apiErr.Message, "exceeds the 15000 ms budget")

	// Seven fits, with the default settle on top.
	_, _, err = validateDesktopPlan(planWith(actions[:7]...))
	require.NoError(t, err)
}

func TestValidateDesktopPlan_CountsTypedTextAcrossActions(t *testing.T) {
	half := strings.Repeat("x", 600)
	_, _, err := validateDesktopPlan(planWith(
		DesktopInputAction{Action: "type", Text: half},
		DesktopInputAction{Action: "type", Text: half},
	))
	apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
	assert.Equal(t, "typed text exceeds 1024 characters across the plan", apiErr.Message)

	// Non-ASCII has its own, tighter ceiling: each scalar costs xdotool a
	// keymap remap, so 300 of them is a slower plan than 300 ASCII characters.
	_, _, err = validateDesktopPlan(planWith(
		DesktopInputAction{Action: "type", Text: strings.Repeat("é", 257)},
	))
	apiErr = assertAPIErrorStatus(t, err, http.StatusBadRequest)
	assert.Equal(t, "typed text exceeds 256 non-ASCII characters across the plan", apiErr.Message)
}

func TestValidateDesktopPlan_AcceptsTypeableText(t *testing.T) {
	plan, _, err := validateDesktopPlan(planWith(
		DesktopInputAction{Action: "type", Text: "https://example.com/a?b=c\n\tdone é"},
	))
	require.NoError(t, err)
	assert.Equal(t, "https://example.com/a?b=c\n\tdone é", plan.Actions[0].Text)
}

func TestValidateDesktopPlan_RejectsInvalidUTF8(t *testing.T) {
	_, _, err := validateDesktopPlan(planWith(
		DesktopInputAction{Action: "type", Text: string([]byte{0xff, 0xfe})},
	))
	apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
	assert.Equal(t, "action 1 text is not valid UTF-8", apiErr.Message)
}

func TestValidateDesktopPlan_ValidatesFrameAndSettle(t *testing.T) {
	request := planWith(DesktopInputAction{Action: "wait", MS: intPtr(1)})
	request.Frame = &DesktopFrame{Width: 1920}
	_, _, err := validateDesktopPlan(request)
	apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
	assert.Equal(t, "frame must carry width and height", apiErr.Message)

	request.Frame = &DesktopFrame{Width: 1920, Height: 1080}
	request.SettleMS = intPtr(2001)
	_, _, err = validateDesktopPlan(request)
	apiErr = assertAPIErrorStatus(t, err, http.StatusBadRequest)
	assert.Equal(t, "settle_ms must be between 0 and 2000", apiErr.Message)

	request.SettleMS = intPtr(0)
	plan, _, err := validateDesktopPlan(request)
	require.NoError(t, err)
	assert.Equal(t, 0, plan.SettleMS, "an explicit zero is not the default")
	assert.Equal(t, &DesktopFrame{Width: 1920, Height: 1080}, plan.Frame)
}

func TestValidateDesktopPlan_RejectsBothSugarAndActions(t *testing.T) {
	request := planWith(DesktopInputAction{Action: "wait", MS: intPtr(1)})
	request.DesktopInputAction = DesktopInputAction{Action: "key", Combo: "Return"}
	_, _, err := validateDesktopPlan(request)
	apiErr := assertAPIErrorStatus(t, err, http.StatusBadRequest)
	assert.Equal(t, "send either actions or a single action, not both", apiErr.Message)
}

func TestResolveDesktopGuestObserve(t *testing.T) {
	// Nil means "do not observe at all" (the input route's default); an empty
	// object means "observe, text on, no capture" (the observe route's).
	observe, err := resolveDesktopGuestObserve(nil)
	require.NoError(t, err)
	assert.Nil(t, observe)

	observe, err = resolveDesktopGuestObserve(&DesktopObserveRequest{})
	require.NoError(t, err)
	require.NotNil(t, observe)
	assert.Equal(t, desktopGuestObserve{Text: 1, MaxWidth: 0, Quality: defaultDesktopImageQuality}, *observe)

	off := false
	observe, err = resolveDesktopGuestObserve(&DesktopObserveRequest{Text: &off, Image: &DesktopImageRequest{}})
	require.NoError(t, err)
	assert.Equal(t, desktopGuestObserve{Text: 0, MaxWidth: defaultDesktopImageMaxWidth, Quality: defaultDesktopImageQuality}, *observe)
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	return string(encoded)
}
