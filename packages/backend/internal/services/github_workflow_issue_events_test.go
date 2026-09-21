package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func gitHubIssueEventJob(eventType, action string) db.GithubWebhookJob {
	return db.GithubWebhookJob{
		ID:                 108,
		DeliveryID:         "2a356bd5-bfcc-5ec3-b779-387b94b0b64e",
		EventType:          eventType,
		Action:             action,
		Attempts:           1,
		InstallationID:     pgtype.Int8{Int64: 777, Valid: true},
		GithubRepositoryID: pgtype.Int8{Int64: 9001, Valid: true},
		Payload: json.RawMessage(`{
			"action":"created",
			"installation":{"id":777},
			"repository":{"id":9001,"name":"demo","full_name":"Acme/demo","owner":{"login":"Acme"},"default_branch":"trunk"},
			"issue":{"id":512,"number":24,"title":"Empty config crashes","body":"Steps: use []","state":"open","html_url":"https://github.com/Acme/demo/issues/24","user":{"id":922,"login":"contributor"},"labels":[{"name":"bug"}],"author_association":"NONE"},
			"comment":{"id":2048,"body":"Here is the requested configuration: []","user":{"id":922,"login":"contributor"},"html_url":"https://github.com/Acme/demo/issues/24#issuecomment-2048"},
			"sender":{"id":922,"login":"contributor","type":"User"}
		}`),
	}
}

func TestGitHubIssueEventMapping_PreservesExternalIssueAndDeliveryIdentity(t *testing.T) {
	t.Parallel()

	for _, eventType := range []string{"issues", "issue_comment"} {
		t.Run(eventType, func(t *testing.T) {
			job := gitHubIssueEventJob(eventType, "edited")
			payload, err := parseGitHubWorkflowEventPayload(job.Payload)
			require.NoError(t, err)
			event, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
			require.True(t, supported)
			assert.Equal(t, eventType, event.Type)
			assert.Equal(t, "edited", event.Action)
			assert.Equal(t, "trunk", event.Ref)
			assert.Empty(t, event.CommitSHA, "an issue's source branch is not an immutable revision")
			assert.Empty(t, event.ChangeID)
			assert.Equal(t, "github", event.Inputs["source"])
			assert.Equal(t, eventType, event.Inputs["eventType"])
			assert.Equal(t, job.DeliveryID, event.Inputs["githubDeliveryId"])
			assert.Equal(t, job.ID, event.Inputs["githubWebhookJobId"])
			assert.Equal(t, int64(512), event.Inputs["issueId"])
			assert.Equal(t, int64(24), event.Inputs["issueNumber"])
			assert.Equal(t, "Empty config crashes", event.Inputs["issueTitle"])
			assert.Equal(t, "Steps: use []", event.Inputs["issueBody"])
			assert.Equal(t, "contributor", event.Inputs["issueAuthor"])
			assert.Equal(t, []string{"bug"}, event.Inputs["issueLabels"])
			assert.Equal(t, "Acme/demo", event.Inputs["repoFullName"])
			assert.Equal(t, "https://github.com/Acme/demo/issues/24", event.Inputs["issueUrl"])

			// Persisted dispatch input retains the source objects (including
			// fields not projected into the convenience input names).
			encoded, err := json.Marshal(event.Inputs)
			require.NoError(t, err)
			var persisted map[string]interface{}
			require.NoError(t, json.Unmarshal(encoded, &persisted))
			assert.Equal(t, "NONE", persisted["issue"].(map[string]interface{})["author_association"])
			assert.Equal(t, "Here is the requested configuration: []", persisted["comment"].(map[string]interface{})["body"])
			assert.Equal(t, "contributor", persisted["sender"].(map[string]interface{})["login"])

			job.Attempts++
			retry, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
			require.True(t, supported)
			assert.Equal(t, event.Inputs, retry.Inputs, "a retry must preserve the signed body's delivery identity")
		})
	}
}

