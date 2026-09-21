-- name: GetNotificationPreferences :one
SELECT *
FROM user_notification_preferences
WHERE user_id = $1;

-- name: UpsertNotificationPreferences :one
INSERT INTO user_notification_preferences (user_id, notify_issues, notify_landings, notify_mentions)
VALUES (
    sqlc.arg(user_id),
    sqlc.arg(notify_issues),
    sqlc.arg(notify_landings),
    sqlc.arg(notify_mentions)
)
ON CONFLICT (user_id)
DO UPDATE SET
    notify_issues   = EXCLUDED.notify_issues,
    notify_landings = EXCLUDED.notify_landings,
    notify_mentions = EXCLUDED.notify_mentions,
    updated_at      = NOW()
RETURNING *;
