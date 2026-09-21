package services

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─── MatchTrigger (config JSON → event matching) ──────────────────────────────

func TestMatchTrigger_EmptyConfig_NoMatch(t *testing.T) {
	t.Parallel()
	matched, err := MatchTrigger(nil, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_InvalidJSON_ReturnsError(t *testing.T) {
	t.Parallel()
	_, err := MatchTrigger(json.RawMessage(`{bad json`), TriggerEvent{Type: "push", Ref: "main"})
	require.Error(t, err)
}

func TestMatchTrigger_PushEvent_NoBranchFilter_MatchesAny(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, matched, "push trigger with no branches should match any branch")
}

func TestMatchTrigger_PushEvent_BranchExact_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"branches":["main"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_PushEvent_BookmarkExact_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"bookmarks":["main"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_PushEvent_BookmarkExact_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"bookmarks":["main"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "feature-x"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_PushEvent_BranchExact_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"branches":["main"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "feature-x"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_PushEvent_BranchGlob_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"branches":["feature/*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "feature/my-branch"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_PushEvent_BranchGlob_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"branches":["feature/*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_PushEvent_MultipleBranchPatterns(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"branches":["main","release/*"]}}}`)

	cases := []struct {
		ref   string
		match bool
	}{
		{"main", true},
		{"release/v1.0", true},
		{"feature/foo", false},
		{"develop", false},
	}
	for _, tc := range cases {
		matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: tc.ref})
		require.NoError(t, err)
		assert.Equal(t, tc.match, matched, "ref=%s", tc.ref)
	}
}

func TestMatchTrigger_PushEvent_BranchIgnore_Excluded(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"branches-ignore":["dependabot/*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "dependabot/npm-fix"})
	require.NoError(t, err)
	assert.False(t, matched, "branch-ignore pattern should exclude the branch")
}

func TestMatchTrigger_PushEvent_BranchIgnore_NotExcluded(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"branches-ignore":["dependabot/*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, matched, "non-ignored branch should match")
}

func TestMatchTrigger_PushEvent_RefsHeadsPrefix_Normalized(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"branches":["main"]}}}`)
	// Refs may come with the full git ref prefix
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "refs/heads/main"})
	require.NoError(t, err)
	assert.True(t, matched, "refs/heads/ prefix should be stripped before matching")
}

func TestMatchTrigger_PushEvent_TagsFilter_MatchesTag(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"tags":["v*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "refs/tags/v1.0.0"})
	require.NoError(t, err)
	assert.True(t, matched, "tag ref matching v* should match")
}

func TestMatchTrigger_PushEvent_TagsFilter_NoMatchNonTag(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{"tags":["v*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.False(t, matched, "non-tag push should not match tag trigger")
}

func TestMatchTrigger_PushEvent_NoPushTrigger_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"landing_request":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.False(t, matched, "push event should not match when only landing_request trigger is set")
}

// ─── Issue trigger matching ──────────────────────────────────────────────────

func TestMatchTrigger_Issue_NoTypes_MatchesAnyAction(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issue":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Issue_TypesFilter_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issue":{"types":["opened","edited"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue", Action: "edited"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Issue_TypesFilter_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issue":{"types":["opened"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue", Action: "closed"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_Issue_WebhookAliasIssues_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issue":{"types":["opened"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issues", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, matched, "issues webhook event type should normalize to issue trigger")
}

func TestMatchTrigger_Issue_NoTrigger_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue", Action: "opened"})
	require.NoError(t, err)
	assert.False(t, matched)
}

// ─── LandingRequest trigger matching ─────────────────────────────────────────

func TestMatchTrigger_LandingRequest_NoTypes_MatchesAnyAction(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"landing_request":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_LandingRequest_TypesFilter_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"landing_request":{"types":["opened","synchronize"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_LandingRequest_TypesFilter_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"landing_request":{"types":["opened"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "closed"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_LandingRequest_TypesCaseInsensitive(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"landing_request":{"types":["Opened"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, matched, "type matching should be case-insensitive")
}

func TestMatchTrigger_LandingRequest_NoTrigger_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "opened"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_WorkflowRun_WorkflowNamesCaseInsensitive(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_run":{"workflows":["ci"],"types":["completed"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{
		Type:           "workflow_run",
		Action:         "completed",
		SourceWorkflow: "CI",
	})
	require.NoError(t, err)
	assert.True(t, matched)
}

// ─── Issues trigger matching ────────────────────────────────────────────────

func TestMatchTrigger_Issues_NoTypes_MatchesAnyAction(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issues":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issues", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Issues_TypesFilter_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issues":{"types":["opened","labeled"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issues", Action: "labeled"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Issues_TypesFilter_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issues":{"types":["opened"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issues", Action: "closed"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_Issues_TypesCaseInsensitive(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issues":{"types":["Assigned"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issues", Action: "assigned"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Issues_NoTrigger_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issues", Action: "opened"})
	require.NoError(t, err)
	assert.False(t, matched)
}

// ─── IssueComment trigger matching ──────────────────────────────────────────

func TestMatchTrigger_IssueComment_NoTypes_MatchesAnyAction(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issue_comment":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue_comment", Action: "created"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_IssueComment_TypesFilter_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issue_comment":{"types":["created","edited"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue_comment", Action: "edited"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_IssueComment_TypesFilter_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"issue_comment":{"types":["created"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue_comment", Action: "deleted"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_IssueComment_NoTrigger_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue_comment", Action: "created"})
	require.NoError(t, err)
	assert.False(t, matched)
}

// ─── Release trigger matching ────────────────────────────────────────────────

func TestMatchTrigger_Release_NoTypesOrTags_MatchesAnyRelease(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"release":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "release", Ref: "v1.2.3", Action: "published"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Release_TypesFilter_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"release":{"types":["published","deleted"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "release", Ref: "v1.2.3", Action: "published"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Release_TypesFilter_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"release":{"types":["deleted"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "release", Ref: "v1.2.3", Action: "updated"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_Release_TagsFilter_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"release":{"tags":["v*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "release", Ref: "refs/tags/v1.2.3", Action: "published"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Release_TagsFilter_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"release":{"tags":["v*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "release", Ref: "refs/tags/build-123", Action: "published"})
	require.NoError(t, err)
	assert.False(t, matched)
}

// ─── Schedule trigger matching ────────────────────────────────────────────────

func TestMatchTrigger_Schedule_WithCron_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"schedule":[{"cron":"0 * * * *"}]}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "schedule"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_Schedule_EmptySchedule_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"schedule":[]}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "schedule"})
	require.NoError(t, err)
	assert.False(t, matched, "empty schedule list should not match")
}

func TestMatchTrigger_Schedule_NoPushTriggerOnSchedule(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"schedule":[{"cron":"0 * * * *"}]}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.False(t, matched, "push event should not match schedule trigger")
}

// ─── WorkflowRun trigger matching ────────────────────────────────────────────

func TestMatchTrigger_WorkflowRun_MatchesConfiguredWorkflowAndType(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_run":{"workflows":["CI"],"types":["completed"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{
		Type:           "workflow_run",
		Action:         "completed",
		SourceWorkflow: "CI",
	})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_WorkflowRun_RejectsDifferentWorkflow(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_run":{"workflows":["CI"],"types":["completed"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{
		Type:           "workflow_run",
		Action:         "completed",
		SourceWorkflow: "Deploy",
	})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_WorkflowRun_RejectsDifferentType(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_run":{"workflows":["CI"],"types":["completed"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{
		Type:           "workflow_run",
		Action:         "queued",
		SourceWorkflow: "CI",
	})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_WorkflowRun_NoTrigger_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "workflow_run"})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_WorkflowArtifact_MatchesConfiguredWorkflowAndName(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_artifact":{"workflows":["Research"],"names":["research-*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{
		Type:           "workflow_artifact",
		Action:         "ready",
		ArtifactName:   "research-notes.md",
		SourceWorkflow: "Research",
	})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_WorkflowArtifact_RejectsDifferentWorkflow(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_artifact":{"workflows":["Research"],"names":["research-*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{
		Type:           "workflow_artifact",
		Action:         "ready",
		ArtifactName:   "research-notes.md",
		SourceWorkflow: "Plan",
	})
	require.NoError(t, err)
	assert.False(t, matched)
}

func TestMatchTrigger_WorkflowArtifact_RejectsDifferentArtifactName(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_artifact":{"workflows":["Research"],"names":["research-*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{
		Type:           "workflow_artifact",
		Action:         "ready",
		ArtifactName:   "plan.md",
		SourceWorkflow: "Research",
	})
	require.NoError(t, err)
	assert.False(t, matched)
}

// ─── UnknownEventType ─────────────────────────────────────────────────────────

func TestMatchTrigger_UnknownEventType_NoMatch(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "unknown_event"})
	require.NoError(t, err)
	assert.False(t, matched, "unknown event types should never match")
}

// ─── Glob matching edge cases ─────────────────────────────────────────────────

func TestGlobMatch_ExactMatch(t *testing.T) {
	t.Parallel()
	assert.True(t, globMatch("main", "main"))
	assert.False(t, globMatch("main", "master"))
}

func TestGlobMatch_StarMatchesAnything(t *testing.T) {
	t.Parallel()
	assert.True(t, globMatch("feature/*", "feature/foo"))
	assert.True(t, globMatch("feature/*", "feature/bar-baz"))
	assert.False(t, globMatch("feature/*", "feature/foo/nested"))
	assert.False(t, globMatch("feature/*", "main"))
}

func TestGlobMatch_DoubleStarMatchesNestedPaths(t *testing.T) {
	t.Parallel()
	assert.True(t, globMatch("**", "feature/foo/nested"))
	assert.True(t, globMatch("feature/**", "feature/foo/nested"))
}

func TestGlobMatch_StarAtEnd(t *testing.T) {
	t.Parallel()
	assert.True(t, globMatch("release/*", "release/v1.0"))
	assert.True(t, globMatch("v*", "v1.0.0"))
	assert.False(t, globMatch("v*", "1.0.0"))
}

func TestGlobMatch_EmptyPattern(t *testing.T) {
	t.Parallel()
	assert.True(t, globMatch("", ""))
	assert.False(t, globMatch("", "main"))
}

func TestGlobMatch_EmptyStr(t *testing.T) {
	t.Parallel()
	assert.False(t, globMatch("main", ""))
	assert.True(t, globMatch("*", ""))
}

func TestGlobMatch_ManyDoubleStarsNoBacktrackingBlowup(t *testing.T) {
	t.Parallel()
	// A recursive backtracking matcher is O(n^k) on k '**' segments and would
	// effectively hang on this input; the DP matcher must answer immediately.
	pattern := strings.Repeat("**a", 16) + "**b"
	str := strings.Repeat("a", 64)
	assert.False(t, globMatch(pattern, str))
	assert.True(t, globMatch(pattern, str+"b"))
	assert.True(t, globMatch(strings.Repeat("**a", 16)+"**", str))
}

func TestGlobMatch_MixedStarKinds(t *testing.T) {
	t.Parallel()
	assert.True(t, globMatch("release/**/v*", "release/2026/07/v1.2"))
	assert.False(t, globMatch("release/**/v*", "release/2026/07/1.2"))
	assert.False(t, globMatch("feature/*-ci", "feature/a/b-ci"))
	assert.True(t, globMatch("***", "a/b"), "'**' followed by '*' still matches across slashes then non-slash tail")
}

// ─── ParseWorkflowTriggerConfig ───────────────────────────────────────────────

func TestParseWorkflowTriggerConfig_FullConfig(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{
		"on": {
			"push": { "branches": ["main", "feature/*"], "branches-ignore": ["dependabot/*"] },
			"issue": { "types": ["opened", "edited"] },
			"landing_request": { "types": ["opened", "synchronize"] },
			"schedule": [{ "cron": "0 6 * * 1" }]
		},
		"jobs": { "build": {} }
	}`)

	var cfg WorkflowTriggerConfig
	err := json.Unmarshal(raw, &cfg)
	require.NoError(t, err)

	require.NotNil(t, cfg.On.Push)
	assert.Equal(t, []string{"main", "feature/*"}, cfg.On.Push.Branches)
	assert.Equal(t, []string{"dependabot/*"}, cfg.On.Push.BranchesIgnore)

	require.NotNil(t, cfg.On.Issue)
	assert.Equal(t, []string{"opened", "edited"}, cfg.On.Issue.Types)

	require.NotNil(t, cfg.On.LandingRequest)
	assert.Equal(t, []string{"opened", "synchronize"}, cfg.On.LandingRequest.Types)

	require.Len(t, cfg.On.Schedule, 1)
	assert.Equal(t, "0 6 * * 1", cfg.On.Schedule[0].Cron)

	assert.NotNil(t, cfg.Jobs)
}

func TestParseWorkflowTriggerConfig_EmptyOn(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{"on":{}}`)
	var cfg WorkflowTriggerConfig
	err := json.Unmarshal(raw, &cfg)
	require.NoError(t, err)
	assert.Nil(t, cfg.On.Push)
	assert.Nil(t, cfg.On.Issue)
	assert.Nil(t, cfg.On.LandingRequest)
	assert.Empty(t, cfg.On.Schedule)
}

func TestParseWorkflowTriggerConfig_WithIssueAndCommentTriggers(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{
		"on": {
			"issues": { "types": ["opened", "labeled"] },
			"issue_comment": { "types": ["created", "deleted"] }
		}
	}`)

	var cfg WorkflowTriggerConfig
	err := json.Unmarshal(raw, &cfg)
	require.NoError(t, err)

	require.NotNil(t, cfg.On.Issues)
	assert.Equal(t, []string{"opened", "labeled"}, cfg.On.Issues.Types)

	require.NotNil(t, cfg.On.IssueComment)
	assert.Equal(t, []string{"created", "deleted"}, cfg.On.IssueComment.Types)
}

// ─── Combined trigger scenarios ───────────────────────────────────────────────

func TestMatchTrigger_MultipleTriggersInConfig_PushMatchesWhenPushSet(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{
		"on": {
			"push": { "branches": ["main"] },
			"issue": { "types": ["opened"] },
			"landing_request": { "types": ["opened"] }
		}
	}`)

	pushMatched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, pushMatched)

	issueMatched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, issueMatched)

	lrMatched, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, lrMatched)

	lrNoMatch, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "closed"})
	require.NoError(t, err)
	assert.False(t, lrNoMatch)
}

