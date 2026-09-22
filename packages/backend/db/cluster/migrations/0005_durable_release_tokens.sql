-- Provisioning aborts reuse the reservation token, but deleting a repository
-- much later has its own durable product-journal token. Persist the token that
-- actually released capacity so an ambiguous release commit can be adopted
-- only by the exact operation that performed it.
ALTER TABLE plue_storage.repository_placements
    ADD COLUMN release_token TEXT;

-- Rows released by the earlier migration could only have been released with
-- their reservation token. Preserve that exact idempotency identity before
-- requiring every tombstone to carry one. The table lock taken by ALTER TABLE
-- keeps writers out while the old immutable-tombstone trigger is disabled;
-- both trigger state and data update roll back together on any failure.
ALTER TABLE plue_storage.repository_placements
    DISABLE TRIGGER repository_placements_validate_lifecycle;
UPDATE plue_storage.repository_placements
SET release_token = reservation_token
WHERE state = 'released';
ALTER TABLE plue_storage.repository_placements
    ENABLE TRIGGER repository_placements_validate_lifecycle;

ALTER TABLE plue_storage.repository_placements
    ADD CONSTRAINT repository_placements_release_token_valid
    CHECK (release_token IS NULL OR length(release_token) BETWEEN 16 AND 256),
    ADD CONSTRAINT repository_placements_release_token_lifecycle
    CHECK ((state = 'released') = (release_token IS NOT NULL));

CREATE UNIQUE INDEX repository_placements_release_token_idx
    ON plue_storage.repository_placements(release_token)
    WHERE release_token IS NOT NULL;

CREATE OR REPLACE FUNCTION plue_storage.validate_repository_placement_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'repository placement records are durable and cannot be deleted'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'reserved' OR NEW.placement_generation <> 1
           OR NEW.release_token IS NOT NULL THEN
            RAISE EXCEPTION 'repository placement must begin reserved at generation 1'
                USING ERRCODE = '55000';
        END IF;
        NEW.created_at = now();
        NEW.updated_at = NEW.created_at;
        NEW.published_at = NULL;
        NEW.released_at = NULL;
        RETURN NEW;
    END IF;

    IF NEW.repository_id <> OLD.repository_id
       OR NEW.reservation_token <> OLD.reservation_token
       OR NEW.capacity_bytes <> OLD.capacity_bytes THEN
        RAISE EXCEPTION 'repository placement identity and capacity are immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'released' THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'released repository placement cannot be changed'
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.state = 'reserved' AND NEW.state NOT IN ('reserved', 'published', 'released') THEN
        RAISE EXCEPTION 'invalid repository placement transition'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'published' AND NEW.state NOT IN ('published', 'released') THEN
        RAISE EXCEPTION 'published repository placement cannot return to reserved'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id THEN
        IF OLD.state <> 'published' OR NEW.state <> 'published'
           OR NEW.placement_generation <> OLD.placement_generation + 1 THEN
            RAISE EXCEPTION 'repository relocation requires one higher published generation'
                USING ERRCODE = '55000';
        END IF;
    ELSIF NEW.placement_generation <> OLD.placement_generation THEN
        RAISE EXCEPTION 'placement generation changes only during relocation'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.state = 'released' THEN
        IF NEW.release_token IS NULL THEN
            RAISE EXCEPTION 'repository placement release requires an operation token'
                USING ERRCODE = '55000';
        END IF;
    ELSIF NEW.release_token IS NOT NULL THEN
        RAISE EXCEPTION 'repository placement release token is tombstone-only'
            USING ERRCODE = '55000';
    END IF;

    IF OLD.state = 'reserved' AND NEW.state = 'published' THEN
        NEW.published_at = COALESCE(NEW.published_at, now());
    ELSE
        NEW.published_at = OLD.published_at;
    END IF;
    IF NEW.state = 'released' AND OLD.state <> 'released' THEN
        NEW.released_at = COALESCE(NEW.released_at, now());
    ELSE
        NEW.released_at = OLD.released_at;
    END IF;
    NEW.created_at = OLD.created_at;
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
