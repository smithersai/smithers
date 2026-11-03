import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// What an answer shows besides its text (docs/features/agent.md#parts): `parts`, the steps the browser's agent took,
// each `{ id, kind, flow, status }`, in order. Only what a person sees: never a cell's code or a flow's raw result. A
// question has none. And one more way an answer fails, `unfinished`: the agent ran out of frames before it answered.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE messages ADD COLUMN parts jsonb NOT NULL DEFAULT '[]'::jsonb`
  yield* sql`
    ALTER TABLE messages ADD CONSTRAINT messages_parts_check
      CHECK (jsonb_typeof(parts) = 'array' AND (role = 'assistant' OR parts = '[]'::jsonb))`
  yield* sql`ALTER TABLE messages DROP CONSTRAINT messages_failure_check`
  yield* sql`
    ALTER TABLE messages ADD CONSTRAINT messages_failure_check
      CHECK (failure IN ('rate_limited', 'model_error', 'empty', 'abandoned', 'unfinished'))`
})
