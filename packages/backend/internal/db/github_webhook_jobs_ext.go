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

// Each terminal or retry write is fenced on the exact claim generation
// (status='processing' AND attempts=$n). A worker whose claim was reset as
// stalled and re-claimed by another worker writes zero rows, so it can neither
// re-pend a job another worker holds nor overwrite that worker's outcome.

const markGitHubWebhookJobDone = `
UPDATE github_webhook_jobs
SET status = 'done',
    error = '',
    processed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status = 'processing'
  AND attempts = $2
`

type MarkGitHubWebhookJobDoneParams struct {
	ID               int64 `json:"id"`
	ExpectedAttempts int32 `json:"expected_attempts"`
}

// MarkGitHubWebhookJobDone finishes one claim generation and returns the rows
// it changed; 0 means the claim was lost.
func (q *Queries) MarkGitHubWebhookJobDone(ctx context.Context, arg MarkGitHubWebhookJobDoneParams) (int64, error) {
	tag, err := q.db.Exec(ctx, markGitHubWebhookJobDone, arg.ID, arg.ExpectedAttempts)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const markGitHubWebhookJobFailed = `
UPDATE github_webhook_jobs
SET status = 'failed',
    error = $3,
    processed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status = 'processing'
  AND attempts = $2
`

type MarkGitHubWebhookJobFailedParams struct {
	ID               int64  `json:"id"`
	ExpectedAttempts int32  `json:"expected_attempts"`
	Error            string `json:"error"`
}

// MarkGitHubWebhookJobFailed terminally fails one claim generation and
// returns the rows it changed; 0 means the claim was lost.
func (q *Queries) MarkGitHubWebhookJobFailed(ctx context.Context, arg MarkGitHubWebhookJobFailedParams) (int64, error) {
	tag, err := q.db.Exec(ctx, markGitHubWebhookJobFailed, arg.ID, arg.ExpectedAttempts, strings.TrimSpace(arg.Error))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const retryGitHubWebhookJob = `
UPDATE github_webhook_jobs
SET status = 'pending',
    error = $3,
    available_at = NOW() + make_interval(secs => $4),
    updated_at = NOW()
WHERE id = $1
  AND status = 'processing'
  AND attempts = $2
`

type RetryGitHubWebhookJobParams struct {
	ID               int64   `json:"id"`
	ExpectedAttempts int32   `json:"expected_attempts"`
	Error            string  `json:"error"`
	BackoffSeconds   float64 `json:"backoff_seconds"`
}

// RetryGitHubWebhookJob re-pends a transiently failed claim generation so a
// later poll re-claims it after the backoff window, and returns the rows it
// changed; 0 means the claim was lost.
func (q *Queries) RetryGitHubWebhookJob(ctx context.Context, arg RetryGitHubWebhookJobParams) (int64, error) {
	tag, err := q.db.Exec(ctx, retryGitHubWebhookJob, arg.ID, arg.ExpectedAttempts, strings.TrimSpace(arg.Error), arg.BackoffSeconds)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
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
