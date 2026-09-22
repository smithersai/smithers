-- Private cluster queries kept separate from the product graph.

-- name: AnalyticsGoldenSnapshots :many
-- Current kind/status counts for platform golden snapshots created in range. These rows have no user owner and are never synthetic-filtered.
SELECT g.kind,g.status,count(*)::bigint AS count FROM sandbox_golden_snapshots g WHERE g.created_at >= sqlc.arg(range_start)::timestamptz AND g.created_at < sqlc.arg(range_end)::timestamptz GROUP BY g.kind,g.status ORDER BY g.kind,g.status;

