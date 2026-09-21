-- SSE tickets: short-lived, single-use tokens for EventSource authentication.
-- Tickets are hashed at rest (SHA-256) and consumed atomically on first use.

CREATE TABLE IF NOT EXISTS sse_tickets (
    ticket_hash  VARCHAR(64) PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ
);

CREATE INDEX idx_sse_tickets_expires_at ON sse_tickets (expires_at);
CREATE INDEX idx_sse_tickets_user_id ON sse_tickets (user_id);