func TestMatchTrigger_MultipleTriggersIncludingIssues(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{
		"on": {
			"push": { "branches": ["main"] },
			"issues": { "types": ["opened", "labeled"] },
			"issue_comment": { "types": ["created"] }
		}
	}`)

	pushMatched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, pushMatched)

	issueMatched, err := MatchTrigger(cfg, TriggerEvent{Type: "issues", Action: "labeled"})
	require.NoError(t, err)
	assert.True(t, issueMatched)

	commentMatched, err := MatchTrigger(cfg, TriggerEvent{Type: "issue_comment", Action: "created"})
	require.NoError(t, err)
	assert.True(t, commentMatched)

	commentNoMatch, err := MatchTrigger(cfg, TriggerEvent{Type: "issue_comment", Action: "deleted"})
	require.NoError(t, err)
	assert.False(t, commentNoMatch)
}

func TestMatchTrigger_EventTypeCaseInsensitive(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"push":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "PUSH", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, matched, "event type matching should be case-insensitive")
}

// ─── workflow_dispatch trigger matching ───────────────────────────────────────

func TestMatchTrigger_WorkflowDispatch_Configured_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_dispatch":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "workflow_dispatch", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, matched, "workflow_dispatch event should match when on.workflow_dispatch is configured")
}

func TestMatchTrigger_WorkflowDispatch_NotConfigured_NoMatch(t *testing.T) {
	t.Parallel()
	// Workflow with only push trigger should not match workflow_dispatch events
	cfg := json.RawMessage(`{"on":{"push":{"branches":["main"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "workflow_dispatch", Ref: "main"})
	require.NoError(t, err)
	assert.False(t, matched, "workflow_dispatch should not match when only push trigger is configured")
}

func TestMatchTrigger_WorkflowDispatch_DoesNotMatchPushTrigger(t *testing.T) {
	t.Parallel()
	// workflow_dispatch events should not inadvertently match push triggers.
	cfg := json.RawMessage(`{"on":{"push":{"branches":["main"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "workflow_dispatch", Ref: "main"})
	require.NoError(t, err)
	assert.False(t, matched, "workflow_dispatch should not match push trigger")
}

func TestMatchTrigger_WorkflowDispatch_CaseInsensitive(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_dispatch":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "WORKFLOW_DISPATCH", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, matched, "event type matching should be case-insensitive")
}

func TestMatchTrigger_PullRequest_TypesFilter_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"pull_request":{"types":["opened","synchronize"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "pull_request", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_PullRequest_DottedEventType_UsesActionSuffix(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"pull_request":{"types":["opened"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "pull_request.opened"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_StackSubmit_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"stack_submit":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "stack_submit"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_ManualEvent_MatchesWorkflowDispatchAlias(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_dispatch":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "manual"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_WebhookDescriptor_MatchesPullRequestOpened(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"webhook":{"event":"pull_request.opened"}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "pull_request", Action: "opened"})
	require.NoError(t, err)
	assert.True(t, matched)
}

// ─── Additional push trigger edge cases ───────────────────────────────────────

func TestMatchTrigger_PushEvent_RefsTagsPrefix_Normalized(t *testing.T) {
	t.Parallel()
	// refs/tags/ prefix should be stripped when matching tag patterns.
	cfg := json.RawMessage(`{"on":{"push":{"tags":["v*"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "refs/tags/v1.0.0"})
	require.NoError(t, err)
	assert.True(t, matched, "refs/tags/ prefix should be stripped for tag matching")
}

func TestMatchTrigger_PushEvent_BranchIgnoreWithGlob_ExcludesMatching(t *testing.T) {
	t.Parallel()
	// branches-ignore with glob should exclude matching branches regardless of branches list.
	cfg := json.RawMessage(`{"on":{"push":{"branches":["**"],"branches-ignore":["dependabot/**"]}}}`)
	// dependabot branch should be excluded
	excluded, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "dependabot/npm_and_yarn/lodash-4.17.21"})
	require.NoError(t, err)
	assert.False(t, excluded, "dependabot branches should be excluded by branches-ignore")
	// non-dependabot branch should match
	included, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "feature/new-feature"})
	require.NoError(t, err)
	assert.True(t, included, "non-excluded branches should match")
}

func TestMatchTrigger_PushEvent_OnlyBranchesIgnoreNoAllowList_MatchesNonIgnored(t *testing.T) {
	t.Parallel()
	// branches-ignore without branches allowlist means match all except ignored.
	cfg := json.RawMessage(`{"on":{"push":{"branches-ignore":["docs/**"]}}}`)
	// docs branch should be excluded
	excluded, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "docs/update-readme"})
	require.NoError(t, err)
	assert.False(t, excluded, "docs branches should be excluded")
	// main should still match
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "push", Ref: "main"})
	require.NoError(t, err)
	assert.True(t, matched, "main should match when not in branches-ignore")
}

