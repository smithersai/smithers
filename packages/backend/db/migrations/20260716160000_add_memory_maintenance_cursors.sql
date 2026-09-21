-- Persist fair rotation across bounded Hindsight bank-maintenance passes.
CREATE TABLE memory_maintenance_cursors (
    maintenance_kind VARCHAR(64) PRIMARY KEY,
    last_bank_id TEXT NOT NULL CHECK (BTRIM(last_bank_id) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
