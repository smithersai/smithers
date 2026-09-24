package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type githubWorkflowEventWorkerCovNonCronQuerier struct{}

func (githubWorkflowEventWorkerCovNonCronQuerier) ClaimPendingGitHubWebhookJobs(context.Context, int32) ([]db.GithubWebhookJob, error) {
	return nil, nil
}

func (githubWorkflowEventWorkerCovNonCronQuerier) MarkGitHubWebhookJobDone(context.Context, db.MarkGitHubWebhookJobDoneParams) (int64, error) {
	return 1, nil
}

func (githubWorkflowEventWorkerCovNonCronQuerier) MarkGitHubWebhookJobFailed(context.Context, db.MarkGitHubWebhookJobFailedParams) (int64, error) {
	return 1, nil
}

func (githubWorkflowEventWorkerCovNonCronQuerier) RetryGitHubWebhookJob(context.Context, db.RetryGitHubWebhookJobParams) (int64, error) {
	return 1, nil
}

func (githubWorkflowEventWorkerCovNonCronQuerier) ResetStalledGitHubWebhookJobs(context.Context, float64) (int64, error) {
	return 0, nil
}

func (githubWorkflowEventWorkerCovNonCronQuerier) ListRepositoryIDsForGitHubWebhookJob(context.Context, db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
	return nil, nil
}

func (githubWorkflowEventWorkerCovNonCronQuerier) ListWorkflowTriggersByRepository(context.Context, int64) ([]db.WorkflowTrigger, error) {
	return nil, nil
}

func TestGitHubWorkflowEventWorker_Cov_StartNilAndScheduleBranches(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	worker := NewGitHubWebhookEventWorker(nil, nil)
	worker.interval = time.Millisecond
	worker.Start(ctx)

	var nilWorker *GitHubWebhookEventWorker
	require.NoError(t, nilWorker.PollOnce(context.Background()))
	require.NoError(t, nilWorker.PollScheduledWorkflowTriggers(context.Background(), time.Now()))

	nonCronWorker := NewGitHubWebhookEventWorker(githubWorkflowEventWorkerCovNonCronQuerier{}, &mockGitHubWebhookEventRunDispatcher{})
	err := nonCronWorker.PollScheduledWorkflowTriggers(context.Background(), time.Now())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "requires workflow schedule queries")
}

func TestGitHubWorkflowEventWorker_Cov_ParseMapSelectorAndMatchingBranches(t *testing.T) {
	empty, err := parseGitHubWorkflowEventPayload(nil)
	require.NoError(t, err)
	assert.Nil(t, empty.Repository)

	_, err = parseGitHubWorkflowEventPayload(json.RawMessage(`{"broken"`))
	require.Error(t, err)

	checkRunPayload, err := parseGitHubWorkflowEventPayload(json.RawMessage(`{
		"check_run":{"head_sha":"","check_suite":{"head_branch":"main","head_sha":"suite-sha"}}
	}`))
	require.NoError(t, err)
	event, supported := mapGitHubWebhookJobToTriggerEvent(db.GithubWebhookJob{EventType: " CHECK_RUN ", Action: " completed "}, checkRunPayload)
	require.True(t, supported)
	assert.Equal(t, "main", event.Ref)
	assert.Equal(t, "suite-sha", event.CommitSHA)
	assert.Equal(t, "completed", event.Action)

	_, supported = mapGitHubWebhookJobToTriggerEvent(db.GithubWebhookJob{EventType: "pull_request", Action: "closed"}, gitHubWorkflowEventPayload{})
	assert.False(t, supported)

	payload, err := parseGitHubWorkflowEventPayload(json.RawMessage(`{
		"installation":{"id":1234},
		"repository":{"id":5678,"name":"","full_name":"Acme/Demo","owner":{"login":""}}
	}`))
	require.NoError(t, err)
	selector := buildGitHubWebhookRepositorySelector(db.GithubWebhookJob{}, payload)
	assert.Equal(t, int64(1234), selector.InstallationID)
	assert.Equal(t, int64(5678), selector.GitHubRepositoryID)
	assert.Equal(t, "acme", selector.OwnerLoginLower)
	assert.Equal(t, "demo", selector.RepoNameLower)

	ids := matchingWorkflowDefinitionIDs([]db.WorkflowTrigger{
		{WorkflowDefinitionID: 20, EventType: "pull_request", Enabled: true},
		{WorkflowDefinitionID: 10, EventType: "pull_request", EventAction: "opened", Enabled: true},
		{WorkflowDefinitionID: 10, EventType: "pull_request", EventAction: "opened", Enabled: true},
		{WorkflowDefinitionID: 30, EventType: "pull_request", EventAction: "closed", Enabled: true},
		{WorkflowDefinitionID: 40, EventType: "pull_request", EventAction: "opened", Enabled: false},
	}, TriggerEvent{Type: "pull_request.opened"})
	assert.Equal(t, []int64{10, 20}, ids)

	assert.Nil(t, matchingWorkflowDefinitionIDs(nil, TriggerEvent{}))
}

func TestGitHubWorkflowEventWorker_Cov_ProcessJobMarksUnsupportedAndFailures(t *testing.T) {
	t.Run("selector without repository identity is marked done", func(t *testing.T) {
		queries := &mockGitHubWebhookEventWorkerQuerier{}
		worker := NewGitHubWebhookEventWorker(queries, &mockGitHubWebhookEventRunDispatcher{})

		err := worker.processJob(context.Background(), db.GithubWebhookJob{
			ID:        11,
			EventType: "push",
			Payload:   json.RawMessage(`{"ref":"refs/heads/main","after":"abc"}`),
		})
		require.NoError(t, err)
		assert.Equal(t, []int64{11}, queries.markDoneIDs)
	})

	t.Run("mark done failure is surfaced", func(t *testing.T) {
		queries := &mockGitHubWebhookEventWorkerQuerier{
			markGitHubWebhookJobDoneFn: func(context.Context, db.MarkGitHubWebhookJobDoneParams) (int64, error) {
				return 0, pgx.ErrTxClosed
			},
		}
		worker := NewGitHubWebhookEventWorker(queries, &mockGitHubWebhookEventRunDispatcher{})

		err := worker.processJob(context.Background(), db.GithubWebhookJob{
			ID:        12,
			EventType: "unknown",
			Payload:   json.RawMessage(`{}`),
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "mark job done")
	})
}
