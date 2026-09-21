ALTER TABLE oauth2_authorization_codes
    ADD COLUMN IF NOT EXISTS code_hash VARCHAR(64);

UPDATE oauth2_authorization_codes
SET code_hash = encode(digest(code, 'sha256'), 'hex')
WHERE code_hash IS NULL;

ALTER TABLE oauth2_authorization_codes
    ALTER COLUMN code_hash SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'oauth2_authorization_codes'::regclass
          AND conname = 'oauth2_authorization_codes_code_hash_key'
    ) THEN
        ALTER TABLE oauth2_authorization_codes
            ADD CONSTRAINT oauth2_authorization_codes_code_hash_key UNIQUE (code_hash);
    END IF;
END $$;

ALTER TABLE oauth2_authorization_codes
    DROP CONSTRAINT IF EXISTS oauth2_authorization_codes_pkey;

ALTER TABLE oauth2_authorization_codes
    ALTER COLUMN code DROP NOT NULL;
