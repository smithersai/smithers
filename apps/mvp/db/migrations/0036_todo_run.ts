import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A TODO's run (ruling TODO-3, docs/features/todos.md#watching-the-run): `todos.run_id` is the execution id of its
// latest attempt's `todo` run, `todo:<attempt id>`, so a TODO links to the run that works on it. The stack's writer sets
// it in the transaction that records the attempt, and keeps it after the run ends. Synced with the rest of the row to
// Members of the repository; the attempt ids themselves stay in `todo_attempts`, which is never synced.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE todos ADD COLUMN run_id text CHECK (run_id ~ '^todo:[0-9a-f-]{36}$')`
  // A TODO an earlier build started keeps its latest attempt's run.
  yield* sql`
    UPDATE todos t SET run_id = 'todo:' || a.id::text
    FROM todo_attempts a WHERE a.todo_id = t.id AND a.ordinal = t.attempt`
})
