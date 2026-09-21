-- Revision: 20260718000100.
-- Unify the user/organization owner namespace.
--
-- users.lower_username and organizations.lower_name were each unique only
-- within their own table, so the same owner slug could exist as both a user
-- and an organization. Repository lookups OR'ed both owner tables behind an
-- unordered LIMIT 1 and could resolve/authenticate/mutate the wrong
-- repository (including repo-host storage addressed by the shared slug).
--
-- owner_namespaces is the single transactional arbiter for owner slugs:
-- every live user and organization claims its slug here, and the primary key
-- makes cross-type collisions impossible. Sync triggers on
-- users/organizations keep claims current on INSERT and rename; FK cascades
-- release claims on hard delete. Soft-deleted users keep their claim, which
-- preserves the existing "usernames are not freed by soft delete" semantics
-- of users.lower_username UNIQUE.
--
-- Existing data: the migration fails atomically when a normalized slug is
-- already shared by more than one owner. Silently choosing a winner would
-- make the losing owner's repositories unreachable while repo-host storage
-- is still addressed by that slug. The error includes a stable, sorted sample
-- so an operator can explicitly rename/move one side before retrying.

CREATE TABLE IF NOT EXISTS owner_namespaces (
    lower_slug  VARCHAR(255) PRIMARY KEY CHECK (lower_slug = LOWER(lower_slug)),
    owner_type  VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    user_id     BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    org_id      BIGINT UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND org_id IS NULL)
        OR (owner_type = 'org' AND org_id IS NOT NULL AND user_id IS NULL)
    )
);

-- Old application pods do not know about owner_namespaces. Block their
-- owner writes for the remainder of this migration so no insert/rename/delete
-- can land between the collision check, backfill, and trigger installation.
-- SHARE ROW EXCLUSIVE still permits ordinary reads during the migration.
LOCK TABLE users, organizations IN SHARE ROW EXCLUSIVE MODE;

DO $owner_namespace_identity_check$
DECLARE
    invalid_count BIGINT;
    invalid_sample TEXT;
BEGIN
    WITH invalid AS (
        SELECT 'user:' || id::text AS identity
        FROM users
        WHERE lower_username <> LOWER(username)
           OR username !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
        UNION ALL
        SELECT 'org:' || id::text
        FROM organizations
        WHERE lower_name <> LOWER(name)
           OR name !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    )
    SELECT COUNT(*) INTO invalid_count FROM invalid;

    IF invalid_count > 0 THEN
        WITH invalid AS (
            SELECT 'user:' || id::text AS identity
            FROM users
            WHERE lower_username <> LOWER(username)
               OR username !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
            UNION ALL
            SELECT 'org:' || id::text
            FROM organizations
            WHERE lower_name <> LOWER(name)
               OR name !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
        )
        SELECT STRING_AGG(identity, ', ' ORDER BY identity)
        INTO invalid_sample
        FROM (SELECT identity FROM invalid ORDER BY identity LIMIT 20) sample;

        RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            MESSAGE = FORMAT('owner namespace migration blocked by %s invalid owner identity row(s)', invalid_count),
            DETAIL = FORMAT('Invalid identities (first 20): %s', invalid_sample),
            HINT = 'Make lower_* equal lower(exact_name) and move invalid repo-host path segments before retrying migration 20260718000100.';
    END IF;
END;
$owner_namespace_identity_check$;

ALTER TABLE users
    ADD CONSTRAINT ck_users_canonical_owner_namespace
    CHECK (
        lower_username = LOWER(username)
        AND username ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    );

ALTER TABLE organizations
    ADD CONSTRAINT ck_organizations_canonical_owner_namespace
    CHECK (
        lower_name = LOWER(name)
        AND name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    );

DO $owner_namespace_collision_check$
DECLARE
    collision_count  BIGINT;
    collision_sample TEXT;
BEGIN
    WITH candidates AS (
        SELECT LOWER(u.lower_username) AS lower_slug FROM users u
        UNION ALL
        SELECT LOWER(o.lower_name) FROM organizations o
    ), collisions AS (
        SELECT lower_slug
        FROM candidates
        GROUP BY lower_slug
        HAVING COUNT(*) > 1
    )
    SELECT COUNT(*) INTO collision_count FROM collisions;

    IF collision_count > 0 THEN
        WITH candidates AS (
            SELECT LOWER(u.lower_username) AS lower_slug FROM users u
            UNION ALL
            SELECT LOWER(o.lower_name) FROM organizations o
        ), collisions AS (
            SELECT lower_slug
            FROM candidates
            GROUP BY lower_slug
            HAVING COUNT(*) > 1
            ORDER BY lower_slug
            LIMIT 20
        )
        SELECT STRING_AGG(lower_slug, ', ' ORDER BY lower_slug)
        INTO collision_sample
        FROM collisions;

        RAISE EXCEPTION USING
            ERRCODE = 'unique_violation',
            MESSAGE = FORMAT(
                'owner namespace migration blocked by %s normalized slug collision(s)',
                collision_count
            ),
            DETAIL = FORMAT('Conflicting slugs (first 20): %s', collision_sample),
            HINT = 'Rename one owner and move its repo-host namespace before retrying migration 20260718000100.';
    END IF;
