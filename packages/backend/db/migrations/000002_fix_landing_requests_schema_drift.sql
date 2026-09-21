-- Fix landing_requests schema drift: add missing queue/landing columns
-- and normalize the state CHECK constraint to include queued/landing values.
-- This migration is idempotent and safe on both legacy and already-correct DBs.

-- Add missing columns (IF NOT EXISTS makes this safe when columns already exist)
ALTER TABLE landing_requests ADD COLUMN IF NOT EXISTS queued_by BIGINT;
ALTER TABLE landing_requests ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
ALTER TABLE landing_requests ADD COLUMN IF NOT EXISTS landing_started_at TIMESTAMPTZ;

-- Add FK constraint for queued_by -> users(id) ON DELETE SET NULL if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
        WHERE c.conrelid = 'landing_requests'::regclass
          AND c.contype = 'f'
          AND a.attname = 'queued_by'
    ) THEN
        ALTER TABLE landing_requests
            ADD CONSTRAINT landing_requests_queued_by_fkey
            FOREIGN KEY (queued_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Replace the state CHECK constraint to include queued and landing values.
-- First, drop any existing CHECK on the state column, then add the canonical one.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    -- Find and drop existing CHECK constraints that reference the state column
    FOR constraint_name IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.conrelid = 'landing_requests'::regclass
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%state%'
    LOOP
        EXECUTE format('ALTER TABLE landing_requests DROP CONSTRAINT %I', constraint_name);
    END LOOP;

    -- Add the canonical CHECK constraint with all 6 states
    ALTER TABLE landing_requests
        ADD CONSTRAINT landing_requests_state_check
        CHECK (state IN ('open', 'closed', 'merged', 'draft', 'queued', 'landing'));
END $$;
