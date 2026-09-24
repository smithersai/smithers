-- Deleting an SSH public key (user key or deploy key) must end the SSH
-- sessions that key authenticated. key_fingerprint names the credential in
-- SHA256:<base64> form, matching what the SSH server records at connect time.
ALTER TABLE ONLY public.revocation_events
    ADD COLUMN key_fingerprint text DEFAULT ''::text NOT NULL;

ALTER TABLE ONLY public.revocation_events
    DROP CONSTRAINT IF EXISTS revocation_events_kind_check;

ALTER TABLE ONLY public.revocation_events
    ADD CONSTRAINT revocation_events_kind_check CHECK ((kind = ANY (ARRAY['token_revoked'::text, 'token_scopes_narrowed'::text, 'user_disabled'::text, 'user_enabled'::text, 'collaborator_removed'::text, 'workspace_share_removed'::text, 'agent_session_cancelled'::text, 'org_member_removed'::text, 'gateway_revoked'::text, 'ssh_key_revoked'::text])));
