-- Hold the active node row as well as the storage-set row while admitting
-- capacity. This closes the interval in which a node could be marked offline
-- after the availability predicate but before the reservation committed.
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

        -- The storage-set UPDATE above is the first lock in this trigger. Lock
        -- its selected node in the same order used by routing/drain updates,
        -- then recheck every ownership predicate. If an offline transition won
        -- the race, this statement observes it and the transaction rolls back
        -- the capacity increment.
        PERFORM 1
        FROM plue_storage.storage_nodes AS n
        JOIN plue_storage.storage_sets AS s ON s.id = n.storage_set_id
        WHERE s.id = NEW.storage_set_id
          AND s.state = 'active'
          AND n.id = s.active_node_id
          AND n.state = 'active'
          AND n.activation_generation = s.routing_generation
        FOR SHARE OF n;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'storage node changed during capacity admission'
                USING ERRCODE = '53100';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
