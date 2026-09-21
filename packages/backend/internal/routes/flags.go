package routes

import (
	"encoding/json"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

// FeatureFlagHandler handles GET /api/feature-flags.
// No authentication required (public endpoint).
type FeatureFlagHandler struct {
	Config config.FeatureFlagsConfig
}

// featureFlagsResponse is the JSON response for GET /api/feature-flags.
type featureFlagsResponse struct {
	Flags map[string]bool `json:"flags"`
}

// GetFeatureFlags returns the current feature flag values as JSON.
func (h *FeatureFlagHandler) GetFeatureFlags(w http.ResponseWriter, r *http.Request) {
	resp := featureFlagsResponse{
		Flags: map[string]bool{
			"readout_dashboard":      h.Config.ReadoutDashboard,
			"landing_queue":          h.Config.LandingQueue,
			"tool_skills":            h.Config.ToolSkills,
			"tool_policies":          h.Config.ToolPolicies,
			"repo_snapshots":         h.Config.RepoSnapshots,
			"integrations":           h.Config.Integrations,
			"session_replay":         h.Config.SessionReplay,
			"secrets_manager":        h.Config.SecretsManager,
			"web_editor":             h.Config.WebEditor,
			"client_error_reporting": h.Config.ClientErrorReporting,
			"client_metrics":         h.Config.ClientMetrics,
			// iOS + remote-sandbox rollout flags (ticket 0112).
			// Each one gates the owner ticket referenced in FeatureFlagsConfig.
			"remote_sandbox_enabled":    h.Config.RemoteSandboxEnabled,
			"approvals_flow_enabled":    h.Config.ApprovalsFlowEnabled,
			"devtools_snapshot_enabled": h.Config.DevtoolsSnapshotEnabled,
			"run_shape_enabled":         h.Config.RunShapeEnabled,
			// Ticket 12: MVP gating flags. Core launch families (stacked_prs,
			// workflows, sandboxes, auto_push, secrets) default to true; every
			// other flag defaults to false until that feature ships. The
			// FeatureFlagGate middleware reads these to short-circuit
			// non-MVP route families with 403 "feature not available".
			"stacked_prs":         h.Config.StackedPRs,
			"workflows":           h.Config.Workflows,
			"sandboxes":           h.Config.Sandboxes,
			"auto_push":           h.Config.AutoPush,
			"issues":              h.Config.Issues,
			"search":              h.Config.Search,
			"workspaces":          h.Config.Workspaces,
			"agents":              h.Config.Agents,
			"web_dashboard":       h.Config.WebDashboard,
			"protected_bookmarks": h.Config.ProtectedBookmarks,
			"notifications":       h.Config.Notifications,
			"wiki":                h.Config.Wiki,
			"labels":              h.Config.Labels,
			"releases":            h.Config.Releases,
			"secrets":             h.Config.Secrets,
			"webhooks_user":       h.Config.WebhooksUser,
			"bot_commands":        h.Config.BotCommands,
			"draft_prs":           h.Config.DraftPRs,
			"reviewers":           h.Config.Reviewers,
			"multi_auth":          h.Config.MultiAuth,
			"private_repos":       h.Config.PrivateRepos,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}
