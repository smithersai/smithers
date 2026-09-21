package services

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkflowTrigger_Cov_MatchAndWebhookFallbackBranches(t *testing.T) {
	_, err := MatchTrigger(json.RawMessage(`{"on":`), TriggerEvent{Type: "push"})
	require.Error(t, err)

	matched := matchesOn(WorkflowOnConfig{Webhook: &WebhookTrigger{Event: "pull_request.opened"}}, TriggerEvent{
		Type:   "pull_request",
		Action: "OPENED",
	})
	assert.True(t, matched)

	matched = matchesOn(WorkflowOnConfig{Webhook: &WebhookTrigger{Event: "pull_request"}}, TriggerEvent{
		Type:   "pull_request",
		Action: "synchronize",
	})
	assert.True(t, matched)

	matched = matchesOn(WorkflowOnConfig{Webhook: &WebhookTrigger{Event: "issues.closed"}}, TriggerEvent{
		Type:   "issue",
		Action: "opened",
	})
	assert.False(t, matched)
}

func TestWorkflowTrigger_Cov_PushWorkflowArtifactAndNormalizeBranches(t *testing.T) {
	assert.False(t, matchesPush(PushTrigger{Branches: []string{"main"}}, "refs/tags/v1.0.0"))
	assert.True(t, matchesPush(PushTrigger{Tags: []string{"v*"}}, "refs/tags/v1.0.0"))
	assert.False(t, matchesPush(PushTrigger{Tags: []string{"v*"}}, "refs/heads/main"))
	assert.False(t, matchesPush(PushTrigger{BranchesIgnore: []string{"release/*"}}, "refs/heads/release/1"))
	assert.True(t, matchesPush(PushTrigger{Bookmarks: []string{"feat/*"}}, "feat/demo"))

	assert.True(t, matchesWorkflowArtifact(WorkflowArtifactTrigger{
		Workflows: []string{"Build*"},
		Names:     []string{"dist/**"},
	}, TriggerEvent{SourceWorkflow: "build-linux", ArtifactName: "dist/linux/app"}))
	assert.False(t, matchesWorkflowArtifact(WorkflowArtifactTrigger{
		Workflows: []string{"Build*"},
		Names:     []string{"dist/*.zip"},
	}, TriggerEvent{SourceWorkflow: "build-linux", ArtifactName: "dist/linux/app"}))

	assert.Equal(t, "workflow_dispatch", normalizeTriggerName(" manual_dispatch "))
	assert.Equal(t, "issue", normalizeTriggerName("issues"))

	event := normalizeTriggerEvent(TriggerEvent{Type: "release.PUBLISHED"})
	assert.Equal(t, "release", event.Type)
	assert.Equal(t, "published", event.Action)

	event = normalizeTriggerEvent(TriggerEvent{Type: "release.PUBLISHED", Action: "deleted"})
	assert.Equal(t, "release", event.Type)
	assert.Equal(t, "deleted", event.Action)

	eventType, eventAction := parseWebhookDescriptor("issues")
	assert.Equal(t, "issue", eventType)
	assert.Empty(t, eventAction)
}
