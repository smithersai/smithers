package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEvaluator_Z_ConjunctionAndContainsBranches(t *testing.T) {
	t.Parallel()

	event := TriggerEvent{Type: "push", Inputs: map[string]interface{}{
		"env":   "prod",
		"items": []interface{}{"one", 2},
		"num":   2,
	}}

	ok, err := EvaluateIfExpression(`trigger.type == "push" && unsupported()`, event, nil)
	require.Error(t, err)
	assert.False(t, ok)

	ok, err = EvaluateIfExpression(`trigger.type == "pull_request" && unsupported()`, event, nil)
	require.NoError(t, err)
	assert.False(t, ok)

	ok, err = evaluateIfAtom("", event, nil)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = evaluateIfAtom(`contains(inputs.missing, "one")`, event, nil)
	require.NoError(t, err)
	assert.False(t, ok)

	ok, err = evaluateIfAtom(`contains(inputs.items, "2")`, event, nil)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = evaluateIfAtom(`contains(inputs.num, "2")`, event, nil)
	require.NoError(t, err)
	assert.True(t, ok)
}