func TestGitHubIssueEventMapping_RejectsNonIssuePayloads(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name      string
		eventType string
		payload   string
	}{
		{"missing issue", "issues", `{}`},
		{"missing number", "issues", `{"issue":{"id":512}}`},
		{"missing issue identity", "issues", `{"issue":{"number":24}}`},
		{"PR-shaped issue", "issues", `{"issue":{"id":512,"number":24,"pull_request":{"url":"https://api.github.com/repos/Acme/demo/pulls/24"}}}`},
		{"PR conversation", "issue_comment", `{"issue":{"id":512,"number":24,"pull_request":{"url":"https://api.github.com/repos/Acme/demo/pulls/24"}},"comment":{"id":2048}}`},
		{"missing comment", "issue_comment", `{"issue":{"id":512,"number":24}}`},
		{"comment without identity", "issue_comment", `{"issue":{"id":512,"number":24},"comment":{"body":"a reply"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			job := gitHubIssueEventJob(tc.eventType, "created")
			job.Payload = json.RawMessage(tc.payload)
			payload, err := parseGitHubWorkflowEventPayload(job.Payload)
			require.NoError(t, err)
			_, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
			assert.False(t, supported)
		})
	}
}

func TestGitHubIssueEventWorker_DispatchesOnlyEnabledMatchingIssueRules(t *testing.T) {
	t.Parallel()

	for _, eventType := range []string{"issues", "issue_comment"} {
		t.Run(eventType, func(t *testing.T) {
			job := gitHubIssueEventJob(eventType, "created")
			queries := pushJobQuerier(job)
			queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
				return []db.WorkflowTrigger{
					{WorkflowDefinitionID: 9, EventType: eventType, Enabled: false},
					{WorkflowDefinitionID: 10, EventType: eventType, EventAction: "created", Enabled: true},
					{WorkflowDefinitionID: 10, EventType: eventType, Enabled: true},
					{WorkflowDefinitionID: 11, EventType: eventType, EventAction: "deleted", Enabled: true},
					{WorkflowDefinitionID: 12, EventType: "manual", Enabled: true},
					{WorkflowDefinitionID: 13, EventType: "pull_request", Enabled: true},
				}, nil
			}
			dispatcher := &mockGitHubWebhookEventRunDispatcher{}
			require.NoError(t, NewGitHubWebhookEventWorker(queries, dispatcher).PollOnce(context.Background()))
			require.Len(t, dispatcher.calls, 1)
			assert.Equal(t, int64(10), *dispatcher.calls[0].WorkflowDefinitionID)
			assert.Zero(t, dispatcher.calls[0].UserID, "GitHub actor IDs do not authorize a Plue user")
			assert.Equal(t, job.DeliveryID, dispatcher.calls[0].Event.Inputs["githubDeliveryId"])
			assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
			assert.Empty(t, queries.markFailed)
		})
	}
}

func TestGitHubIssueEventWorker_DisabledSetupDoesNotDispatch(t *testing.T) {
	t.Parallel()

	job := gitHubIssueEventJob("issues", "opened")
	queries := pushJobQuerier(job)
	queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
		return []db.WorkflowTrigger{
			{WorkflowDefinitionID: 10, EventType: "issue", EventAction: "opened", Enabled: false},
			{WorkflowDefinitionID: 11, EventType: "manual", Enabled: true},
		}, nil
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	require.NoError(t, NewGitHubWebhookEventWorker(queries, dispatcher).PollOnce(context.Background()))
	assert.Empty(t, dispatcher.calls)
	assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
}

func TestGitHubIssueEventWorker_RetryRetainsIdentityAndAuthorReply(t *testing.T) {
	t.Parallel()

	job := gitHubIssueEventJob("issue_comment", "created")
	queries := pushJobQuerier(job)
	queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
		return []db.WorkflowTrigger{{WorkflowDefinitionID: 10, EventType: "issue_comment", EventAction: "created", Enabled: true}}, nil
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	dispatcher.dispatchForEventFn = func(context.Context, DispatchForEventInput) ([]WorkflowRunResult, error) {
		if len(dispatcher.calls) == 1 {
			return nil, errors.New("temporary dispatcher failure")
		}
		return nil, nil
	}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)
	require.NoError(t, worker.PollOnce(context.Background()))
	require.Len(t, queries.retried, 1)
	assert.Empty(t, queries.markDoneIDs)
	require.NoError(t, worker.PollOnce(context.Background()))
	require.Len(t, dispatcher.calls, 2)
	assert.Equal(t, dispatcher.calls[0].Event.Inputs, dispatcher.calls[1].Event.Inputs)
	assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
}
