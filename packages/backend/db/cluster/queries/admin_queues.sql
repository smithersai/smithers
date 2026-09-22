-- Private cluster queries kept separate from the product graph.

-- name: GetAdminQueueMetrics :many
-- Backlog includes delayed retries. Age is time since enqueue, zero when empty.
-- Retrying webhook deliveries and queued replication jobs use 'pending'.
-- Storage deletion rows remain queued until deleted, including held/claimed rows.
SELECT 'landing_tasks'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM landing_tasks WHERE status IN ('pending', 'append_pending')
UNION ALL
SELECT 'github_webhook_jobs'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM github_webhook_jobs WHERE status = 'pending'
UNION ALL
SELECT 'webhook_deliveries'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM webhook_deliveries WHERE status = 'pending'
UNION ALL
SELECT 'alert_remediation_jobs'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM alert_remediation_jobs WHERE status = 'pending'
UNION ALL
SELECT 'storage_deletion_queue'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM storage_deletion_queue WHERE TRUE
UNION ALL
SELECT 'import_jobs'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM import_jobs WHERE status = 'cloning'
UNION ALL
SELECT 'repo_replication_jobs'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM repo_replication_jobs WHERE state = 'pending'
UNION ALL
SELECT 'pair_prompt_queue'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM pair_prompt_queue WHERE status = 'queued'
UNION ALL
SELECT 'workflow_tasks_runner'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(wt.created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM workflow_tasks wt JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
WHERE wt.status = 'pending' AND wr.execution_plane = 'runner'
UNION ALL
SELECT 'workflow_tasks_sandbox'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(wt.created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM workflow_tasks wt JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
WHERE wt.status = 'pending' AND wr.execution_plane = 'sandbox'
UNION ALL
SELECT 'workflow_tasks_agent'::text AS queue, COUNT(*)::bigint AS depth,
       COALESCE(GREATEST(EXTRACT(EPOCH FROM NOW() - MIN(wt.created_at)), 0), 0)::double precision AS oldest_age_seconds
FROM workflow_tasks wt JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
WHERE wt.status = 'pending' AND wr.execution_plane = 'agent';
