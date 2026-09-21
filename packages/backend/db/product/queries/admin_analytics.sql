-- Product queries extracted from the transitional Plue source.

-- name: AnalyticsUsers :one
-- Total/human/synthetic are all-time inventory (including synthetic users). New and active users respect the filter; active is the distinct union of workspace activity, agent creation, landing creation, and auth-session creation.
WITH active_users AS (
 SELECT w.user_id FROM workspaces w WHERE w.last_activity_at >= sqlc.arg(range_start)::timestamptz AND w.last_activity_at < sqlc.arg(range_end)::timestamptz
 UNION SELECT a.user_id FROM agent_sessions a WHERE a.created_at >= sqlc.arg(range_start)::timestamptz AND a.created_at < sqlc.arg(range_end)::timestamptz
 UNION SELECT l.author_id FROM landing_requests l WHERE l.created_at >= sqlc.arg(range_start)::timestamptz AND l.created_at < sqlc.arg(range_end)::timestamptz
 UNION SELECT a.user_id FROM auth_sessions a WHERE a.created_at >= sqlc.arg(range_start)::timestamptz AND a.created_at < sqlc.arg(range_end)::timestamptz
)
SELECT count(*)::bigint AS total,
 count(*) FILTER (WHERE NOT u.is_synthetic)::bigint AS human,
 count(*) FILTER (WHERE u.is_synthetic)::bigint AS synthetic,
 count(*) FILTER (WHERE (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) AND u.created_at >= sqlc.arg(range_start)::timestamptz AND u.created_at < sqlc.arg(range_end)::timestamptz)::bigint AS new_in_range,
 count(*) FILTER (WHERE (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) AND EXISTS (SELECT 1 FROM active_users a WHERE a.user_id=u.id))::bigint AS active_in_range
FROM users u;


-- name: AnalyticsSignupsByDay :many
-- UTC calendar days, including zero days, counting users created in range after the synthetic filter.
WITH days AS (
 SELECT generate_series(sqlc.arg(range_start)::timestamptz AT TIME ZONE 'UTC', date_trunc('day', sqlc.arg(range_end)::timestamptz AT TIME ZONE 'UTC'), interval '1 day') AS day
), counts AS (
 SELECT (u.created_at AT TIME ZONE 'UTC')::date AS day, count(*)::bigint AS count
 FROM users u WHERE u.created_at >= sqlc.arg(range_start)::timestamptz AND u.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY 1
)
SELECT to_char(d.day, 'YYYY-MM-DD')::text AS day, coalesce(c.count,0)::bigint AS count
FROM days d LEFT JOIN counts c ON c.day=d.day::date ORDER BY d.day;


-- name: AnalyticsActivation :one
-- All-time first-occurrence counts per user, not a sequential funnel. Non-synthetic by default; include_synthetic disables this filter too. GitHub requires provider github, boot requires started_at, merged landing requires authored merged_at.
SELECT count(*)::bigint AS signup,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM oauth_accounts a WHERE a.user_id=u.id AND a.provider='github'))::bigint AS github_connected,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM repositories r WHERE r.user_id=u.id))::bigint AS first_repo,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.user_id=u.id AND w.started_at IS NOT NULL))::bigint AS workspace_booted,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agent_sessions a WHERE a.user_id=u.id))::bigint AS first_agent_run,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM landing_requests l WHERE l.author_id=u.id AND l.merged_at IS NOT NULL))::bigint AS first_landing_merged
FROM users u WHERE (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic);


-- name: AnalyticsWorkspacesByKindStatus :many
-- Current kind/status of workspaces created in range, filtered by workspace owning user_id.
SELECT w.kind, w.status, count(*)::bigint AS count FROM workspaces w JOIN users u ON u.id=w.user_id WHERE w.created_at >= sqlc.arg(range_start)::timestamptz AND w.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY w.kind,w.status ORDER BY w.kind,w.status;


-- name: AnalyticsWorkspacesByDay :many
-- UTC day series with zeros. Count is all included creations; synthetic_count is zero unless synthetic rows are included. Ownership uses workspaces.user_id.
WITH days AS (
 SELECT generate_series(sqlc.arg(range_start)::timestamptz AT TIME ZONE 'UTC', date_trunc('day', sqlc.arg(range_end)::timestamptz AT TIME ZONE 'UTC'), interval '1 day') AS day
), counts AS (
 SELECT (w.created_at AT TIME ZONE 'UTC')::date AS day, count(*)::bigint AS count,
 count(*) FILTER (WHERE u.is_synthetic)::bigint AS synthetic_count
 FROM workspaces w JOIN users u ON u.id=w.user_id WHERE w.created_at >= sqlc.arg(range_start)::timestamptz AND w.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY 1
)
SELECT to_char(d.day,'YYYY-MM-DD')::text AS day, coalesce(c.count,0)::bigint AS count,
 coalesce(c.synthetic_count,0)::bigint AS synthetic_count
