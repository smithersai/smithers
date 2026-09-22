-- Link the product workflow projection to its canonical coding Flow receipt.
-- Keep the existing Plue object definitions so adoption can recognize them.
CREATE TABLE public.workflow_run_coding_hosts (
    workflow_run_id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    host_run_id text NOT NULL,
    flow_id text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT workflow_run_coding_hosts_flow_id_present CHECK ((flow_id <> ''::text)),
    CONSTRAINT workflow_run_coding_hosts_host_run_id_present CHECK ((host_run_id <> ''::text))
);

ALTER TABLE ONLY public.workflow_run_coding_hosts
    ADD CONSTRAINT workflow_run_coding_hosts_pkey PRIMARY KEY (workflow_run_id);

CREATE INDEX idx_workflow_run_coding_hosts_workspace ON public.workflow_run_coding_hosts USING btree (workspace_id, workflow_run_id);

ALTER TABLE ONLY public.workflow_run_coding_hosts
    ADD CONSTRAINT workflow_run_coding_hosts_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_run_coding_hosts
    ADD CONSTRAINT workflow_run_coding_hosts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
