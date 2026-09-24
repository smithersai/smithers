-- Per-user proof that the user's own GitHub credential read a repository live.
-- The shared metadata store serves a user only while their grant is fresh; the
-- live read stays the only authorization source.
CREATE TABLE public.github_synced_repo_read_grants (
    user_id bigint NOT NULL,
    owner_login_lower character varying(255) NOT NULL,
    repo_name_lower character varying(255) NOT NULL,
    verified_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.github_synced_repo_read_grants
    ADD CONSTRAINT github_synced_repo_read_grants_pkey PRIMARY KEY (user_id, owner_login_lower, repo_name_lower);

ALTER TABLE ONLY public.github_synced_repo_read_grants
    ADD CONSTRAINT github_synced_repo_read_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
