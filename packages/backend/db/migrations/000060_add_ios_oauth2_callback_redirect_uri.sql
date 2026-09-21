-- Ticket 0106 follow-up: ensure the first-party public OAuth2 client
-- includes the iOS callback URI used by ASWebAuthenticationSession.
--
-- Existing deployments may already have run 000037 with only
-- smithers://auth/callback, so this migration normalizes the allowlist.

UPDATE oauth2_applications
SET
    redirect_uris = ARRAY[
        'smithers://oauth2/callback',
        'smithers://auth/callback',
        'http://127.0.0.1/callback',
        'http://[::1]/callback'
    ],
    updated_at = NOW()
WHERE client_id = 'smithers_first_party_apps';
