package db

import (
	"context"
	"strings"
)

const claimPendingGitHubWebhookJobs = `
WITH claimed AS (
	SELECT id
	FROM github_webhook_jobs
	WHERE status = 'pending'
	  AND available_at <= NOW()
	ORDER BY available_at ASC, id ASC
	FOR UPDATE SKIP LOCKED
	LIMIT $1
)
UPDATE github_webhook_jobs j
SET status = 'processing',
    attempts = j.attempts + 1,
    updated_at = NOW()
FROM claimed
WHERE j.id = claimed.id
RETURNING j.id, j.delivery_id, j.event_type, j.action, j.installation_id, j.github_repository_id, j.payload, j.status, j.attempts, j.error, j.available_at, j.processed_at, j.created_at, j.updated_at
`

// ClaimPendingGitHubWebhookJobs atomically claims pending GitHub webhook jobs
// using FOR UPDATE SKIP LOCKED so concurrent workers do not double-process jobs.
func (q *Queries) ClaimPendingGitHubWebhookJobs(ctx context.Context, claimLimit int32) ([]GithubWebhookJob, error) {
	rows, err := q.db.Query(ctx, claimPendingGitHubWebhookJobs, claimLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]GithubWebhookJob, 0)
	for rows.Next() {
		var item GithubWebhookJob
		if err := rows.Scan(
			&item.ID,
			&item.DeliveryID,
			&item.EventType,
			&item.Action,
			&item.InstallationID,
			&item.GithubRepositoryID,
			&item.Payload,
			&item.Status,
			&item.Attempts,
			&item.Error,
			&item.AvailableAt,
			&item.ProcessedAt,
			&item.CreatedAt,
			&item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

const markGitHubWebhookJobDone = `
UPDATE github_webhook_jobs
SET status = 'done',
    error = '',
    processed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
`

func (q *Queries) MarkGitHubWebhookJobDone(ctx context.Context, id int64) error {
	_, err := q.db.Exec(ctx, markGitHubWebhookJobDone, id)
	return err
}

const markGitHubWebhookJobFailed = `
UPDATE github_webhook_jobs
SET status = 'failed',
    error = $2,
    processed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
`

type MarkGitHubWebhookJobFailedParams struct {
	ID    int64  `json:"id"`
	Error string `json:"error"`
}

func (q *Queries) MarkGitHubWebhookJobFailed(ctx context.Context, arg MarkGitHubWebhookJobFailedParams) error {
	_, err := q.db.Exec(ctx, markGitHubWebhookJobFailed, arg.ID, strings.TrimSpace(arg.Error))
	return err
}

const retryGitHubWebhookJob = `
UPDATE github_webhook_jobs
SET status = 'pending',
    error = $2,
    available_at = NOW() + make_interval(secs => $3),
    updated_at = NOW()
WHERE id = $1
`

type RetryGitHubWebhookJobParams struct {
	ID             int64   `json:"id"`
	Error          string  `json:"error"`
	BackoffSeconds float64 `json:"backoff_seconds"`
}

// RetryGitHubWebhookJob re-pends a transiently failed job so a later poll
// re-claims it after the backoff window, instead of terminally failing it.
func (q *Queries) RetryGitHubWebhookJob(ctx context.Context, arg RetryGitHubWebhookJobParams) error {
	_, err := q.db.Exec(ctx, retryGitHubWebhookJob, arg.ID, strings.TrimSpace(arg.Error), arg.BackoffSeconds)
	return err
}

const resetStalledGitHubWebhookJobs = `
UPDATE github_webhook_jobs
SET status = 'pending',
    available_at = NOW(),
    updated_at = NOW()
WHERE status = 'processing'
  AND updated_at < NOW() - make_interval(secs => $1)
`

// ResetStalledGitHubWebhookJobs re-pends jobs stuck in 'processing' longer
// than the lease window, so a batch claimed by a crashed worker is
// re-dispatched instead of being stranded forever.
func (q *Queries) ResetStalledGitHubWebhookJobs(ctx context.Context, olderThanSeconds float64) (int64, error) {
	tag, err := q.db.Exec(ctx, resetStalledGitHubWebhookJobs, olderThanSeconds)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const listRepositoryIDsForGitHubWebhookJob = `
SELECT DISTINCT r.id
FROM github_app_installation_repositories gir
JOIN repo_connections rc
  ON rc.repo_owner_lower = gir.owner_login_lower
 AND rc.repo_name_lower = gir.repo_name_lower
JOIN repositories r
  ON r.lower_name = rc.repo_name_lower
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE ($1::bigint = 0 OR gir.installation_id = $1)
  AND ($2::bigint = 0 OR gir.github_repository_id = $2)
  AND ($3::text = '' OR gir.owner_login_lower = $3)
  AND ($4::text = '' OR gir.repo_name_lower = $4)
  AND (
    LOWER(COALESCE(u.username, '')) = gir.owner_login_lower
    OR LOWER(COALESCE(o.name, '')) = gir.owner_login_lower
  )
ORDER BY r.id
`

type ListRepositoryIDsForGitHubWebhookJobParams struct {
	InstallationID     int64  `json:"installation_id"`
	GitHubRepositoryID int64  `json:"github_repository_id"`
	OwnerLoginLower    string `json:"owner_login_lower"`
	RepoNameLower      string `json:"repo_name_lower"`
}

// ListRepositoryIDsForGitHubWebhookJob resolves GitHub webhook metadata to
// local connected repository IDs through installation and repo-connection mappings.
func (q *Queries) ListRepositoryIDsForGitHubWebhookJob(ctx context.Context, arg ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
	rows, err := q.db.Query(
		ctx,
		listRepositoryIDsForGitHubWebhookJob,
		arg.InstallationID,
		arg.GitHubRepositoryID,
		strings.ToLower(strings.TrimSpace(arg.OwnerLoginLower)),
		strings.ToLower(strings.TrimSpace(arg.RepoNameLower)),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}
