import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Also upgrade databases that already applied 0025 with the old source and draft limits.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // JSON literals and per-line syntax expand accepted 64 KiB legacy skills by at most six bytes per input byte,
  // plus the module wrapper. Keep revisions and serialized drafts bounded while retaining all accepted instructions.
  yield* sql`
    ALTER TABLE flow_revisions DROP CONSTRAINT flow_revisions_source_check,
      ADD CONSTRAINT flow_revisions_source_check CHECK (octet_length(source) <= 524288)`
  yield* sql`
    ALTER TABLE flow_drafts DROP CONSTRAINT flow_drafts_files_check,
      ADD CONSTRAINT flow_drafts_files_check CHECK (jsonb_typeof(files) = 'array' AND octet_length(files::text) <= 4194304)`
})
