-- Enforce the 100-secret caps per repository and per organization atomically.
-- The secret service's count check is a friendly pre-check that concurrent
-- writers can race past; these triggers serialize writers on the owning row
-- and reject a new name beyond the cap. An upsert of an existing name is an
-- update, so it stays allowed at the cap.

CREATE FUNCTION public.enforce_repository_secret_cap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    secret_count BIGINT;
BEGIN
    PERFORM 1 FROM repositories WHERE id = NEW.repository_id FOR UPDATE;
    IF EXISTS (
        SELECT 1 FROM repository_secrets
        WHERE repository_id = NEW.repository_id AND name = NEW.name
    ) THEN
        RETURN NEW;
    END IF;
    SELECT COUNT(*) INTO secret_count
    FROM repository_secrets
    WHERE repository_id = NEW.repository_id;
    IF secret_count >= 100 THEN
        RAISE EXCEPTION 'repository % already has the maximum of 100 secrets', NEW.repository_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'repository_secrets_repo_cap';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_repository_secrets_repo_cap BEFORE INSERT ON public.repository_secrets
    FOR EACH ROW EXECUTE FUNCTION public.enforce_repository_secret_cap();

CREATE FUNCTION public.enforce_organization_secret_cap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    secret_count BIGINT;
BEGIN
    PERFORM 1 FROM organizations WHERE id = NEW.organization_id FOR UPDATE;
    IF EXISTS (
        SELECT 1 FROM organization_secrets
        WHERE organization_id = NEW.organization_id AND name = NEW.name
    ) THEN
        RETURN NEW;
    END IF;
    SELECT COUNT(*) INTO secret_count
    FROM organization_secrets
    WHERE organization_id = NEW.organization_id;
    IF secret_count >= 100 THEN
        RAISE EXCEPTION 'organization % already has the maximum of 100 secrets', NEW.organization_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'organization_secrets_org_cap';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_organization_secrets_org_cap BEFORE INSERT ON public.organization_secrets
    FOR EACH ROW EXECUTE FUNCTION public.enforce_organization_secret_cap();