FROM days d LEFT JOIN counts c ON c.day=d.day::date ORDER BY d.day;


-- name: AnalyticsWorkspaceFailures :many
-- Failure code/message counts for failed workspaces created in range, filtered by workspace owner.
SELECT coalesce(w.failure_code,'')::text AS code, coalesce(w.failure_message,'')::text AS message, count(*)::bigint AS count FROM workspaces w JOIN users u ON u.id=w.user_id WHERE w.created_at >= sqlc.arg(range_start)::timestamptz AND w.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) AND w.status='failed' GROUP BY w.failure_code,w.failure_message ORDER BY count DESC,code,message;


-- name: AnalyticsWorkspaceBoot :one
-- Boot percentiles are started_at minus created_at for workspaces created in range with started_at present. Empty populations return zero seconds.
SELECT coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (w.started_at-w.created_at))),0)::float8 AS boot_p50_seconds,
 coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (w.started_at-w.created_at))),0)::float8 AS boot_p95_seconds
 FROM workspaces w JOIN users u ON u.id=w.user_id WHERE w.created_at >= sqlc.arg(range_start)::timestamptz AND w.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) AND w.started_at IS NOT NULL;


-- name: AnalyticsWorkspacesActive :one
-- Active now is non-deleted running workspaces across all creation dates, filtered by workspace owner.
SELECT count(*)::bigint FROM workspaces w JOIN users u ON u.id=w.user_id WHERE w.status='running' AND w.deleted_at IS NULL AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic);


-- name: AnalyticsAgents :one
-- Sessions created in range, filtered by session owning user_id. Duration is finished_at minus started_at; empty percentiles are zero. Revision and landing metrics count sessions once via EXISTS, with revisions restricted to source agent; merged requires merged_at.
SELECT count(*)::bigint AS sessions_total,
 coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (a.finished_at-a.started_at))),0)::float8 AS duration_p50_seconds,
 coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (a.finished_at-a.started_at))),0)::float8 AS duration_p95_seconds,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM change_revisions c WHERE c.agent_session_id=a.id AND c.source='agent'))::bigint AS with_revisions,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM landing_requests l WHERE l.author_agent_session_id=a.id))::bigint AS with_landing_request,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM landing_requests l WHERE l.author_agent_session_id=a.id AND l.merged_at IS NOT NULL))::bigint AS merged
 FROM agent_sessions a JOIN users u ON u.id=a.user_id WHERE a.created_at >= sqlc.arg(range_start)::timestamptz AND a.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic);


-- name: AnalyticsAgentsByStatus :many
-- Current status counts for sessions created in range, filtered by session owner.
SELECT a.status, count(*)::bigint AS count FROM agent_sessions a JOIN users u ON u.id=a.user_id WHERE a.created_at >= sqlc.arg(range_start)::timestamptz AND a.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY a.status ORDER BY a.status;


-- name: AnalyticsStuckAgents :many
-- All-time live active sessions older than 1h without started_at, or older than 24h regardless of started_at. Owner filtering uses agent_sessions.user_id; repository names retain organization owners.
SELECT a.id, a.created_at, floor(extract(epoch FROM (sqlc.arg(range_end)::timestamptz-a.created_at)))::bigint AS age_seconds,
 u.username AS username, (coalesce(ru.username,o.name)||'/'||r.name)::text AS repository
 FROM agent_sessions a JOIN users u ON u.id=a.user_id
 JOIN repositories r ON r.id=a.repository_id LEFT JOIN users ru ON ru.id=r.user_id LEFT JOIN organizations o ON o.id=r.org_id
 WHERE a.status='active' AND a.deleted_at IS NULL AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic)
 AND ((a.started_at IS NULL AND a.created_at < sqlc.arg(range_end)::timestamptz-interval '1 hour') OR a.created_at < sqlc.arg(range_end)::timestamptz-interval '24 hours')
 ORDER BY a.created_at,a.id;


-- name: AnalyticsLandingByState :many
-- Current state counts for landing requests created in range; synthetic ownership follows the author_id user.
SELECT l.state,count(*)::bigint AS count FROM landing_requests l JOIN users u ON u.id=l.author_id WHERE l.created_at >= sqlc.arg(range_start)::timestamptz AND l.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY l.state ORDER BY l.state;


-- name: AnalyticsLanding :one
-- Merge rate is merged_at-present requests divided by all requests created in range (zero for no requests). Agent-authored counts use the flag, with merged_at for the merged subset; filtered by author.
SELECT coalesce(count(*) FILTER (WHERE l.merged_at IS NOT NULL)::float8 / nullif(count(*),0),0)::float8 AS merge_rate,
 count(*) FILTER (WHERE l.agent_authored)::bigint AS agent_authored,
 count(*) FILTER (WHERE l.agent_authored AND l.merged_at IS NOT NULL)::bigint AS agent_authored_merged FROM landing_requests l JOIN users u ON u.id=l.author_id WHERE l.created_at >= sqlc.arg(range_start)::timestamptz AND l.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic);


