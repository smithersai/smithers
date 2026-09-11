-- Mirror of internal/MemoryIndexes.ts, recorded as memory migration 0002.
-- The expiry sweep filters on updated_at_ms + ttl_ms, which the old
-- (updated_at_ms, ttl_ms) index could never serve; every default note read
-- looks up supersession edges by target_id, which the primary key
-- (superseder_id, target_id) cannot answer without a scan.
DROP INDEX IF EXISTS memory_facts_expiry_idx;

CREATE INDEX IF NOT EXISTS memory_facts_expires_at_idx
  ON memory_facts (updated_at_ms + ttl_ms) WHERE ttl_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_note_supersedes_target_idx
  ON memory_note_supersedes (target_id, superseder_id);
