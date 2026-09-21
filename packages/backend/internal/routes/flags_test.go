package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

// rolloutFlagKeys are the remote-client rollout flag names added by ticket 0112.
// remote-sandbox rollout. Kept in one place so tests that assert presence and
// env-override tests stay aligned.
var rolloutFlagKeys = []string{
	"remote_sandbox_enabled",
	"approvals_flow_enabled",
	"devtools_snapshot_enabled",
	"run_shape_enabled",
}

// mvpGatingFlagDefaults are the flag names + expected defaults added by
// ticket 12 (MVP gating). Core launch families default to true; every other
// non-MVP family defaults to false. Kept in one place so the presence and
// default tests stay aligned with the config defaults.
var mvpGatingFlagDefaults = map[string]bool{
	"stacked_prs":         true,
	"workflows":           true,
	"sandboxes":           true,
	"auto_push":           true,
	"issues":              false,
	"search":              false,
	"workspaces":          false,
	"agents":              false,
	"web_dashboard":       false,
	"protected_bookmarks": false,
	"notifications":       false,
	"wiki":                false,
	"labels":              false,
	"releases":            false,
	"secrets":             true,
	"webhooks_user":       false,
	"bot_commands":        false,
	"draft_prs":           false,
	"reviewers":           false,
	"multi_auth":          false,
	"private_repos":       false,
}

