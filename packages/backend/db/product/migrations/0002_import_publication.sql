-- A local import's durable reservation is its import_jobs row. These fields
-- let a restarted worker publish an already-pushed mirror without asking
-- GitHub again or depending on the cluster provisioning journal.
ALTER TABLE public.import_jobs
    ADD COLUMN default_bookmark text NOT NULL DEFAULT '',
    ADD COLUMN publish_ready boolean NOT NULL DEFAULT false;
