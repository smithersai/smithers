-- A scheduling deadline is not a refresh lease. Every refresh route shares
-- this lease, and a generation fences late results after lease expiry.
ALTER TABLE provider_connections
    ADD COLUMN refresh_lease_until timestamptz,
    ADD COLUMN refresh_generation bigint NOT NULL DEFAULT 0;

-- Old notification IDs may belong to either source table. Resolve only when
-- the recipient's persisted mention contexts identify exactly one source kind.
WITH candidates AS (
    SELECT n.id, 'mention_issue' AS source_type
    FROM notifications n JOIN mentions m
      ON m.mentioned_user_id = n.user_id AND m.issue_id = n.source_id
    WHERE n.source_type = 'mention' AND m.created_at <= n.created_at
    UNION
    SELECT n.id, 'mention_landing' AS source_type
    FROM notifications n JOIN mentions m
      ON m.mentioned_user_id = n.user_id AND m.landing_request_id = n.source_id
    WHERE n.source_type = 'mention' AND m.created_at <= n.created_at
), resolved AS (
    SELECT id, min(source_type) AS source_type
    FROM candidates GROUP BY id HAVING count(*) = 1
)
UPDATE notifications n SET source_type = r.source_type
FROM resolved r WHERE n.id = r.id;