func TestFeatureFlagHandler_GetFeatureFlags_AllEnabled(t *testing.T) {
	t.Parallel()

	h := &FeatureFlagHandler{Config: config.FeatureFlagsConfig{
		ReadoutDashboard:        true,
		LandingQueue:            true,
		ToolSkills:              true,
		ToolPolicies:            true,
		RepoSnapshots:           true,
		Integrations:            true,
		SessionReplay:           true,
		SecretsManager:          true,
		WebEditor:               true,
		ClientErrorReporting:    true,
		ClientMetrics:           true,
		RemoteSandboxEnabled:    true,
		ApprovalsFlowEnabled:    true,
		DevtoolsSnapshotEnabled: true,
		RunShapeEnabled:         true,
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
	rec := httptest.NewRecorder()
	h.GetFeatureFlags(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp featureFlagsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.True(t, resp.Flags["readout_dashboard"])
	assert.True(t, resp.Flags["landing_queue"])
	assert.True(t, resp.Flags["tool_skills"])
	assert.True(t, resp.Flags["integrations"])
	assert.True(t, resp.Flags["client_error_reporting"])
}

func TestFeatureFlagHandler_GetFeatureFlags_AllDisabled(t *testing.T) {
	t.Parallel()

	h := &FeatureFlagHandler{Config: config.FeatureFlagsConfig{}}

	req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
	rec := httptest.NewRecorder()
	h.GetFeatureFlags(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp featureFlagsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	for key, value := range resp.Flags {
		assert.False(t, value, "expected flag %s to be false", key)
	}
}

func TestFeatureFlagHandler_GetFeatureFlags_PartiallyEnabled(t *testing.T) {
	t.Parallel()

	h := &FeatureFlagHandler{Config: config.FeatureFlagsConfig{
		LandingQueue: true,
		WebEditor:    true,
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
	rec := httptest.NewRecorder()
	h.GetFeatureFlags(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp featureFlagsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.True(t, resp.Flags["landing_queue"])
	assert.True(t, resp.Flags["web_editor"])
	assert.False(t, resp.Flags["readout_dashboard"])
	assert.False(t, resp.Flags["tool_skills"])
}

func TestFeatureFlagHandler_GetFeatureFlags_ContainsAllExpectedFlags(t *testing.T) {
	t.Parallel()

	h := &FeatureFlagHandler{Config: config.FeatureFlagsConfig{}}

	req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
	rec := httptest.NewRecorder()
	h.GetFeatureFlags(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp featureFlagsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))

	expectedFlags := []string{
		"readout_dashboard", "landing_queue", "tool_skills", "tool_policies",
		"repo_snapshots", "integrations", "session_replay", "secrets_manager",
		"web_editor", "client_error_reporting", "client_metrics",
	}
	expectedFlags = append(expectedFlags, rolloutFlagKeys...)
	for _, flag := range expectedFlags {
		_, exists := resp.Flags[flag]
		assert.True(t, exists, "expected flag %s to be present", flag)
	}
}

// TestFeatureFlagHandler_GetFeatureFlags_RolloutFlagsDefaultFalse asserts the
// ticket 0112 default: a zero-valued FeatureFlagsConfig means every rollout
// flag is present in the response and has value false. A missing flag or a
// default-true flag would both fail this test.
func TestFeatureFlagHandler_GetFeatureFlags_RolloutFlagsDefaultFalse(t *testing.T) {
	t.Parallel()

	h := &FeatureFlagHandler{Config: config.FeatureFlagsConfig{}}

	req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
	rec := httptest.NewRecorder()
	h.GetFeatureFlags(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp featureFlagsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	for _, flag := range rolloutFlagKeys {
		val, exists := resp.Flags[flag]
		require.True(t, exists, "rollout flag %s must be present in response", flag)
		assert.False(t, val, "rollout flag %s must default to false", flag)
	}
}

// TestFeatureFlagHandler_GetFeatureFlags_RolloutFlagsReflectConfig asserts each
// rollout flag's value propagates end-to-end from FeatureFlagsConfig into the
// JSON response independently (flipping one does not flip another).
func TestFeatureFlagHandler_GetFeatureFlags_RolloutFlagsReflectConfig(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		cfg     config.FeatureFlagsConfig
		trueKey string
	}{
		{"RemoteSandboxEnabled", config.FeatureFlagsConfig{RemoteSandboxEnabled: true}, "remote_sandbox_enabled"},
		{"ApprovalsFlowEnabled", config.FeatureFlagsConfig{ApprovalsFlowEnabled: true}, "approvals_flow_enabled"},
		{"DevtoolsSnapshotEnabled", config.FeatureFlagsConfig{DevtoolsSnapshotEnabled: true}, "devtools_snapshot_enabled"},
		{"RunShapeEnabled", config.FeatureFlagsConfig{RunShapeEnabled: true}, "run_shape_enabled"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := &FeatureFlagHandler{Config: tc.cfg}
			req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
			rec := httptest.NewRecorder()
			h.GetFeatureFlags(rec, req)

			require.Equal(t, http.StatusOK, rec.Code)
			var resp featureFlagsResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
			for _, flag := range rolloutFlagKeys {
				val, exists := resp.Flags[flag]
				require.True(t, exists, "rollout flag %s must be present", flag)
				if flag == tc.trueKey {
					assert.True(t, val, "flag %s should be true", flag)
				} else {
					assert.False(t, val, "flag %s should remain false", flag)
				}
			}
		})
	}
}

// TestFeatureFlagHandler_GetFeatureFlags_RolloutFlagsEnvOverride verifies the
// ticket 0112 acceptance criterion that each flag's SMITHERS_* env var flips the
// corresponding field in loaded config, which in turn flips the response.
// This test intentionally exercises the real config.Load path so a missing
// BindEnv in config.go would be caught.
func TestFeatureFlagHandler_GetFeatureFlags_RolloutFlagsEnvOverride(t *testing.T) {
	// Cannot run in parallel — mutates process env.
	envByFlag := map[string]string{
		"remote_sandbox_enabled":    "SMITHERS_REMOTE_SANDBOX_ENABLED",
		"approvals_flow_enabled":    "SMITHERS_APPROVALS_FLOW_ENABLED",
		"devtools_snapshot_enabled": "SMITHERS_DEVTOOLS_SNAPSHOT_ENABLED",
		"run_shape_enabled":         "SMITHERS_RUN_SHAPE_ENABLED",
	}
	// Sanity: same flag set as rolloutFlagKeys.
	require.Len(t, envByFlag, len(rolloutFlagKeys))

	for _, flag := range rolloutFlagKeys {
		flag := flag
		t.Run(flag, func(t *testing.T) {
			envVar := envByFlag[flag]
			t.Setenv(envVar, "true")

			cfg, err := config.Load("")
			require.NoError(t, err)

			h := &FeatureFlagHandler{Config: cfg.FeatureFlags}
			req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
			rec := httptest.NewRecorder()
			h.GetFeatureFlags(rec, req)

			require.Equal(t, http.StatusOK, rec.Code)
			var resp featureFlagsResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))

			val, exists := resp.Flags[flag]
			require.True(t, exists, "flag %s must be present", flag)
			assert.True(t, val, "setting %s=true must flip %s in response", envVar, flag)

			// All the other rollout flags should remain at their default (false).
			for _, other := range rolloutFlagKeys {
				if other == flag {
					continue
				}
				otherVal, otherExists := resp.Flags[other]
				require.True(t, otherExists, "flag %s must be present", other)
				assert.False(t, otherVal, "flag %s should still be false when only %s is overridden", other, envVar)
			}
		})
	}
}

// TestFeatureFlagHandler_GetFeatureFlags_MVPGatingFlagsPresent asserts that
// every flag added by ticket 12 (MVP gating) shows up in the response. A
// missing flag breaks clients that switch UI on its presence.
func TestFeatureFlagHandler_GetFeatureFlags_MVPGatingFlagsPresent(t *testing.T) {
	t.Parallel()

	h := &FeatureFlagHandler{Config: config.FeatureFlagsConfig{}}

	req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
	rec := httptest.NewRecorder()
	h.GetFeatureFlags(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp featureFlagsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	for flag := range mvpGatingFlagDefaults {
		_, exists := resp.Flags[flag]
		assert.True(t, exists, "ticket 12 flag %s must be present", flag)
	}
}

// TestFeatureFlagHandler_GetFeatureFlags_MVPGatingFlagsConfigDefaults asserts
// that loading the config without overrides produces the documented defaults
// (core launch families true, everything else false). This pins the contract that
// ticket 12's acceptance criteria depend on.
func TestFeatureFlagHandler_GetFeatureFlags_MVPGatingFlagsConfigDefaults(t *testing.T) {
	// Cannot run in parallel — config.Load reads process env.

	cfg, err := config.Load("")
	require.NoError(t, err)

	h := &FeatureFlagHandler{Config: cfg.FeatureFlags}
	req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
	rec := httptest.NewRecorder()
	h.GetFeatureFlags(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp featureFlagsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	for flag, expected := range mvpGatingFlagDefaults {
		val, exists := resp.Flags[flag]
		require.True(t, exists, "ticket 12 flag %s must be present", flag)
		assert.Equal(t, expected, val, "ticket 12 flag %s default", flag)
	}
}

// TestFeatureFlagHandler_GetFeatureFlags_MVPGatingFlagsReflectConfig asserts
// each ticket-12 flag's value propagates from FeatureFlagsConfig into the
// JSON response independently. This catches typos in the response map keys.
func TestFeatureFlagHandler_GetFeatureFlags_MVPGatingFlagsReflectConfig(t *testing.T) {
	t.Parallel()

	cases := []struct {
		key string
		cfg config.FeatureFlagsConfig
	}{
		{"stacked_prs", config.FeatureFlagsConfig{StackedPRs: true}},
		{"workflows", config.FeatureFlagsConfig{Workflows: true}},
		{"sandboxes", config.FeatureFlagsConfig{Sandboxes: true}},
		{"auto_push", config.FeatureFlagsConfig{AutoPush: true}},
		{"issues", config.FeatureFlagsConfig{Issues: true}},
		{"search", config.FeatureFlagsConfig{Search: true}},
		{"workspaces", config.FeatureFlagsConfig{Workspaces: true}},
		{"agents", config.FeatureFlagsConfig{Agents: true}},
		{"web_dashboard", config.FeatureFlagsConfig{WebDashboard: true}},
		{"protected_bookmarks", config.FeatureFlagsConfig{ProtectedBookmarks: true}},
		{"notifications", config.FeatureFlagsConfig{Notifications: true}},
		{"wiki", config.FeatureFlagsConfig{Wiki: true}},
		{"labels", config.FeatureFlagsConfig{Labels: true}},
		{"releases", config.FeatureFlagsConfig{Releases: true}},
		{"secrets", config.FeatureFlagsConfig{Secrets: true}},
		{"webhooks_user", config.FeatureFlagsConfig{WebhooksUser: true}},
		{"bot_commands", config.FeatureFlagsConfig{BotCommands: true}},
		{"draft_prs", config.FeatureFlagsConfig{DraftPRs: true}},
		{"reviewers", config.FeatureFlagsConfig{Reviewers: true}},
		{"multi_auth", config.FeatureFlagsConfig{MultiAuth: true}},
		{"private_repos", config.FeatureFlagsConfig{PrivateRepos: true}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.key, func(t *testing.T) {
			t.Parallel()
			h := &FeatureFlagHandler{Config: tc.cfg}
			req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
			rec := httptest.NewRecorder()
			h.GetFeatureFlags(rec, req)

			require.Equal(t, http.StatusOK, rec.Code)
			var resp featureFlagsResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
			val, exists := resp.Flags[tc.key]
			require.True(t, exists, "flag %s must be present", tc.key)
			assert.True(t, val, "flag %s should be true when its struct field is true", tc.key)
		})
	}
}

func TestFeatureFlagHandler_GetFeatureFlags_SetsContentType(t *testing.T) {
	t.Parallel()

	h := &FeatureFlagHandler{Config: config.FeatureFlagsConfig{}}

	req := httptest.NewRequest(http.MethodGet, "/api/feature-flags", nil)
	rec := httptest.NewRecorder()
	h.GetFeatureFlags(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
}
