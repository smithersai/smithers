-- Invite by GitHub username (2026-07-05 product delta). Plue usernames ARE
-- GitHub logins (OAuth sign-up sets users.username = profile.login), so a
-- username-keyed invite matches the signed-in visitor's login exactly the way
-- an email invite matches their primary email. lower_email becomes nullable;
-- every invite must carry at least one join key. Username invites cannot be
-- emailed when the target has no plue account yet — the mint response's raw
-- token link stays the honest delivery path for those.
ALTER TABLE pair_session_invites ALTER COLUMN lower_email DROP NOT NULL;

ALTER TABLE pair_session_invites ADD COLUMN lower_github_username TEXT;

ALTER TABLE pair_session_invites ADD CONSTRAINT pair_session_invites_join_key_present
    CHECK (lower_email IS NOT NULL OR lower_github_username IS NOT NULL);

-- Resolve a signed-in visitor's login against live invites for a session
-- (mirrors pair_session_invites_session_email).
CREATE INDEX pair_session_invites_session_username
    ON pair_session_invites (session_id, lower_github_username)
    WHERE revoked_at IS NULL;
