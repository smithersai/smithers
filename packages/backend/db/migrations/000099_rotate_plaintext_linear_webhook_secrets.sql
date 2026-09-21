-- Rotate legacy plaintext Linear webhook secrets. New secrets are stored as
-- base64(AES-256-GCM ciphertext); legacy plaintext values were 64 hex chars.
-- Deactivated integrations must be reconfigured to receive Linear webhooks.
UPDATE linear_integrations
SET webhook_secret = '',
    is_active = FALSE,
    updated_at = NOW()
WHERE webhook_secret ~ '^[0-9a-f]{64}$';
