// Validates the `stack_ops` checks migration 0099 added NOT VALID (docs/features/todos.md#leaves). VALIDATE CONSTRAINT
// scans existing rows under SHARE UPDATE EXCLUSIVE, which lets stack ops read and write throughout, so it runs after the
// deploy, each constraint in its own transaction, waiting at most 5 seconds for the lock. Prints what it found and did as
// one JSON line; a failure, one scrubbed line on stderr and exit 1. Validating a valid constraint changes nothing, so it
// is safe to run again.
//
//   cd apps/mvp && ~/vault-ws-deployer/bin/mvp-prod-env node ops/stack-ops/validate.ts --project <id> --by <name> [--stage prod]
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { asMain, opsCommand } from "../feed-barrier/confirm.ts"

export const CONSTRAINTS = ["stack_ops_op_check", "stack_ops_outcome_check"] as const

/** Validates each of `CONSTRAINTS` that isn't valid yet. `lockTimeout` bounds the wait for each one's lock. */
export const validate = (lockTimeout = "5s") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const validated: Array<string> = []
    for (const name of CONSTRAINTS) {
      const [row] = yield* sql<{ readonly valid: boolean }>`
        SELECT convalidated AS valid FROM pg_constraint WHERE conname = ${name} AND conrelid = 'stack_ops'::regclass`
      if (row === undefined) return yield* Effect.fail(new Error(`stack_ops has no constraint ${name}`))
      if (row.valid) continue
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`SELECT set_config('lock_timeout', ${lockTimeout}, true)`
        yield* sql`ALTER TABLE stack_ops VALIDATE CONSTRAINT ${sql(name)}`
      }))
      validated.push(name)
    }
    return { outcome: "valid", validated }
  })

const FAILURE = "stack_ops checks not validated"

export const run = opsCommand(FAILURE, async () => validate())

asMain(import.meta.url, FAILURE, run)
