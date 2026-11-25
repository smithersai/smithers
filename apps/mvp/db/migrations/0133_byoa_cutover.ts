import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Decision 0173 retires the browser agent. Keep its partial transcript and completed work readable.
  yield* sql`
    UPDATE messages
    SET status = 'failed', failure = 'abandoned', updated_at = now()
    WHERE role = 'assistant' AND status = 'streaming'`
  yield* sql`
    WITH settled AS (
      UPDATE runs
      SET status = 'failed', waiting = NULL, updated_at = now()
      WHERE flow = 'chat/Answer' AND status IN ('working', 'waiting', 'needs_you')
      RETURNING id
    )
    UPDATE notifications
    SET state = 'failed'
    FROM settled
    WHERE run_id = settled.id AND state IN ('working', 'waiting', 'needs_you')`
  // Carry forward the former coding fallback where the admin has no explicit coding setting.
  yield* sql`
    INSERT INTO model_roles (role, model, updated_by, updated_at)
    SELECT 'coding', model, updated_by, updated_at FROM model_roles WHERE role = 'agent'
    ON CONFLICT (role) DO NOTHING`
  yield* sql`
    CREATE TABLE IF NOT EXISTS attach_grants (
      origin text NOT NULL,
      reference text NOT NULL,
      person_id text NOT NULL,
      claim_id text,
      code_hash text,
      token_hash text,
      grant_id text,
      expires_at bigint NOT NULL,
      state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
      PRIMARY KEY (origin, reference),
      UNIQUE (origin, claim_id),
      UNIQUE (origin, code_hash),
      UNIQUE (origin, token_hash),
      UNIQUE (origin, grant_id)
    )`
  yield* sql`CREATE INDEX IF NOT EXISTS attach_grants_expiry ON attach_grants (origin, expires_at)`
  yield* sql`
    CREATE INDEX IF NOT EXISTS attach_grants_pending_person
    ON attach_grants (origin, person_id, expires_at) WHERE token_hash IS NULL`
})
