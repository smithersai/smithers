package webhooks

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateSubscribedEventsAcceptsDispatchedEventsAndWildcards(t *testing.T) {
	require.NoError(t, ValidateSubscribedEvents([]string{
		"push", "landing_request", "landing_request_review", "landing_request_comment",
		"issues", "issue_comment", "create", "delete", "team", "organization",
		"workflow_run", "workflow_artifact", "status", "landing.conflict", "wiki",
		"*", "all", " Push ",
	}))
	require.NoError(t, ValidateSubscribedEvents(nil))
}

func TestValidateSubscribedEventsRejectsEventsThatNeverFire(t *testing.T) {
	for _, event := range []string{"release", "agent.session", "agent.message", "star", "watch", "member", "ping", "pull_request", ""} {
		require.Error(t, ValidateSubscribedEvents([]string{"push", event}), event)
	}
}
