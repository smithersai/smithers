-- Push events from repo-host, recorded before the API acknowledges the
-- callback so a restart cannot drop webhooks, change sync, workflow runs or
-- search indexing. delivery_id deduplicates repo-host redeliveries;
-- steps_done records which side effects already ran so a retry never
-- repeats one (a second workflow dispatch would create duplicate runs).
CREATE TABLE public.repo_push_events (
    id bigserial PRIMARY KEY,
    delivery_id text NOT NULL UNIQUE,
    repository_id bigint NOT NULL REFERENCES public.repositories(id) ON DELETE CASCADE,
    owner text NOT NULL,
    repo text NOT NULL,
    ref_name text NOT NULL,
    before_sha text NOT NULL DEFAULT '',
    commit_sha text NOT NULL DEFAULT '',
    pusher_id bigint NOT NULL DEFAULT 0,
    pusher_login text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    steps_done text[] NOT NULL DEFAULT '{}',
    attempts integer NOT NULL DEFAULT 0,
    error text NOT NULL DEFAULT '',
    available_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX repo_push_events_claim_idx
    ON public.repo_push_events (status, available_at, id);
