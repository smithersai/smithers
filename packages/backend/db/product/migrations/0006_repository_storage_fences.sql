-- Every metadata mutation while a storage journal exists is fenced by its
-- token. A direct delete or owner transfer cannot bypass staged jj storage.
CREATE FUNCTION public.smithers_product_repository_storage_fence()
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
CREATE FUNCTION public.smithers_product_repository_owner_delete_fence()
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
