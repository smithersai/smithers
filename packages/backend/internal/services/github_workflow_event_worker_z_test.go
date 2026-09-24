package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestGitHubWebhookEventWorker_Z_StartAndPollErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	worker := NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{}, &mockGitHubWebhookEventRunDispatcher{})
	worker.Start(ctx)

	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	worker = NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(ctx context.Context, _ int32) ([]db.GithubWebhookJob, error) {
			return nil, ctx.Err()
		},
	}, &mockGitHubWebhookEventRunDispatcher{})
	worker.Start(ctx)

	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	firstPollErr := make(chan struct{}, 1)
	worker = NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(context.Context, int32) ([]db.GithubWebhookJob, error) {
			select {
			case firstPollErr <- struct{}{}:
			default:
			}
			return nil, errors.New("poll failed")
		},
	}, &mockGitHubWebhookEventRunDispatcher{})
	worker.interval = time.Millisecond
	done := make(chan struct{})
	go func() {
		worker.Start(ctx)
		close(done)
	}()
	<-firstPollErr
	cancel()
	require.Eventually(t, func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}, time.Second, time.Millisecond)

	err := NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(context.Context, int32) ([]db.GithubWebhookJob, error) {
			return nil, errors.New("claim failed")
		},
	}, &mockGitHubWebhookEventRunDispatcher{}).PollOnce(context.Background())
	require.ErrorContains(t, err, "claim github webhook jobs")
}

func TestGitHubWebhookEventWorker_Z_ProcessJobErrorBranches(t *testing.T) {
	ctx := context.Background()

	queries := &mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(context.Context, int32) ([]db.GithubWebhookJob, error) {
			return []db.GithubWebhookJob{{ID: 1, EventType: "push", Payload: json.RawMessage(`{`)}}, nil
		},
	}
	worker := NewGitHubWebhookEventWorker(queries, &mockGitHubWebhookEventRunDispatcher{})
	require.NoError(t, worker.PollOnce(ctx))
	require.Len(t, queries.markFailed, 1)
	assert.Contains(t, queries.markFailed[0].Error, "parse payload")

	worker = NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{
		markGitHubWebhookJobDoneFn: func(context.Context, db.MarkGitHubWebhookJobDoneParams) (int64, error) {
			return 0, errors.New("done failed")
		},
	}, &mockGitHubWebhookEventRunDispatcher{})
	err := worker.processJob(ctx, db.GithubWebhookJob{ID: 2, EventType: "issues"})
	require.ErrorContains(t, err, "mark job done")

	queries = &mockGitHubWebhookEventWorkerQuerier{}
	worker = NewGitHubWebhookEventWorker(queries, &mockGitHubWebhookEventRunDispatcher{})
	require.NoError(t, worker.processJob(ctx, db.GithubWebhookJob{ID: 3, EventType: "push", Payload: json.RawMessage(`{}`)}))
	assert.Equal(t, []int64{3}, queries.markDoneIDs)

	worker = NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{
		markGitHubWebhookJobDoneFn: func(context.Context, db.MarkGitHubWebhookJobDoneParams) (int64, error) {
			return 0, errors.New("done failed")
		},
	}, &mockGitHubWebhookEventRunDispatcher{})
	err = worker.processJob(ctx, db.GithubWebhookJob{ID: 33, EventType: "push", Payload: json.RawMessage(`{}`)})
	require.ErrorContains(t, err, "mark job done")

	worker = NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{
		listRepositoryIDsForGitHubWebhookJobFn: func(context.Context, db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
			return nil, errors.New("repos failed")
		},
	}, &mockGitHubWebhookEventRunDispatcher{})
	err = worker.processJob(ctx, db.GithubWebhookJob{ID: 4, EventType: "push", Payload: json.RawMessage(`{"repository":{"id":1,"name":"demo","owner":{"login":"acme"}}}`)})
	require.ErrorContains(t, err, "resolve repositories")

	worker = NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{
		listRepositoryIDsForGitHubWebhookJobFn: func(context.Context, db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
			return []int64{42}, nil
		},
		listWorkflowTriggersByRepositoryFn: func(context.Context, int64) ([]db.WorkflowTrigger, error) {
			return nil, errors.New("triggers failed")
		},
	}, &mockGitHubWebhookEventRunDispatcher{})
	err = worker.processJob(ctx, db.GithubWebhookJob{ID: 5, EventType: "push", Payload: json.RawMessage(`{"repository":{"id":1,"name":"demo","owner":{"login":"acme"}}}`)})
	require.ErrorContains(t, err, "list workflow triggers")

	worker = NewGitHubWebhookEventWorker(&mockGitHubWebhookEventWorkerQuerier{
		listRepositoryIDsForGitHubWebhookJobFn: func(context.Context, db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
			return nil, nil
		},
		markGitHubWebhookJobDoneFn: func(context.Context, db.MarkGitHubWebhookJobDoneParams) (int64, error) {
			return 0, errors.New("done failed")
		},
	}, &mockGitHubWebhookEventRunDispatcher{})
	err = worker.processJob(ctx, db.GithubWebhookJob{ID: 6, EventType: "push", Payload: json.RawMessage(`{"repository":{"id":1,"name":"demo","owner":{"login":"acme"}}}`)})
	require.ErrorContains(t, err, "mark job done")
}

func TestGitHubWebhookEventWorker_Z_MapPayloadBranches(t *testing.T) {
	event, ok := mapGitHubWebhookJobToTriggerEvent(db.GithubWebhookJob{EventType: "pull_request", Action: "opened"}, gitHubWorkflowEventPayload{})
	require.True(t, ok)
	assert.Empty(t, event.Ref)

	event, ok = mapGitHubWebhookJobToTriggerEvent(db.GithubWebhookJob{EventType: "pull_request_review"}, gitHubWorkflowEventPayload{
		PullRequest: &struct {
			Head struct {
				Ref string `json:"ref"`
				SHA string `json:"sha"`
			} `json:"head"`
		}{Head: struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		}{Ref: "feature", SHA: "abc"}},
	})
	require.True(t, ok)
	assert.Equal(t, "feature", event.Ref)
	assert.Equal(t, "abc", event.CommitSHA)

	event, ok = mapGitHubWebhookJobToTriggerEvent(db.GithubWebhookJob{EventType: "check_suite"}, gitHubWorkflowEventPayload{
		CheckSuite: &struct {
			HeadBranch string `json:"head_branch"`
			HeadSHA    string `json:"head_sha"`
		}{HeadBranch: "main", HeadSHA: "def"},
	})
	require.True(t, ok)
	assert.Equal(t, "main", event.Ref)
	assert.Equal(t, "def", event.CommitSHA)
}
