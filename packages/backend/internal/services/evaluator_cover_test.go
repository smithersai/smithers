package services

import "testing"

func TestEvaluator_Cov_NeedsFunctionsAndComparisons(t *testing.T) {
	event := TriggerEvent{Type: "pull_request", Inputs: map[string]interface{}{
		"branch": "main",
		"labels": []interface{}{"bug", 3},
		"teams":  []string{"core", "infra"},
		"count":  3,
	}}
	needs := map[string]string{"build": "success", "lint": "cancelled"}

	cases := []struct {
		expr string
		want bool
	}{
		{`success()`, false},
		{`failure()`, false},
		{`cancelled()`, true},
		{`needs.build.result == "success"`, true},
		{`needs.missing.result != "success"`, false},
		{`inputs.branch != "dev"`, true},
		{`contains(inputs.labels, "3")`, true},
		{`contains(inputs.teams, "infra")`, true},
		{`!contains(inputs.teams, "ops")`, true},
		{`trigger.type != "push"`, true},
		{`inputs.branch == "main" && cancelled()`, true},
	}

	for _, tc := range cases {
		got, err := EvaluateIfExpression(tc.expr, event, needs)
		if err != nil || got != tc.want {
			t.Fatalf("EvaluateIfExpression(%q) = %v, %v; want %v nil", tc.expr, got, err, tc.want)
		}
	}
}

func TestEvaluator_Cov_UnsupportedAndStringifyBranches(t *testing.T) {
	if got, err := EvaluateIfExpression("success()", TriggerEvent{}, nil); err != nil || !got {
		t.Fatalf("success with no needs = %v, %v", got, err)
	}
	if got, err := EvaluateIfExpression(`inputs.missing == "x"`, TriggerEvent{Inputs: map[string]interface{}{}}, nil); err != nil || got {
		t.Fatalf("missing input = %v, %v", got, err)
	}
	if _, err := EvaluateIfExpression("bad syntax", TriggerEvent{}, nil); err == nil {
		t.Fatal("expected unsupported expression error")
	}
	if got := stringifyInput(42); got != "42" {
		t.Fatalf("stringifyInput = %q", got)
	}
	if inputContains([]interface{}{"a", 2}, "3") {
		t.Fatal("inputContains unexpectedly matched")
	}
}
