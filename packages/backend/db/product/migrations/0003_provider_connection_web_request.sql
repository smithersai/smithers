CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_web_request
    ON public.provider_connections (user_id, label) WHERE owner_type = 'user' AND label LIKE 'web-%';
