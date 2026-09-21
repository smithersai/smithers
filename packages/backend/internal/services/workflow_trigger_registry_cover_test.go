package services

import "testing"

func TestWorkflowTriggerRegistry_Cov_CollectDedupSortAndNormalize(t *testing.T) {
	if got := collectRegisteredWorkflowTriggers(nil); got != nil {
		t.Fatalf("nil cfg triggers = %+v", got)
	}

	cfg := &WorkflowConfig{On: WorkflowOnConfig{
		Push:              &PushTrigger{},
		PullRequest:       &ActionTypeTrigger{Types: []string{"Opened", "closed", "opened"}},
		PullRequestReview: &ActionTypeTrigger{},
		CheckSuite:        &ActionTypeTrigger{Types: []string{"completed"}},
		CheckRun:          &ActionTypeTrigger{},
		StackSubmit:       &StackSubmitTrigger{},
		Schedule:          []ScheduleTrigger{{Cron: "* * * * *"}},
		WorkflowDispatch:  &WorkflowDispatchTrigger{},
		Webhook:           &WebhookTrigger{Event: "workflow_dispatch"},
	}}
	triggers := collectRegisteredWorkflowTriggers(cfg)
	want := []RegisteredWorkflowTrigger{
		{EventType: "check_run"},
		{EventType: "check_suite", EventAction: "completed"},
		{EventType: "manual"},
		{EventType: "pull_request", EventAction: "closed"},
		{EventType: "pull_request", EventAction: "opened"},
		{EventType: "pull_request_review"},
		{EventType: "push"},
		{EventType: "schedule"},
		{EventType: "stack_submit"},
	}
	if len(triggers) != len(want) {
		t.Fatalf("triggers = %+v, want %+v", triggers, want)
	}
	for i := range want {
		if triggers[i] != want[i] {
			t.Fatalf("triggers[%d] = %+v, want %+v (all=%+v)", i, triggers[i], want[i], triggers)
		}
	}
}

func TestWorkflowTriggerRegistry_Cov_NormalizeRegisteredEventType(t *testing.T) {
	cases := map[string]string{
		" workflow_dispatch ": "manual",
		"pull_request":        "pull_request",
		"unknown":             "",
	}
	for input, want := range cases {
		if got := normalizeRegisteredEventType(input); got != want {
			t.Fatalf("normalizeRegisteredEventType(%q) = %q, want %q", input, got, want)
		}
	}
}
