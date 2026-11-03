import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Stacked TODOs (docs/features/todos.md#stacked-pull-requests): a TODO in review frees its lane, and the next one starts
// on its branch.
// - `todos.base_ref`: the branch a TODO's branch was made from and its pull request is based on: the default branch,
//   or the branch of the TODO before it while that one is in review. Never synced.
// - `todo_attempts.published_report`: the attempts a run's first `published` report started, kept with the report, so
//   a retried report starts the same ones and never another.
// - `todos.failure` takes `base_closed`: the TODO below it closed unmerged, so its branch holds a change that won't merge.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE todos ADD COLUMN base_ref text CHECK (char_length(base_ref) <= 255)`
  yield* sql`ALTER TABLE todo_attempts ADD COLUMN published_report jsonb
    CHECK (published_report IS NULL OR
      (jsonb_typeof(published_report) = 'object' AND jsonb_typeof(published_report->'starts') = 'array'))`
  yield* sql`ALTER TABLE todos DROP CONSTRAINT todos_failure_check`
  yield* sql`ALTER TABLE todos ADD CONSTRAINT todos_failure_check CHECK (failure IN ('plan', 'implement', 'empty_change',
    'publish_refused', 'pr_refused', 'app_not_installed', 'budget', 'base_closed'))`
})
