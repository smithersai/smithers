-- A staged delete or ownership move has one durable receipt across embedded
-- and hosted repository services. storage_route_key is an opaque trusted route
-- handle: "static" addresses the embedded service, while a hosted adapter may
-- resolve it through its private placement catalog. It is never a URL or a
-- column on the product repository row.
CREATE TABLE public.repository_storage_operations (
    repository_id bigint PRIMARY KEY,
    operation_type varchar(16) NOT NULL CHECK (operation_type IN ('delete', 'move')),
    token varchar(64) NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
    storage_route_key text NOT NULL CHECK (btrim(storage_route_key) <> ''),
    source_owner varchar(255) NOT NULL CHECK (btrim(source_owner) <> ''),
    source_repo varchar(255) NOT NULL CHECK (btrim(source_repo) <> ''),
    source_user_id bigint,
    source_org_id bigint,
    target_owner varchar(255),
    target_repo varchar(255),
    target_user_id bigint,
    target_org_id bigint,
    claim_token varchar(64),
    claimed_at timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(source_user_id, source_org_id) = 1),
    CHECK (
        (operation_type = 'delete' AND target_owner IS NULL AND target_repo IS NULL
            AND target_user_id IS NULL AND target_org_id IS NULL)
        OR
        (operation_type = 'move' AND target_owner IS NOT NULL AND target_repo IS NOT NULL
            AND btrim(target_owner) <> '' AND btrim(target_repo) <> ''
            AND num_nonnulls(target_user_id, target_org_id) = 1)
    ),
    CHECK ((claim_token IS NULL AND claimed_at IS NULL)
        OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE INDEX idx_repository_storage_operations_reconcile
    ON public.repository_storage_operations(created_at, claimed_at, repository_id);

-- Every metadata mutation while a storage journal exists is fenced by its
-- token. A direct delete or owner transfer cannot bypass staged jj storage.
CREATE OR REPLACE FUNCTION public.smithers_product_repository_storage_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    pending public.repository_storage_operations%ROWTYPE;
    authorized_token text := nullif(current_setting('smithers.repository_storage_operation_token', true), '');
BEGIN
    SELECT * INTO pending FROM public.repository_storage_operations WHERE repository_id = OLD.id;
    IF TG_OP = 'DELETE' THEN
        IF NOT FOUND OR pending.operation_type <> 'delete'
            OR pending.token IS DISTINCT FROM authorized_token
            OR OLD.user_id IS DISTINCT FROM pending.source_user_id
            OR OLD.org_id IS DISTINCT FROM pending.source_org_id
            OR OLD.name IS DISTINCT FROM pending.source_repo
            OR OLD.lower_name IS DISTINCT FROM lower(pending.source_repo) THEN
            RAISE EXCEPTION 'repository deletion requires its durable storage journal' USING ERRCODE = '55006';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name OR NEW.lower_name IS DISTINCT FROM OLD.lower_name THEN
        RAISE EXCEPTION 'repository storage namespace is immutable' USING ERRCODE = '0A000';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
        IF NOT FOUND OR pending.operation_type <> 'move'
            OR pending.token IS DISTINCT FROM authorized_token
            OR OLD.user_id IS DISTINCT FROM pending.source_user_id
            OR OLD.org_id IS DISTINCT FROM pending.source_org_id
            OR OLD.name IS DISTINCT FROM pending.source_repo
            OR NEW.user_id IS DISTINCT FROM pending.target_user_id
            OR NEW.org_id IS DISTINCT FROM pending.target_org_id
            OR NEW.name IS DISTINCT FROM pending.target_repo THEN
            RAISE EXCEPTION 'repository transfer requires its durable storage journal' USING ERRCODE = '55006';
        END IF;
        RETURN NEW;
    END IF;
    IF FOUND THEN
        RAISE EXCEPTION 'repository storage operation is unresolved' USING ERRCODE = '55006';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER repository_storage_fence
BEFORE UPDATE OR DELETE ON public.repositories
FOR EACH ROW EXECUTE FUNCTION public.smithers_product_repository_storage_fence();

-- Owner FK cascades must not erase repository metadata before its jj storage
-- has been staged and its durable receipt committed.
CREATE OR REPLACE FUNCTION public.smithers_product_repository_owner_delete_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'users' AND EXISTS (SELECT 1 FROM public.repositories WHERE user_id = OLD.id) THEN
        RAISE EXCEPTION 'user still owns repositories' USING ERRCODE = '55006';
    END IF;
    IF TG_TABLE_NAME = 'organizations' AND EXISTS (SELECT 1 FROM public.repositories WHERE org_id = OLD.id) THEN
        RAISE EXCEPTION 'organization still owns repositories' USING ERRCODE = '55006';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER repository_user_delete_fence
BEFORE DELETE ON public.users FOR EACH ROW
EXECUTE FUNCTION public.smithers_product_repository_owner_delete_fence();
CREATE TRIGGER repository_org_delete_fence
BEFORE DELETE ON public.organizations FOR EACH ROW
EXECUTE FUNCTION public.smithers_product_repository_owner_delete_fence();