-- name: AnalyticsLandingCycle :one
-- Cycle time is merged_at minus created_at for requests merged in range, even if created earlier. Filtered by author; an empty population returns zero seconds.
SELECT coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (l.merged_at-l.created_at))),0)::float8 AS cycle_time_p50_seconds
FROM landing_requests l JOIN users u ON u.id=l.author_id WHERE l.merged_at >= sqlc.arg(range_start)::timestamptz AND l.merged_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic);


-- name: AnalyticsImportsByStatus :many
-- Current status counts for import jobs created in range, filtered by import_jobs.user_id.
SELECT i.status,count(*)::bigint AS count FROM import_jobs i JOIN users u ON u.id=i.user_id WHERE i.created_at >= sqlc.arg(range_start)::timestamptz AND i.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY i.status ORDER BY i.status;


-- name: AnalyticsImportFailures :many
-- Failure reasons use import_jobs.error on failed jobs created in range, filtered by job owner.
SELECT i.error AS reason,count(*)::bigint AS count FROM import_jobs i JOIN users u ON u.id=i.user_id WHERE i.created_at >= sqlc.arg(range_start)::timestamptz AND i.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) AND i.status='failed' GROUP BY i.error ORDER BY count DESC,reason;


-- name: AnalyticsImportsFailedByStage :many
-- Failed stage uses import_jobs.stage, not status, on failed jobs created in range, filtered by job owner.
SELECT i.stage,count(*)::bigint AS count FROM import_jobs i JOIN users u ON u.id=i.user_id WHERE i.created_at >= sqlc.arg(range_start)::timestamptz AND i.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) AND i.status='failed' GROUP BY i.stage ORDER BY count DESC,i.stage;


-- name: AnalyticsRepos :one
-- All-time repository total and creations in range, filtered through repositories.user_id. Org-owned repositories have no user owner and count as human.
SELECT count(*)::bigint AS total, count(*) FILTER (WHERE r.created_at >= sqlc.arg(range_start)::timestamptz AND r.created_at < sqlc.arg(range_end)::timestamptz)::bigint AS created_in_range
FROM repositories r LEFT JOIN users u ON u.id=r.user_id WHERE (sqlc.arg(include_synthetic)::boolean OR NOT coalesce(u.is_synthetic,false));


-- name: AnalyticsTopRepos :many
-- Top ten by workspace + session + landing creations in range. Each activity is filtered by its owning user (landing author); repository eligibility uses repositories.user_id, with org-owned repositories human. Separate aggregates prevent join multiplication; ties use owner/name/id.
WITH workspace_counts AS (
 SELECT w.repository_id,count(*)::bigint AS count FROM workspaces w JOIN users u ON u.id=w.user_id WHERE w.created_at >= sqlc.arg(range_start)::timestamptz AND w.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY w.repository_id
), agent_counts AS (
 SELECT a.repository_id,count(*)::bigint AS count FROM agent_sessions a JOIN users u ON u.id=a.user_id WHERE a.created_at >= sqlc.arg(range_start)::timestamptz AND a.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY a.repository_id
), landing_counts AS (
 SELECT l.repository_id,count(*)::bigint AS count FROM landing_requests l JOIN users u ON u.id=l.author_id WHERE l.created_at >= sqlc.arg(range_start)::timestamptz AND l.created_at < sqlc.arg(range_end)::timestamptz AND (sqlc.arg(include_synthetic)::boolean OR NOT u.is_synthetic) GROUP BY l.repository_id
)
SELECT coalesce(u.username,o.name)::text AS owner,r.name,
 coalesce(w.count,0)::bigint AS workspaces,coalesce(a.count,0)::bigint AS agent_sessions,coalesce(l.count,0)::bigint AS landing_requests
FROM repositories r LEFT JOIN users u ON u.id=r.user_id LEFT JOIN organizations o ON o.id=r.org_id
LEFT JOIN workspace_counts w ON w.repository_id=r.id LEFT JOIN agent_counts a ON a.repository_id=r.id LEFT JOIN landing_counts l ON l.repository_id=r.id
WHERE (sqlc.arg(include_synthetic)::boolean OR NOT coalesce(u.is_synthetic,false))
ORDER BY (coalesce(w.count,0)+coalesce(a.count,0)+coalesce(l.count,0)) DESC,owner,r.name,r.id LIMIT 10;


-- name: AdminSetUserSynthetic :one
-- Update the explicit synthetic classification; the admin user service emits admin.user.set_synthetic.
UPDATE users SET is_synthetic=sqlc.arg(synthetic)::boolean, updated_at=now()
WHERE lower_username=sqlc.arg(lower_username)::text RETURNING *;


-- name: AnalyticsStatementTimeout :exec
-- Transaction-local server-side timeout for the read-only analytics snapshot.
SELECT set_config('statement_timeout', '20s', true);
