ALTER TABLE landing_requests ADD COLUMN request_id UUID;
ALTER TABLE landing_requests ADD COLUMN create_request_hash BYTEA;
ALTER TABLE landing_requests ADD CONSTRAINT landing_requests_create_identity CHECK (
    (request_id IS NULL AND create_request_hash IS NULL) OR
    (request_id IS NOT NULL AND create_request_hash IS NOT NULL AND octet_length(create_request_hash) = 32)
);
ALTER TABLE landing_requests ADD UNIQUE (repository_id, author_id, request_id);
CREATE FUNCTION protect_landing_create_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.request_id IS DISTINCT FROM OLD.request_id OR
       NEW.create_request_hash IS DISTINCT FROM OLD.create_request_hash OR
       (OLD.request_id IS NOT NULL AND (NEW.author_id <> OLD.author_id OR NEW.repository_id <> OLD.repository_id)) THEN
        RAISE EXCEPTION 'landing create identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER landing_create_identity_immutable BEFORE UPDATE ON landing_requests
FOR EACH ROW EXECUTE FUNCTION protect_landing_create_identity();

