import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A repository's run may be started by a schedule: a `cron` trigger of its default branch's `.smithers/factory.json`,
// fired through `@smthrs/triggers` (docs/features/ci.md#schedules). Its row's `event` says so: `schedule`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE runs DROP CONSTRAINT runs_event_check`
  yield* sql`ALTER TABLE runs ADD CONSTRAINT runs_event_check
    CHECK (event IN ('push', 'pull_request', 'manual', 'schedule'))`
})
