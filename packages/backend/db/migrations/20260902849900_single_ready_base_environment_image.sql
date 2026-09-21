-- A platform base registration retires the previous base of the same kind.
-- Normalize existing rows first, then enforce the invariant against concurrent
-- admin registrations at the database boundary.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY kind ORDER BY created_at DESC, id DESC) AS position
    FROM sandbox_environment_images
    WHERE repository_id IS NULL AND status = 'ready'
)
UPDATE sandbox_environment_images AS image
SET status = 'retired', updated_at = NOW()
FROM ranked
WHERE image.id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX sandbox_environment_images_one_ready_base
    ON sandbox_environment_images (kind)
    WHERE repository_id IS NULL AND status = 'ready';

CREATE OR REPLACE FUNCTION register_sandbox_environment_image(
    p_repository_id BIGINT,
    p_kind TEXT,
    p_source TEXT,
    p_source_revision TEXT,
    p_closure_hash TEXT,
    p_image TEXT,
    p_created_by BIGINT
)
RETURNS sandbox_environment_images
LANGUAGE plpgsql
AS $$
DECLARE
    registered sandbox_environment_images%ROWTYPE;
BEGIN
    IF p_repository_id IS NULL THEN
        -- Serialize platform registrations by kind. The second statement in a
        -- waiting transaction receives a fresh READ COMMITTED snapshot and
        -- retires the winner before activating itself.
        PERFORM pg_advisory_xact_lock(hashtextextended('sandbox-base:' || p_kind, 0));
        UPDATE sandbox_environment_images
        SET status = 'retired', updated_at = NOW()
        WHERE repository_id IS NULL
          AND kind = p_kind
          AND closure_hash <> p_closure_hash
          AND status = 'ready';
    END IF;

    INSERT INTO sandbox_environment_images (
        repository_id, kind, source, source_revision, closure_hash, image, created_by
    ) VALUES (
        p_repository_id, p_kind,
        COALESCE(NULLIF(p_source, ''), '.smithers/environment.nix'),
        p_source_revision, p_closure_hash, p_image, p_created_by
    )
    ON CONFLICT ((COALESCE(repository_id, 0)), kind, closure_hash) DO UPDATE SET
        image = EXCLUDED.image,
        source = EXCLUDED.source,
        source_revision = EXCLUDED.source_revision,
        status = 'ready',
        updated_at = NOW()
    RETURNING * INTO registered;

    RETURN registered;
END;
$$;
