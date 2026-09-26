-- Source receipts for idempotent, auditable direct imports into canonical tables.
CREATE TABLE canonical_import_receipts (
 source_kind text NOT NULL,
 source_id text NOT NULL,
 target_table text NOT NULL,
 primary_key jsonb NOT NULL,
 checksum text NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_kind,source_id),
 UNIQUE(target_table,primary_key),
 CHECK (jsonb_typeof(primary_key)='object')
);
