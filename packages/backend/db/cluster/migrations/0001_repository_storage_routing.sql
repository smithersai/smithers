-- Plue-private repository storage membership and routing. Product repository
-- rows keep only their stable storage_set_id; node addresses, capacity, drain
-- state, and fencing generations are deployment infrastructure.
CREATE TABLE IF NOT EXISTS plue_storage.storage_sets (
    id                 TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
    state              TEXT NOT NULL DEFAULT 'active'
                       CHECK (state IN ('active', 'draining', 'disabled')),
    routing_generation BIGINT NOT NULL DEFAULT 1 CHECK (routing_generation >= 1),
    active_node_id     TEXT,
    capacity_bytes     BIGINT NOT NULL CHECK (capacity_bytes > 0),
    reserved_bytes     BIGINT NOT NULL DEFAULT 0
                       CHECK (reserved_bytes >= 0 AND reserved_bytes <= capacity_bytes),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, active_node_id)
);

CREATE TABLE IF NOT EXISTS plue_storage.storage_nodes (
    id             TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
    storage_set_id TEXT NOT NULL REFERENCES plue_storage.storage_sets(id) ON DELETE CASCADE,
    base_url       TEXT NOT NULL,
    zone           TEXT NOT NULL DEFAULT '',
    activation_generation BIGINT NOT NULL CHECK (activation_generation >= 1),
    state          TEXT NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active', 'draining', 'offline')),
    last_seen_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (storage_set_id, id),
    UNIQUE (base_url)
);

ALTER TABLE plue_storage.storage_sets
    ADD CONSTRAINT storage_sets_active_node_fk
    FOREIGN KEY (id, active_node_id)
    REFERENCES plue_storage.storage_nodes(storage_set_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS storage_nodes_state_idx
    ON plue_storage.storage_nodes(storage_set_id, state);

CREATE OR REPLACE FUNCTION plue_storage.fence_storage_set_route_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.routing_generation < OLD.routing_generation THEN
        RAISE EXCEPTION 'storage-set routing generation cannot decrease';
    END IF;
    IF NEW.active_node_id IS DISTINCT FROM OLD.active_node_id
       AND NEW.routing_generation <= OLD.routing_generation THEN
        RAISE EXCEPTION 'changing the active storage node requires a higher routing generation';
    END IF;
    IF OLD.state = 'disabled' AND NEW.state IN ('active', 'draining')
       AND NEW.routing_generation <= OLD.routing_generation THEN
        RAISE EXCEPTION 're-enabling a storage set requires a higher routing generation';
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_sets_fence_route_update
    BEFORE UPDATE ON plue_storage.storage_sets
    FOR EACH ROW EXECUTE FUNCTION plue_storage.fence_storage_set_route_update();