// ─── LandingRequest additional edge cases ────────────────────────────────────

func TestMatchTrigger_LandingRequest_SynchronizeAction_Matches(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"landing_request":{"types":["opened","synchronize","reopened"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "synchronize"})
	require.NoError(t, err)
	assert.True(t, matched)
}

func TestMatchTrigger_LandingRequest_MergedAction_NoMatch(t *testing.T) {
	t.Parallel()
	// "merged" action not in types list should not match.
	cfg := json.RawMessage(`{"on":{"landing_request":{"types":["opened","synchronize"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "landing_request", Action: "merged"})
	require.NoError(t, err)
	assert.False(t, matched, "merged action not in types should not match")
}

// ─── Schedule trigger edge cases ─────────────────────────────────────────────

func TestMatchTrigger_Schedule_MultipleCrons_Matches(t *testing.T) {
	t.Parallel()
	// Multiple schedule entries all trigger on schedule event.
	cfg := json.RawMessage(`{"on":{"schedule":[{"cron":"0 6 * * 1"},{"cron":"0 12 * * *"}]}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "schedule"})
	require.NoError(t, err)
	assert.True(t, matched, "schedule event should match when schedule triggers are configured")
}

func TestMatchTrigger_Schedule_ScheduleEventDoesNotMatchPush(t *testing.T) {
	t.Parallel()
	// A schedule event should not match a push-only workflow.
	cfg := json.RawMessage(`{"on":{"push":{"branches":["main"]}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "schedule"})
	require.NoError(t, err)
	assert.False(t, matched, "schedule event should not match push-only trigger")
}

// ─── WorkflowRun trigger types filter ────────────────────────────────────────

func TestMatchTrigger_WorkflowRun_EmptyFiltersMatchAnyWorkflowRunEvent(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_run":{}}}`)
	matched, err := MatchTrigger(cfg, TriggerEvent{Type: "workflow_run", Action: "completed", SourceWorkflow: "CI"})
	require.NoError(t, err)
	assert.True(t, matched, "workflow_run event should match when no workflow_run filters are configured")
}

// ─── Glob edge cases ─────────────────────────────────────────────────────────

func TestGlobMatch_DoubleStar_MatchesEmptyPath(t *testing.T) {
	t.Parallel()
	// ** should match empty string too (i.e., the root).
	assert.True(t, globMatch("**", ""))
}

func TestGlobMatch_StarDoesNotMatchSlash(t *testing.T) {
	t.Parallel()
	// * should not match across directory boundaries.
	assert.False(t, globMatch("feature/*", "feature/sub/branch"))
}

func TestGlobMatch_PrefixBeforeStar(t *testing.T) {
	t.Parallel()
	// Prefix before * must match.
	assert.True(t, globMatch("release/v*", "release/v2.0.0"))
	assert.False(t, globMatch("release/v*", "release/2.0.0"))
}
