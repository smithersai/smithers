-- Durable product onboarding and workspace setup receipts.
CREATE TABLE public.onboarding_answers (
    user_id bigint NOT NULL,
    answers jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT onboarding_answers_object CHECK ((jsonb_typeof(answers) = 'object'::text))
);

CREATE TABLE public.workspace_setup_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    request jsonb NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    workflow_run_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_setup_request_object CHECK ((jsonb_typeof(request) = 'object'::text)),
    CONSTRAINT workspace_setup_status CHECK ((status = ANY (ARRAY['accepted'::text, 'queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.onboarding_answers
    ADD CONSTRAINT onboarding_answers_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.workspace_setup_jobs
    ADD CONSTRAINT workspace_setup_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workspace_setup_jobs
    ADD CONSTRAINT workspace_setup_jobs_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);

CREATE INDEX workspace_setup_jobs_user_created_idx ON public.workspace_setup_jobs USING btree (user_id, created_at DESC);

ALTER TABLE ONLY public.onboarding_answers
    ADD CONSTRAINT onboarding_answers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workspace_setup_jobs
    ADD CONSTRAINT workspace_setup_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workspace_setup_jobs
    ADD CONSTRAINT workspace_setup_jobs_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE SET NULL;
