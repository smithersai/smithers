ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS storage_set_id VARCHAR(50);

UPDATE repositories
SET storage_set_id = 's1'
WHERE storage_set_id IS NULL OR storage_set_id = '';

ALTER TABLE repositories
    ALTER COLUMN storage_set_id SET NOT NULL;
