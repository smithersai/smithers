-- name: GetNotificationByID :one
SELECT *
FROM notifications
WHERE id = $1;

-- name: ListNotificationsByUser :many
SELECT *
FROM notifications
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CreateNotification :one
-- Lock before evaluating the default ID, so IDs commit in order per user.
WITH recipient AS (
    SELECT users.id FROM users WHERE users.id = sqlc.arg(user_id) FOR UPDATE
)
INSERT INTO notifications (user_id, source_type, source_id, subject, body)
SELECT recipient.id, sqlc.arg(source_type), sqlc.arg(source_id), sqlc.arg(subject), sqlc.arg(body)
FROM recipient
RETURNING *;

-- name: CountNotificationsByUser :one
SELECT COUNT(*)
FROM notifications
WHERE user_id = $1;

-- name: NotifyUser :exec
SELECT pg_notify(
    'user_notifications_' || sqlc.arg(user_id)::bigint::text,
    sqlc.arg(payload)::text
);

-- name: MarkNotificationRead :exec
WITH recipient AS (
    SELECT users.id FROM users WHERE users.id = sqlc.arg(user_id) FOR UPDATE
)
UPDATE notifications n
SET status = 'read', read_at = NOW(), updated_at = NOW()
FROM recipient
WHERE n.id = sqlc.arg(id) AND n.user_id = recipient.id;

-- name: ListNotificationsAfterID :many
SELECT *
FROM notifications
WHERE user_id = $1
  AND id > sqlc.arg(after_id)
ORDER BY id ASC
LIMIT sqlc.arg(max_results);

-- name: MarkAllNotificationsRead :exec
WITH recipient AS (
    SELECT users.id FROM users WHERE users.id = sqlc.arg(user_id) FOR UPDATE
)
UPDATE notifications n
SET status = 'read', read_at = NOW(), updated_at = NOW()
FROM recipient
WHERE n.user_id = recipient.id AND n.status = 'unread';

-- name: ListNotificationsByUserKeyset :many
-- Stable cursor pagination: returns notifications with id < before_id (DESC),
-- or all notifications when before_id = 0 (first page).
SELECT *
FROM notifications
WHERE user_id = sqlc.arg(user_id)
  AND (sqlc.arg(before_id)::bigint = 0 OR id < sqlc.arg(before_id)::bigint)
ORDER BY id DESC
LIMIT sqlc.arg(page_size);

-- name: GetNotificationStreamHead :one
WITH recipient AS (
    SELECT users.id FROM users WHERE users.id = sqlc.arg(user_id) FOR UPDATE
)
SELECT COALESCE(MAX(n.id), 0)::bigint AS head
FROM recipient LEFT JOIN notifications n ON n.user_id = recipient.id;
