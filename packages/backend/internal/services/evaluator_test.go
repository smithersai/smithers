package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEvaluateIfExpression_TriggerTypeComparisons(t *testing.T) {
	t.Parallel()

	event := TriggerEvent{Type: "push"}

	ok, err := EvaluateIfExpression(`trigger.type == "push"`, event, nil)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = EvaluateIfExpression(`trigger.type != "push"`, event, nil)
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestValidateIfExpression_ValidatesShortCircuitedAtoms(t *testing.T) {
	t.Parallel()

	err := ValidateIfExpression(`needs.build.result == "failure" && unsupported()`)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported")
}

func TestEvaluateIfExpression_NeedsResultComparisons(t *testing.T) {
	t.Parallel()

	event := TriggerEvent{Type: "push"}
	needs := map[string]string{
		"build": "success",
		"lint":  "failure",
	}

	ok, err := EvaluateIfExpression(`needs.build.result == "success"`, event, needs)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = EvaluateIfExpression(`needs.lint.result != "success"`, event, needs)
	require.NoError(t, err)
	assert.True(t, ok)
}

func TestEvaluateIfExpression_NeedsResultMissing_IsFalse(t *testing.T) {
	t.Parallel()

	ok, err := EvaluateIfExpression(`needs.deploy.result == "success"`, TriggerEvent{Type: "push"}, map[string]string{})
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestEvaluateIfExpression_InputComparisonsAndContains(t *testing.T) {
	t.Parallel()

	event := TriggerEvent{
		Type: "issues",
		Inputs: map[string]interface{}{
			"issueState":  "open",
			"issueLabels": []interface{}{"bug", "no-agent"},
		},
	}

	ok, err := EvaluateIfExpression(`inputs.issueState == "open"`, event, nil)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = EvaluateIfExpression(`contains(inputs.issueLabels, "no-agent")`, event, nil)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = EvaluateIfExpression(`!contains(inputs.issueLabels, "docs")`, event, nil)
	require.NoError(t, err)
	assert.True(t, ok)
}

func TestEvaluateIfExpression_AndConditions(t *testing.T) {
	t.Parallel()

	event := TriggerEvent{
		Type: "issues",
		Inputs: map[string]interface{}{
			"issueLabels": []interface{}{"bug"},
		},
	}

	ok, err := EvaluateIfExpression(`trigger.type == "issues" && !contains(inputs.issueLabels, "no-agent")`, event, nil)
	require.NoError(t, err)
	assert.True(t, ok)
}

func TestEvaluateIfExpression_StatusHelpers(t *testing.T) {
	t.Parallel()

	needs := map[string]string{
		"build":  "success",
		"deploy": "failure",
	}

	ok, err := EvaluateIfExpression(`failure()`, TriggerEvent{Type: "workflow_run"}, needs)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = EvaluateIfExpression(`cancelled()`, TriggerEvent{Type: "workflow_run"}, needs)
	require.NoError(t, err)
	assert.False(t, ok)

	ok, err = EvaluateIfExpression(`success()`, TriggerEvent{Type: "workflow_run"}, map[string]string{"build": "success"})
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = EvaluateIfExpression(`success()`, TriggerEvent{Type: "workflow_run"}, needs)
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestIfExpressionReferencesNeeds_StatusHelpersInConjunction(t *testing.T) {
	t.Parallel()

	assert.True(t, IfExpressionReferencesNeeds(`failure() && trigger.type == "push"`))
	assert.True(t, IfExpressionReferencesNeeds(`cancelled() && inputs.environment == "prod"`))
	assert.True(t, IfExpressionReferencesNeeds(`success() && trigger.type == "workflow_run"`))
	assert.False(t, IfExpressionReferencesNeeds(`trigger.type == "push"`))
}

func TestDependentJobShouldRunAppliesImplicitSuccess(t *testing.T) {
	event := TriggerEvent{Type: "push"}
	failed := map[string]string{"test": "failure"}
	for _, tc := range []struct {
		expr string
		want bool
	}{
		{`trigger.type == "push"`, false},
		{"", false},
		{"always()", true},
		{`needs.test.result == "failure"`, true},
		{"success()", false},
	} {
		got, err := DependentJobShouldRun(tc.expr, event, failed)
		require.NoError(t, err)
		assert.Equal(t, tc.want, got, "expression %q", tc.expr)
	}
}
