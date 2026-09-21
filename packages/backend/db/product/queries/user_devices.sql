-- Device tokens for approval push notifications.

-- name: UpsertUserDevice :one
WITH reassigned AS (
    -- A push token identifies one physical device: registering it takes it
    -- away from any other account so pushes never reach a previous owner.
    DELETE FROM user_devices
    WHERE apns_token = $2
      AND user_id <> $1
),
pruned AS (
    -- Cap devices per user at 50: keep the 49 most recently seen rows plus
    -- the row inserted/updated below.
    DELETE FROM user_devices
    WHERE user_id = $1
      AND id IN (
          SELECT id FROM user_devices
          WHERE user_id = $1
            AND apns_token <> $2
          ORDER BY last_seen_at DESC, id DESC
          OFFSET 49
      )
)
INSERT INTO user_devices (
    user_id, apns_token, platform
)
VALUES (
    $1, $2, $3
)
ON CONFLICT (user_id, apns_token)
DO UPDATE SET
    platform = EXCLUDED.platform,
    last_seen_at = NOW()
RETURNING *;

-- name: DeleteUserDevice :exec
DELETE FROM user_devices
WHERE user_id = $1
  AND apns_token = $2;

-- name: ListAPNSDevicesForUser :many
-- LIMIT mirrors the 50-device-per-user cap enforced by UpsertUserDevice as a
-- defensive bound on push fan-out.
SELECT * FROM user_devices
WHERE user_id = $1
  AND platform = 'ios'
ORDER BY last_seen_at DESC
LIMIT 50;
