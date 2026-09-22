-- A repository create or fork reserves its identity before touching the jj
-- store. The operation survives a process crash until storage, metadata, and
-- the staged repository journal have all settled.
CREATE TABLE public.repository_creation_jobs (
    repository_id bigint PRIMARY KEY,
    token text NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
    operation_type text NOT NULL CHECK (operation_type IN ('init', 'fork')),
    actor_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    user_id bigint REFERENCES public.users(id) ON DELETE RESTRICT,
    org_id bigint REFERENCES public.organizations(id) ON DELETE RESTRICT,
    owner_name text NOT NULL,
    name varchar(255) NOT NULL,
    lower_name varchar(255) NOT NULL,
    description text NOT NULL DEFAULT '',
    is_public boolean NOT NULL,
    default_bookmark varchar(255) NOT NULL,
    auto_init boolean NOT NULL DEFAULT false,
    source_repository_id bigint REFERENCES public.repositories(id) ON DELETE RESTRICT,
    source_owner text,
    source_repo text,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT repository_creation_owner CHECK (num_nonnulls(user_id, org_id) = 1),
    CONSTRAINT repository_creation_source CHECK (
        (operation_type = 'init' AND source_repository_id IS NULL AND source_owner IS NULL AND source_repo IS NULL)
        OR (operation_type = 'fork' AND user_id IS NOT NULL AND source_repository_id IS NOT NULL
            AND source_owner IS NOT NULL AND source_repo IS NOT NULL)
    ),
    CONSTRAINT repository_creation_name CHECK (lower_name = lower(name))
);
CREATE UNIQUE INDEX repository_creation_user_name
    ON public.repository_creation_jobs(user_id, lower_name) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX repository_creation_org_name
    ON public.repository_creation_jobs(org_id, lower_name) WHERE org_id IS NOT NULL;

-- Use the same namespace lock for reservations and all repository inserts or
-- owner/name changes. Other writers cannot slip a row between the reservation
-- check and its commit, and cannot publish over a pending staged repository.
CREATE OR REPLACE FUNCTION public.smithers_product_repository_namespace_key(
    p_user_id bigint, p_org_id bigint, p_lower_name text
) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
    SELECT hashtextextended(
        CASE WHEN p_user_id IS NOT NULL THEN 'user:' || p_user_id::text
             ELSE 'org:' || p_org_id::text END || ':' || lower(p_lower_name), 0)
$$;

CREATE OR REPLACE FUNCTION public.smithers_product_repository_creation_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending public.repository_creation_jobs%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM public.repository_creation_jobs WHERE repository_id = OLD.id) THEN
            RAISE EXCEPTION 'repository creation has not finalized' USING ERRCODE = '23503';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND
       (OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.org_id IS DISTINCT FROM NEW.org_id
        OR OLD.lower_name IS DISTINCT FROM NEW.lower_name) AND
       EXISTS (SELECT 1 FROM public.repository_creation_jobs WHERE repository_id = OLD.id) THEN
        RAISE EXCEPTION 'repository creation has not finalized' USING ERRCODE = '23503';
    END IF;
    PERFORM pg_advisory_xact_lock(public.smithers_product_repository_namespace_key(
        NEW.user_id, NEW.org_id, NEW.lower_name));
    SELECT * INTO pending FROM public.repository_creation_jobs
      WHERE lower_name = NEW.lower_name
        AND ((NEW.user_id IS NOT NULL AND user_id = NEW.user_id)
          OR (NEW.org_id IS NOT NULL AND org_id = NEW.org_id));
    IF FOUND AND (TG_OP = 'INSERT' OR NEW.id <> pending.repository_id)
       AND current_setting('smithers.product_repository_creation_token', true) IS DISTINCT FROM pending.token THEN
        RAISE EXCEPTION 'repository namespace is reserved for creation' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER repository_creation_fence
BEFORE INSERT OR UPDATE OF user_id, org_id, lower_name ON public.repositories
FOR EACH ROW EXECUTE FUNCTION public.smithers_product_repository_creation_fence();

CREATE TRIGGER repository_creation_delete_fence
BEFORE DELETE ON public.repositories
FOR EACH ROW EXECUTE FUNCTION public.smithers_product_repository_creation_fence();
