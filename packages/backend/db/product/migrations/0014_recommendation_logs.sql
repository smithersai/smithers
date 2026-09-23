CREATE TABLE public.recommendation_logs (
    id text PRIMARY KEY,
    repo text,
    tail_digest text NOT NULL,
    command_count integer NOT NULL CHECK (command_count >= 0),
    commands text[] NOT NULL DEFAULT '{}',
    model text NOT NULL,
    outcome_command text,
    outcome_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recommendation_logs_created_at_idx
    ON public.recommendation_logs (created_at DESC);
