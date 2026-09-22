-- A write-only browser enrollment uses its public request id as a label.
-- It may outlive a page reload, but repeated POSTs must never add another token.
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_web_request
    ON provider_connections (user_id, label) WHERE owner_type = 'user' AND label LIKE 'web-%';
