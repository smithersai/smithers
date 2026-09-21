package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestWorkflowTriggerRegistry_Z_EmptyTypesAndWebhookBranches(t *testing.T) {
	cfg := &WorkflowConfig{}
	cfg.On.PullRequest = &ActionTypeTrigger{}
	cfg.On.PullRequestReview = &ActionTypeTrigger{Types: []string{"submitted"}}
	cfg.On.CheckSuite = &ActionTypeTrigger{}
	cfg.On.CheckRun = &ActionTypeTrigger{Types: []string{"Completed"}}
	cfg.On.WorkflowDispatch = &WorkflowDispatchTrigger{}
	cfg.On.Webhook = &WebhookTrigger{Event: "workflow_dispatch"}

	triggers := collectRegisteredWorkflowTriggers(cfg)
	assert.Contains(t, triggers, RegisteredWorkflowTrigger{EventType: "pull_request"})
	assert.Contains(t, triggers, RegisteredWorkflowTrigger{EventType: "pull_request_review", EventAction: "submitted"})
	assert.Contains(t, triggers, RegisteredWorkflowTrigger{EventType: "check_suite"})
	assert.Contains(t, triggers, RegisteredWorkflowTrigger{EventType: "check_run", EventAction: "completed"})
	assert.Contains(t, triggers, RegisteredWorkflowTrigger{EventType: "manual"})
}
