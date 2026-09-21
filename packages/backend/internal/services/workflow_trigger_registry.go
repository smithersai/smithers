package services

import (
	"sort"
	"strings"
)

// RegisteredWorkflowTrigger is the normalized event/action mapping persisted in
// workflow_triggers for fast event-to-workflow lookup.
type RegisteredWorkflowTrigger struct {
	EventType   string
	EventAction string
}

var supportedRegisteredWorkflowEvents = map[string]struct{}{
	"push":                {},
	"pull_request":        {},
	"pull_request_review": {},
	"check_suite":         {},
	"check_run":           {},
	"issue":               {},
	"issue_comment":       {},
	"stack_submit":        {},
	"schedule":            {},
	"manual":              {},
}

func collectRegisteredWorkflowTriggers(cfg *WorkflowConfig) []RegisteredWorkflowTrigger {
	if cfg == nil {
		return nil
	}

	unique := map[string]RegisteredWorkflowTrigger{}
	add := func(eventType, eventAction string) {
		normalizedType := normalizeRegisteredEventType(eventType)
		if normalizedType == "" {
			return
		}
		normalizedAction := strings.ToLower(strings.TrimSpace(eventAction))
		key := normalizedType + "\x00" + normalizedAction
		unique[key] = RegisteredWorkflowTrigger{EventType: normalizedType, EventAction: normalizedAction}
	}

	if cfg.On.Push != nil {
		add("push", "")
	}
	if cfg.On.PullRequest != nil {
		if len(cfg.On.PullRequest.Types) == 0 {
			add("pull_request", "")
		} else {
			for _, action := range cfg.On.PullRequest.Types {
				add("pull_request", action)
			}
		}
	}
	if cfg.On.PullRequestReview != nil {
		if len(cfg.On.PullRequestReview.Types) == 0 {
			add("pull_request_review", "")
		} else {
			for _, action := range cfg.On.PullRequestReview.Types {
				add("pull_request_review", action)
			}
		}
	}
	if cfg.On.CheckSuite != nil {
		if len(cfg.On.CheckSuite.Types) == 0 {
			add("check_suite", "")
		} else {
			for _, action := range cfg.On.CheckSuite.Types {
				add("check_suite", action)
			}
		}
	}
	if cfg.On.CheckRun != nil {
		if len(cfg.On.CheckRun.Types) == 0 {
			add("check_run", "")
		} else {
			for _, action := range cfg.On.CheckRun.Types {
				add("check_run", action)
			}
		}
	}
	// `issue` and GitHub's `issues` spelling describe the same event. Only
	// explicit declarations enter the registry; ordinary/manual workflows do
	// not acquire issue handling when support for these events is added.
	for _, trigger := range []*IssueTrigger{cfg.On.Issue, cfg.On.Issues} {
		if trigger == nil {
			continue
		}
		if len(trigger.Types) == 0 {
			add("issue", "")
		} else {
			for _, action := range trigger.Types {
				add("issue", action)
			}
		}
	}
	if cfg.On.IssueComment != nil {
		if len(cfg.On.IssueComment.Types) == 0 {
			add("issue_comment", "")
		} else {
			for _, action := range cfg.On.IssueComment.Types {
				add("issue_comment", action)
			}
		}
	}
	if cfg.On.StackSubmit != nil {
		add("stack_submit", "")
	}
	if len(cfg.On.Schedule) > 0 {
		add("schedule", "")
	}
	if cfg.On.WorkflowDispatch != nil || cfg.On.Manual != nil {
		add("manual", "")
	}
	if cfg.On.Webhook != nil {
		eventType, eventAction := parseWebhookDescriptor(cfg.On.Webhook.Event)
		if eventType != "" {
			if eventType == "workflow_dispatch" {
				eventType = "manual"
			}
			add(eventType, eventAction)
		}
	}

	result := make([]RegisteredWorkflowTrigger, 0, len(unique))
	for _, trigger := range unique {
		result = append(result, trigger)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].EventType == result[j].EventType {
			return result[i].EventAction < result[j].EventAction
		}
		return result[i].EventType < result[j].EventType
	})
	return result
}

func normalizeRegisteredEventType(eventType string) string {
	normalized := NormalizeTriggerName(eventType)
	if normalized == "workflow_dispatch" {
		normalized = "manual"
	}
	if _, ok := supportedRegisteredWorkflowEvents[normalized]; !ok {
		return ""
	}
	return normalized
}
