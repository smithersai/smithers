-- Product repositories intentionally contain no deployment placement. A row
-- is reserved here before storage is touched and becomes routable only after
-- the matching public repository row has been published.
CREATE TABLE plue_storage.repository_placements (
    repository_id       BIGINT PRIMARY KEY CHECK (repository_id > 0),
    reservation_token   TEXT NOT NULL UNIQUE
                        CHECK (length(reservation_token) BETWEEN 16 AND 256),
    storage_set_id      TEXT NOT NULL
                        REFERENCES plue_storage.storage_sets(id) ON DELETE RESTRICT,
    state               TEXT NOT NULL DEFAULT 'reserved'
                        CHECK (state IN ('reserved', 'published', 'released')),
    capacity_bytes      BIGINT NOT NULL CHECK (capacity_bytes > 0),
    placement_generation BIGINT NOT NULL DEFAULT 1
                        CHECK (placement_generation >= 1),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at        TIMESTAMPTZ,
    released_at         TIMESTAMPTZ,
    CHECK ((state = 'reserved' AND published_at IS NULL AND released_at IS NULL)
        OR (state = 'published' AND published_at IS NOT NULL AND released_at IS NULL)
        OR (state = 'released' AND released_at IS NOT NULL))
);

CREATE INDEX repository_placements_storage_set_state_idx
    ON plue_storage.repository_placements(storage_set_id, state, repository_id);

CREATE OR REPLACE FUNCTION plue_storage.validate_repository_placement_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'repository placement records are durable and cannot be deleted'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'reserved' OR NEW.placement_generation <> 1 THEN
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
    IF OLD.state = 'released' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'released repository placement cannot be changed'
            USING ERRCODE = '55000';
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

CREATE TRIGGER repository_placements_validate_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON plue_storage.repository_placements
    FOR EACH ROW EXECUTE FUNCTION plue_storage.validate_repository_placement_lifecycle();

-- Keep capacity accounting authoritative in PostgreSQL. The trigger locks the
-- selected set and rechecks admission so direct or concurrent callers cannot
-- overbook a set after observing stale free capacity.
CREATE OR REPLACE FUNCTION plue_storage.account_repository_placement_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    admitted BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.state <> 'released'
       AND (NEW.state = 'released' OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id) THEN
        UPDATE plue_storage.storage_sets
        SET reserved_bytes = reserved_bytes - OLD.capacity_bytes,
            updated_at = now()
        WHERE id = OLD.storage_set_id AND reserved_bytes >= OLD.capacity_bytes;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'repository placement capacity accounting underflow'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    IF (TG_OP = 'INSERT' AND NEW.state <> 'released')
       OR (TG_OP = 'UPDATE' AND NEW.state <> 'released'
           AND NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id) THEN
        UPDATE plue_storage.storage_sets AS s
        SET reserved_bytes = s.reserved_bytes + NEW.capacity_bytes,
            updated_at = now()
        WHERE s.id = NEW.storage_set_id
          AND s.state = 'active'
          AND s.capacity_bytes - s.reserved_bytes >= NEW.capacity_bytes
          AND EXISTS (
              SELECT 1
              FROM plue_storage.storage_nodes AS n
              WHERE n.storage_set_id = s.id
                AND n.id = s.active_node_id
                AND n.state = 'active'
                AND n.activation_generation = s.routing_generation
          )
        RETURNING TRUE INTO admitted;
        IF NOT COALESCE(admitted, FALSE) THEN
            RAISE EXCEPTION 'storage set unavailable or capacity exhausted'
                USING ERRCODE = '53100';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER repository_placements_account_capacity
    AFTER INSERT OR UPDATE ON plue_storage.repository_placements
    FOR EACH ROW EXECUTE FUNCTION plue_storage.account_repository_placement_capacity();
