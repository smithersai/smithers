package db

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type githubWebhookJobsExtHDB = chunk5SQLHDB
type githubWebhookJobsExtHRows = chunk5SQLHRows

func TestGithubWebhookJobsExt_H_ClaimMarkAndResolveRepositories(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerLower := strings.ToLower(uniqueTestUsername(t))
	repoLower := "repo-" + randSlug(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, ownerLower, repoLower)

	jobID := githubWebhookJobsExtHInsertJob(t, pool, "push", "", pgtype.Int8{Int64: 42, Valid: true}, pgtype.Int8{Int64: 84, Valid: true}, time.Now().Add(-time.Minute))
	_ = githubWebhookJobsExtHInsertJob(t, pool, "issues", "opened", pgtype.Int8{Int64: 42, Valid: true}, pgtype.Int8{Int64: 84, Valid: true}, time.Now().Add(time.Hour))
	claimed, err := q.ClaimPendingGitHubWebhookJobs(ctx, 10)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, jobID, claimed[0].ID)
	assert.Equal(t, int32(1), claimed[0].Attempts)

	require.NoError(t, q.MarkGitHubWebhookJobFailed(ctx, MarkGitHubWebhookJobFailedParams{ID: jobID, Error: "  failed once  "}))
	var status, msg string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status, error FROM github_webhook_jobs WHERE id = $1`, jobID).Scan(&status, &msg))
	assert.Equal(t, "failed", status)
	assert.Equal(t, "failed once", msg)
	require.NoError(t, q.RetryGitHubWebhookJob(ctx, RetryGitHubWebhookJobParams{ID: jobID, Error: "  transient  ", BackoffSeconds: 30}))
	var availableInSecs float64
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT status, error, EXTRACT(EPOCH FROM (available_at - NOW())) FROM github_webhook_jobs WHERE id = $1`, jobID,
	).Scan(&status, &msg, &availableInSecs))
	assert.Equal(t, "pending", status)
	assert.Equal(t, "transient", msg)
	assert.InDelta(t, 30, availableInSecs, 5)

	mustExec(t, pool, `UPDATE github_webhook_jobs SET status = 'processing', updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, jobID)
	reclaimed, err := q.ResetStalledGitHubWebhookJobs(ctx, (5 * time.Minute).Seconds())
	require.NoError(t, err)
	assert.Equal(t, int64(1), reclaimed)
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM github_webhook_jobs WHERE id = $1`, jobID).Scan(&status))
	assert.Equal(t, "pending", status)
	reclaimed, err = q.ResetStalledGitHubWebhookJobs(ctx, (5 * time.Minute).Seconds())
	require.NoError(t, err)
	assert.Zero(t, reclaimed)

	require.NoError(t, q.MarkGitHubWebhookJobDone(ctx, jobID))
	require.NoError(t, pool.QueryRow(ctx, `SELECT status, error FROM github_webhook_jobs WHERE id = $1`, jobID).Scan(&status, &msg))
	assert.Equal(t, "done", status)
	assert.Empty(t, msg)

	mustExec(t, pool, `INSERT INTO github_app_installations (installation_id, account_login, account_type, repository_selection) VALUES ($1, $2, 'User', 'selected')`, int64(42), ownerLower)
	mustExec(t, pool, `
		INSERT INTO github_app_installation_repositories (installation_id, github_repository_id, owner_login, owner_login_lower, repo_name, repo_name_lower, is_private)
		VALUES ($1, $2, $3, $3, $4, $4, false)`,
		int64(42), int64(84), ownerLower, repoLower,
	)
	mustExec(t, pool, `
		INSERT INTO repo_connections (user_id, repo_owner, repo_name, repo_owner_lower, repo_name_lower, license_spdx_id)
		VALUES ($1, $2, $3, $2, $3, 'MIT')`,
		userID, ownerLower, repoLower,
	)
	ids, err := q.ListRepositoryIDsForGitHubWebhookJob(ctx, ListRepositoryIDsForGitHubWebhookJobParams{
		InstallationID: 42, GitHubRepositoryID: 84, OwnerLoginLower: "  " + strings.ToUpper(ownerLower) + "  ", RepoNameLower: strings.ToUpper(repoLower),
	})
	require.NoError(t, err)
	require.Equal(t, []int64{repoID}, ids)
	ids, err = q.ListRepositoryIDsForGitHubWebhookJob(ctx, ListRepositoryIDsForGitHubWebhookJobParams{InstallationID: 999})
	require.NoError(t, err)
	assert.Empty(t, ids)
}

func TestGithubWebhookJobsExt_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("github webhook jobs h failed")
	for _, call := range []func(*Queries) error{
		func(q *Queries) error { _, err := q.ClaimPendingGitHubWebhookJobs(context.Background(), 1); return err },
		func(q *Queries) error {
			_, err := q.ListRepositoryIDsForGitHubWebhookJob(context.Background(), ListRepositoryIDsForGitHubWebhookJobParams{})
			return err
		},
	} {
		require.ErrorIs(t, call(New(githubWebhookJobsExtHDB{queryErr: sentinel})), sentinel)
		require.ErrorIs(t, call(New(githubWebhookJobsExtHDB{rows: &githubWebhookJobsExtHRows{next: true, scanErr: sentinel}})), sentinel)
		require.ErrorIs(t, call(New(githubWebhookJobsExtHDB{rows: &githubWebhookJobsExtHRows{err: sentinel}})), sentinel)
	}
	execQ := New(githubWebhookJobsExtHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.MarkGitHubWebhookJobDone(context.Background(), 1), sentinel)
	require.ErrorIs(t, execQ.MarkGitHubWebhookJobFailed(context.Background(), MarkGitHubWebhookJobFailedParams{ID: 1, Error: "x"}), sentinel)
	require.ErrorIs(t, execQ.RetryGitHubWebhookJob(context.Background(), RetryGitHubWebhookJobParams{ID: 1, Error: "x", BackoffSeconds: 1}), sentinel)
	_, err := execQ.ResetStalledGitHubWebhookJobs(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
}

func githubWebhookJobsExtHInsertJob(t *testing.T, pool DBTX, eventType, action string, installationID, repoID pgtype.Int8, availableAt time.Time) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(context.Background(), `
		INSERT INTO github_webhook_jobs (delivery_id, event_type, action, installation_id, github_repository_id, payload, available_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		uuid.NewString(), eventType, action, installationID, repoID, json.RawMessage(`{"h":true}`), availableAt,
	).Scan(&id)
	require.NoError(t, err)
	return id
}
