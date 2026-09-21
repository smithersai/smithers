-- name: CreateSSETicket :one
INSERT INTO sse_tickets (ticket_hash, user_id, expires_at)
VALUES (sqlc.arg(ticket_hash), sqlc.arg(user_id), sqlc.arg(expires_at))
RETURNING *;

-- name: ConsumeSSETicket :one
UPDATE sse_tickets
SET used_at = NOW()
WHERE ticket_hash = sqlc.arg(ticket_hash)
  AND used_at IS NULL
  AND expires_at > NOW()
RETURNING *;

-- name: DeleteExpiredSSETickets :exec
DELETE FROM sse_tickets
WHERE expires_at < NOW();
