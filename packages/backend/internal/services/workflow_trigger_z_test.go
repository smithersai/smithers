package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestWorkflowTrigger_Z_MatchesOnWebhookArtifactAndGlobBranches(t *testing.T) {
	t.Parallel()

	assert.True(t, matchesOn(WorkflowOnConfig{
		PullRequestReview: &ActionTypeTrigger{Types: []string{"submitted"}},
	}, TriggerEvent{Type: "pull_request_review", Action: "submitted"}))
	assert.True(t, matchesOn(WorkflowOnConfig{
		CheckSuite: &ActionTypeTrigger{Types: []string{"completed"}},
	}, TriggerEvent{Type: "check_suite", Action: "completed"}))
	assert.True(t, matchesOn(WorkflowOnConfig{
		CheckRun: &ActionTypeTrigger{Types: []string{"created"}},
	}, TriggerEvent{Type: "check_run", Action: "created"}))

	assert.False(t, matchesOn(WorkflowOnConfig{
		Webhook: &WebhookTrigger{Event: "pull_request.opened"},
	}, TriggerEvent{Type: "issues", Action: "opened"}))

	assert.True(t, matchesWorkflowArtifact(WorkflowArtifactTrigger{}, TriggerEvent{SourceWorkflow: "Build", ArtifactName: "dist"}))
	assert.False(t, matchesWorkflowNames([]string{"build"}, " "))
	assert.False(t, globMatch("src/**/test", "src/pkg/nope"))
}
