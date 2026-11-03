import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The model endpoint's tables (docs/features/model-endpoint.md#postgres). Nothing here is synced to browsers.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // The model an admin set for a role. A role without a row uses the deployment's default model.
  yield* sql`
    CREATE TABLE model_roles (
      role text PRIMARY KEY CHECK (role IN ('agent', 'renderer', 'judge')),
      model jsonb NOT NULL,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  // Every change `admin/SetModel` made, once per step: a replayed step finds its row by its invocation key.
  yield* sql`
    CREATE TABLE model_role_changes (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      invocation_key text NOT NULL UNIQUE,
      role text NOT NULL,
      model jsonb NOT NULL,
      changed_by text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now()
    )`
  // What each served model call spent, one row per call: the budget sums today's rows. The key is the server's own id
  // for the call; `request_id` is the caller's correlation id, which a caller may send on any number of calls.
  yield* sql`
    CREATE TABLE model_usage (
      invocation_id text PRIMARY KEY,
      request_id text NOT NULL,
      role text NOT NULL,
      model_id text NOT NULL,
      input_tokens integer NOT NULL CHECK (input_tokens >= 0),
      output_tokens integer NOT NULL CHECK (output_tokens >= 0),
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`CREATE INDEX model_usage_created_at ON model_usage (created_at)`
})
