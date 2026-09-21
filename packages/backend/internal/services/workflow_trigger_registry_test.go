package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCollectRegisteredWorkflowTriggers_IncludesSupportedEvents(t *testing.T) {
	t.Parallel()

	cfg := &WorkflowConfig{
		On: WorkflowOnConfig{
			Push:              &PushTrigger{},
			PullRequest:       &ActionTypeTrigger{Types: []string{"opened", "synchronize"}},
			PullRequestReview: &ActionTypeTrigger{},
			CheckSuite:        &ActionTypeTrigger{Types: []string{"requested"}},
			CheckRun:          &ActionTypeTrigger{},
			Issues:            &IssueTrigger{Types: []string{"opened", "edited"}},
			IssueComment:      &IssueCommentTrigger{Types: []string{"created"}},
			StackSubmit:       &StackSubmitTrigger{},
			WorkflowDispatch:  &WorkflowDispatchTrigger{},
			Schedule:          []ScheduleTrigger{{Cron: "0 0 * * *"}},
		},
	}

	triggers := collectRegisteredWorkflowTriggers(cfg)
	assert.ElementsMatch(t, []RegisteredWorkflowTrigger{
		{EventType: "check_run", EventAction: ""},
		{EventType: "check_suite", EventAction: "requested"},
		{EventType: "issue", EventAction: "opened"},
		{EventType: "issue", EventAction: "edited"},
		{EventType: "issue_comment", EventAction: "created"},
		{EventType: "manual", EventAction: ""},
		{EventType: "pull_request", EventAction: "opened"},
		{EventType: "pull_request", EventAction: "synchronize"},
		{EventType: "pull_request_review", EventAction: ""},
		{EventType: "push", EventAction: ""},
		{EventType: "schedule", EventAction: ""},
		{EventType: "stack_submit", EventAction: ""},
	}, triggers)
}

func TestCollectRegisteredWorkflowTriggers_IssuesRequireExplicitDeclaration(t *testing.T) {
	t.Parallel()

	assert.Empty(t, collectRegisteredWorkflowTriggers(nil))
	assert.Empty(t, collectRegisteredWorkflowTriggers(&WorkflowConfig{}))
	assert.Equal(t, []RegisteredWorkflowTrigger{{EventType: "manual"}}, collectRegisteredWorkflowTriggers(&WorkflowConfig{
		On: WorkflowOnConfig{Manual: &ManualTrigger{}},
	}))
	assert.Equal(t, []RegisteredWorkflowTrigger{{EventType: "issue", EventAction: "opened"}}, collectRegisteredWorkflowTriggers(&WorkflowConfig{
		On: WorkflowOnConfig{
			Issue:  &IssueTrigger{Types: []string{" OPENED "}},
			Issues: &IssueTrigger{Types: []string{"opened"}},
		},
	}))
	assert.Equal(t, []RegisteredWorkflowTrigger{{EventType: "issue"}}, collectRegisteredWorkflowTriggers(&WorkflowConfig{
		On: WorkflowOnConfig{Issue: &IssueTrigger{}},
	}))
	assert.Equal(t, []RegisteredWorkflowTrigger{{EventType: "issue_comment"}}, collectRegisteredWorkflowTriggers(&WorkflowConfig{
		On: WorkflowOnConfig{IssueComment: &IssueCommentTrigger{}},
	}))
	for _, event := range []string{"issue.opened", "issues.opened", "issue_comment.created"} {
		triggers := collectRegisteredWorkflowTriggers(&WorkflowConfig{On: WorkflowOnConfig{
			Webhook: &WebhookTrigger{Event: event},
		}})
		assert.Len(t, triggers, 1, event)
	}
}

func TestCollectRegisteredWorkflowTriggers_WebhookDescriptorParsing(t *testing.T) {
	t.Parallel()

	cfg := &WorkflowConfig{
		On: WorkflowOnConfig{
			Webhook: &WebhookTrigger{Event: "pull_request.opened"},
		},
	}

	triggers := collectRegisteredWorkflowTriggers(cfg)
	assert.Equal(t, []RegisteredWorkflowTrigger{{EventType: "pull_request", EventAction: "opened"}}, triggers)
}

func TestCollectRegisteredWorkflowTriggers_IgnoresUnsupportedWebhookDescriptor(t *testing.T) {
	t.Parallel()

	cfg := &WorkflowConfig{
		On: WorkflowOnConfig{
			Webhook: &WebhookTrigger{Event: "release.published"},
		},
	}

	triggers := collectRegisteredWorkflowTriggers(cfg)
	assert.Empty(t, triggers)
}
