package services

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func approvedFlowRegistrationInput() RegisterRepositoryJobInput {
	input := repositoryJobTestInput()
	input.FlowID = "nightly-lint"
	input.Mode = "enabled"
	input.Events = nil
	input.Label = ""
	input.Schedule = "0 9 * * 1-5"
	input.Input = json.RawMessage(`{"label":"nightly","token":"held-out"}`)
	input.ApprovedPlanID = "plan-01"
	input.ApprovedPlanDigest = strings.Repeat("d", 64)
	return input
}

func TestRepositoryFlowRegistrationRequiresReviewedPlanShape(t *testing.T) {
	now := time.Date(2026, 9, 21, 9, 0, 0, 0, time.UTC)
	valid := approvedFlowRegistrationInput()
	next, err := validateRepositoryJob("flow:nightly-lint", valid, now)
	require.NoError(t, err)
	require.True(t, next.Valid)

	for name, edit := range map[string]func(*RegisterRepositoryJobInput){
		"missing schedule": func(input *RegisterRepositoryJobInput) { input.Schedule = "" },
		"event rule": func(input *RegisterRepositoryJobInput) {
			input.Events = []RepositoryJobEventRule{{Type: "issues"}}
		},
		"trial mode": func(input *RegisterRepositoryJobInput) {
			input.Mode = "trial"
			input.TrialSource = "github"
			input.TrialIssueNumber = 1
		},
		"missing plan": func(input *RegisterRepositoryJobInput) { input.ApprovedPlanID = "" },
		"unreviewed digest": func(input *RegisterRepositoryJobInput) {
			input.ApprovedPlanDigest = "not-a-digest"
		},
	} {
		t.Run(name, func(t *testing.T) {
			input := valid
			edit(&input)
			_, err := validateRepositoryJob("flow:nightly-lint", input, now)
			require.Error(t, err)
		})
	}
}

func TestRepositoryFlowRegistrationKeepsNamespacesAndHeldOutInputSeparate(t *testing.T) {
	input := approvedFlowRegistrationInput()
	for _, builtIn := range []string{"issues", "review", "ci", "feature", "chores"} {
		require.True(t, isRepositoryJobName(builtIn))
		require.False(t, repositoryFlowJobKey.MatchString(builtIn))
	}
	require.True(t, isRepositoryJobName("flow:nightly-lint"))

	configuration, err := json.Marshal(input)
	require.NoError(t, err)
	redacted := readableRepositoryJobConfiguration("flow:nightly-lint", configuration)
	var wire struct {
		Digest string          `json:"digest"`
		Input  json.RawMessage `json:"input"`
	}
	require.NoError(t, json.Unmarshal(redacted, &wire))
	require.Equal(t, input.Digest, wire.Digest)
	require.JSONEq(t, `{}`, string(wire.Input))
	require.NotContains(t, string(redacted), "held-out")
}
