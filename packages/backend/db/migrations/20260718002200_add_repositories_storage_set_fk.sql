-- Revision: 20260718002200.
-- db/schema.sql has long declared this relationship, but the migration chain
-- omitted it. Abort with actionable evidence instead of allowing VALIDATE to
-- fail opaquely on a legacy placement value.
DO $$
DECLARE
    v_invalid_count BIGINT;
    v_invalid_sample TEXT;
BEGIN
    SELECT COUNT(*)::bigint
    INTO v_invalid_count
    FROM repositories AS repository
    LEFT JOIN repo_storage_sets AS storage_set
      ON storage_set.id = repository.storage_set_id
    WHERE storage_set.id IS NULL;

    IF v_invalid_count > 0 THEN
        SELECT string_agg(sample.storage_set_id, ', ' ORDER BY sample.storage_set_id)
        INTO v_invalid_sample
        FROM (
            SELECT DISTINCT repository.storage_set_id
            FROM repositories AS repository
            LEFT JOIN repo_storage_sets AS storage_set
              ON storage_set.id = repository.storage_set_id
            WHERE storage_set.id IS NULL
            ORDER BY repository.storage_set_id
            LIMIT 10
        ) AS sample;

        RAISE EXCEPTION 'cannot add repositories storage-set foreign key: % invalid repositories', v_invalid_count
            USING ERRCODE = 'check_violation',
                  DETAIL = format('unknown storage_set_id sample: %s', COALESCE(v_invalid_sample, '<none>')),
                  HINT = 'create the referenced repo_storage_sets rows or repair repositories.storage_set_id, then retry the migration';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- NOT VALID keeps the initial ACCESS EXCLUSIVE lock short while immediately
-- rejecting new invalid writes. Validation scans existing rows under the
-- weaker lock designed for online constraint validation.
ALTER TABLE repositories
    ADD CONSTRAINT fk_repositories_storage_set
    FOREIGN KEY (storage_set_id)
    REFERENCES repo_storage_sets(id)
    ON DELETE RESTRICT
    NOT VALID;

ALTER TABLE repositories
    VALIDATE CONSTRAINT fk_repositories_storage_set;
