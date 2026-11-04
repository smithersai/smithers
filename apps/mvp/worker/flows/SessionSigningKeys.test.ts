import { Effect, Exit, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { executionId } from "../../ops/auth/session-keys.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Keys from "./SessionSigningKeys.ts"

const runtime = testFile("session_signing_key_flows")
test("the operator stages and promotes through durable steps, recording cessation after promotion", async () => {
  const scratch = await runtime.runPromise(TestDatabase.Scratch)
  const registration = Keys.registration(scratch.database, { legacy: Redacted.make("legacy-flow-secret".padEnd(64, "1")), next: Redacted.make("next-flow-secret".padEnd(64, "2")) })
  const staged = await runFlow(Keys.StageSigningKey, { keyId: "next" }, registration, { executionId: executionId("stage", "next") })
  expect(Exit.isSuccess(staged.exit)).toBe(true)
  const rotated = await runFlow(Keys.RotateSigningKey, { keyId: "next" }, registration, { executionId: executionId("promote", "next") })
  expect(Exit.isSuccess(rotated.exit)).toBe(true)
  const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql<{ id: string; state: string; ceased: boolean }>`
    SELECT key_id AS id, state, ceased_at IS NOT NULL AS ceased FROM session_signing_keys ORDER BY key_id`))
  expect(rows).toEqual([{ id: "legacy", state: "verifier", ceased: true }, { id: "next", state: "issuer", ceased: false }])
})