END;
$owner_namespace_collision_check$;

-- The collision check guarantees this backfill is one-to-one. LOWER() also
-- is already canonical by the preflight above; the namespace CHECK keeps
-- future claims canonical.
INSERT INTO owner_namespaces (lower_slug, owner_type, user_id, org_id)
    SELECT LOWER(u.lower_username) AS lower_slug,
           'user' AS owner_type,
           u.id AS user_id,
           NULL::bigint AS org_id
    FROM users u
    UNION ALL
    SELECT LOWER(o.lower_name),
           'org',
           NULL::bigint,
           o.id
    FROM organizations o;

CREATE OR REPLACE FUNCTION sync_user_owner_namespace()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO owner_namespaces (lower_slug, owner_type, user_id)
        VALUES (LOWER(NEW.lower_username), 'user', NEW.id);
    ELSIF NEW.lower_username IS DISTINCT FROM OLD.lower_username THEN
        UPDATE owner_namespaces
        SET lower_slug = LOWER(NEW.lower_username)
        WHERE user_id = NEW.id;
        IF NOT FOUND THEN
            INSERT INTO owner_namespaces (lower_slug, owner_type, user_id)
            VALUES (LOWER(NEW.lower_username), 'user', NEW.id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_org_owner_namespace()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO owner_namespaces (lower_slug, owner_type, org_id)
        VALUES (LOWER(NEW.lower_name), 'org', NEW.id);
    ELSIF NEW.lower_name IS DISTINCT FROM OLD.lower_name THEN
        UPDATE owner_namespaces
        SET lower_slug = LOWER(NEW.lower_name)
        WHERE org_id = NEW.id;
        IF NOT FOUND THEN
            INSERT INTO owner_namespaces (lower_slug, owner_type, org_id)
            VALUES (LOWER(NEW.lower_name), 'org', NEW.id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Repository storage paths include the exact user/organization name. Old or
-- direct writers can still update these columns even though the current user
-- service does not expose username changes. Changing either exact or
-- normalized name without first moving every repository and sidecar would
-- make live storage unreachable and free the old path for destructive reuse.
-- Freeze all owner-name columns at the database boundary until a durable
-- multi-repository namespace-move workflow exists.
CREATE OR REPLACE FUNCTION prevent_user_owner_namespace_rename()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.username IS DISTINCT FROM OLD.username
       OR NEW.lower_username IS DISTINCT FROM OLD.lower_username THEN
        RAISE EXCEPTION USING
            ERRCODE = '0A000',
            MESSAGE = 'user owner namespace is immutable',
            HINT = 'Move repository storage with a durable namespace-move workflow before renaming a user.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_org_owner_namespace_rename()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.name IS DISTINCT FROM OLD.name
       OR NEW.lower_name IS DISTINCT FROM OLD.lower_name THEN
        RAISE EXCEPTION USING
            ERRCODE = '0A000',
            MESSAGE = 'organization owner namespace is immutable',
            HINT = 'Move repository storage with a durable namespace-move workflow before renaming an organization.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_prevent_owner_namespace_rename
    BEFORE UPDATE OF username, lower_username ON users
    FOR EACH ROW EXECUTE FUNCTION prevent_user_owner_namespace_rename();

CREATE TRIGGER trg_organizations_prevent_owner_namespace_rename
    BEFORE UPDATE OF name, lower_name ON organizations
    FOR EACH ROW EXECUTE FUNCTION prevent_org_owner_namespace_rename();

CREATE TRIGGER trg_users_owner_namespace
    AFTER INSERT OR UPDATE OF lower_username ON users
    FOR EACH ROW EXECUTE FUNCTION sync_user_owner_namespace();

CREATE TRIGGER trg_organizations_owner_namespace
    AFTER INSERT OR UPDATE OF lower_name ON organizations
    FOR EACH ROW EXECUTE FUNCTION sync_org_owner_namespace();
