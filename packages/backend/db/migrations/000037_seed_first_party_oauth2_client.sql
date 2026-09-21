-- Ticket 0106: seed the first-party public OAuth2 client used by the plue
-- gui (macOS) and iOS apps.
--
-- This is a PUBLIC OAuth2 client (confidential=false, no usable client
-- secret). Token exchange requires PKCE S256 per RFC 7636 and RFC 8252 §6.
-- The client_id is intentionally stable and well-known so apps can embed
-- it at build time; that is safe for a public client because PKCE binds
-- each authorization code to the specific app instance that started the
-- flow (an attacker cannot redeem a stolen code without the code_verifier
-- held in the originating app's memory).
--
-- Redirect URIs:
--   * smithers://oauth2/callback             — iOS custom URL scheme
--                                              (ASWebAuthenticationSession)
--   * smithers://auth/callback               — macOS custom URL scheme
--                                              (desktop app legacy path)
--   * http://127.0.0.1/callback              — macOS loopback (RFC 8252
--                                              §7.3). The service's
--                                              redirect URI validator
--                                              matches this entry
--                                              port-agnostically, so the
--                                              macOS app can pick a
--                                              random ephemeral port at
--                                              runtime.
--   * http://[::1]/callback                  — macOS loopback (IPv6).
--
-- Scopes: read:user, write:user, read:repository, write:repository,
-- read:org. The apps may request a subset. Scope widening requires
-- updating this migration.
--
-- client_secret_hash is set to a well-known impossible value so that
-- a confidential-style token exchange (which checks the secret via a
-- constant-time hash compare) always fails if this row is ever flipped
-- to confidential=true by a bug or manual edit.

INSERT INTO oauth2_applications (
    owner_id,
    name,
    client_id,
    client_secret_hash,
    redirect_uris,
    scopes,
    confidential,
    created_at,
    updated_at
)
SELECT
    u.id,
    'plue first-party apps (gui, iOS)',
    'smithers_first_party_apps',
    'public-client-no-secret',
    ARRAY[
        'smithers://oauth2/callback',
        'smithers://auth/callback',
        'http://127.0.0.1/callback',
        'http://[::1]/callback'
    ],
    ARRAY['read:user', 'write:user', 'read:repository', 'write:repository', 'read:org'],
    FALSE,
    NOW(),
    NOW()
FROM users u
WHERE u.is_admin = TRUE
ORDER BY u.id ASC
LIMIT 1
ON CONFLICT (client_id) DO NOTHING;
