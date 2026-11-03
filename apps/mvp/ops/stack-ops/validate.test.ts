// The post-deploy validation of migration 0099's checks (ops/stack-ops/validate.ts), over a real Postgres.
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { testFile } from "../../worker/test/harness.ts"
import { CONSTRAINTS, validate } from "./validate.ts"

const runtime = testFile("stack_ops_validate")
const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)
const raw = (statement: string) => on(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.orDie(sql.unsafe(statement))))

const states = async () =>
  (await raw(`SELECT conname AS name, convalidated AS valid FROM pg_constraint
    WHERE conname IN ('stack_ops_op_check', 'stack_ops_outcome_check') AND conrelid = 'stack_ops'::regclass ORDER BY conname`)) as ReadonlyArray<unknown>

// The tests run in order on one schema, migrated as a deploy leaves production: the checks not yet valid.
test("a table locked by someone else fails within the bound, leaving the checks as they were", async () => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  let open = () => {}
  const released = new Promise<void>((resolve) => { open = resolve })
  let ready = () => {}
  const locked = new Promise<void>((resolve) => { ready = resolve })
  const holder = Effect.runPromise(Effect.scoped(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
      yield* sql`LOCK TABLE stack_ops IN ACCESS EXCLUSIVE MODE`
      ready()
      yield* Effect.promise(() => released)
    }))).pipe(Effect.provide(scratch.database)),
  ))
  await locked
  const exit = await runtime.runPromise(Effect.exit(validate("200ms")))
  open()
  await holder
  expect(Exit.isFailure(exit)).toBe(true)
  expect(await states()).toEqual([{ name: "stack_ops_op_check", valid: false }, { name: "stack_ops_outcome_check", valid: false }])
})

test("validates each check once and a second run finds nothing to do", async () => {
  expect(await on(validate())).toEqual({ outcome: "valid", validated: [...CONSTRAINTS] })
  expect(await states()).toEqual([{ name: "stack_ops_op_check", valid: true }, { name: "stack_ops_outcome_check", valid: true }])
  expect(await on(validate())).toEqual({ outcome: "valid", validated: [] })
})

test("the real CLI loads under plain node and, with a database it can't reach, prints one scrubbed line and exits 1", async () => {
  const script = fileURLToPath(new URL("./validate.ts", import.meta.url))
  const ran = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    execFile(process.execPath, [script, "--by", "bc", "--release", "74f62526544f"], {
      env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://someone:cli-sekret@127.0.0.1:1/nothing" },
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      timeout: 60_000,
    }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? null, stdout, stderr })))
  expect(ran.code).toBe(1)
  expect(ran.stdout).toBe("")
  expect(ran.stderr.trim().split("\n")).toHaveLength(1)
  expect(ran.stderr).toMatch(/^stack_ops checks not validated/)
  expect(ran.stderr).not.toContain("cli-sekret")
}, 90_000)
