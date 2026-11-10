import { ExecutionObject } from "@smthrs/platform-cloudflare"
import { TestSchemas } from "@smthrs/database"
import { Effect, Exit, Layer, Metric, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, onTestFinished, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Flows from "#vibelang/emitted/worker/Flows"
import * as Keys from "../SessionKeys.ts"
import { testFile } from "../test/harness.ts"
import { SECRET, signInHarness } from "../test/signIn.ts"
import * as Cleanup from "./RevokeReplacedGitHubToken.ts"
import { sourceText } from "../../../../packages/repo-targets/test-utils/source-readers.mjs"

const runtime = testFile("session_maintenance")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
beforeEach(() => query(sql => sql`TRUNCATE people, sessions, sign_in_attempts, github_token_cleanups, session_end_receipts CASCADE`))

test("authentication seeds maintenance and existing idle alarms own subsequent rounds", () => {
  const program = sourceText(new URL("../ChatApiProgram.ts", import.meta.url))
  expect(program).toContain("signIn.admit(")
  // Re-admitting the root from its own alarm would overwrite the durable sleep with an immediate wake.
  const host = sourceText(new URL("../Executions.ts", import.meta.url))
  expect(host).not.toMatch(/ReplacedTokens\.(?:sampler|ensure)|sampleCleanup/)
  expect(ExecutionHost.remoteWithSignIn).toBeDefined()
})

test("idle alarms recover a refused cleanup admission and erase retained rows without another request", async () => {
  const h = await signInHarness(runtime)
  const first = await h.signInAs()
  const auth = await h.start()
  await h.callback(h.github.approve(auth.location), { ...first.cookies, smithers_sign_in: auth.cookies.smithers_sign_in!.value })
  await query(sql => sql`UPDATE github_token_cleanups SET created_at = now() - interval '6 minutes'`)
  const services = { keys: await runtime.runPromise(Keys.make(Redacted.make(SECRET))), github: h.github.service }
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  const url = (await runtime.runPromise(TestDatabase.serverUrl)).toString()
  const schema = TestSchemas.schemaName("flows")
  onTestFinished(() => query(sql => sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`).then(() => undefined))
  type Host = {
    readonly start: (intent: ExecutionObject.Intent) => Effect.Effect<void, ExecutionObject.IntentConflict>
    readonly alarm: () => Effect.Effect<ExecutionObject.Outcome>
    readonly wake: () => Effect.Effect<boolean>
  }
  const objects = new Map<string, { host: Host; alarm: number | null }>()
  let refuseCleanup = true
  const starter = Flows.FlowStarter.of({
    start: (flow, request) => flow === Cleanup.RevokeReplacedGitHubToken && refuseCleanup
      ? Effect.fail(new Flows.StartUnavailable({ errorCode: "test_admission" }))
      : ExecutionHost.intent(flow, { executionId: request.executionId, payload: request.payload as never }).pipe(
        Effect.flatMap(intent => objectFor(intent.executionId).host.start(intent)), Effect.orDie,
      ),
  })
  const objectFor = (id: string) => {
    const old = objects.get(id)
    if (old) return old
    const values = new Map<string, unknown>()
    const object = { host: undefined as unknown as Host, alarm: null as number | null }
    object.host = ExecutionHost.make({
      get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
      put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
      delete: key => Effect.sync(() => values.delete(key)),
      setAlarm: at => Effect.sync(() => void (object.alarm = at)),
      deleteAlarm: () => Effect.sync(() => void (object.alarm = null)),
    }, {
      hostId: `object-${id}`, database: ExecutionHost.database(url, schema),
      flows: {
        flows: [Cleanup.SweepReplacedGitHubTokens, Cleanup.RevokeReplacedGitHubToken, Cleanup.MaintainSessions],
        registration: Cleanup.registration(database, services).pipe(Layer.provide(Layer.succeed(Flows.FlowStarter, starter))),
      },
      router: {
        start: intent => objectFor(intent.executionId).host.start(intent),
        wake: id => Effect.asVoid(objectFor(id).host.wake()),
      },
    })
    objects.set(id, object)
    return object
  }
  expect(Cleanup.MaintainSessions).toBeDefined()
  await Effect.runPromise(Cleanup.ensure.pipe(Effect.provideService(Flows.FlowStarter, starter)))
  const root = [...objects.values()][0]!
  expect((await Effect.runPromise(root.host.alarm()))._tag).toBe("Parked")
  expect(root.alarm).toBeGreaterThan(Date.now())
  expect(root.alarm).toBeLessThanOrEqual(Date.now() + 300_000)
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE finished_at IS NULL`)).toHaveLength(1)
  // The deployment becomes idle here. Only the recorded alarm and its handoff drive the rest.
  refuseCleanup = false
  const [{ id, session_tag: tag }] = await query(sql => sql<{ id: string; session_tag: string }>`SELECT id, session_tag FROM sessions`)
  await query(sql => sql`UPDATE sessions SET expires_at = now() - interval '31 days' WHERE id = ${id}`)
  await query(sql => sql`INSERT INTO session_end_receipts (session_tag, ended_at, reason) VALUES
    ('00000000000000000000000000000000', now() - interval '401 days', 'expired')`)
  const due = root.alarm!
  await Effect.runPromise(Effect.gen(function* () {
    yield* TestClock.setTime(due + 1)
    // The old round hands off to its next object; new cleanup objects then run from their alarms.
    for (let round = 0; round < 4; round++) {
      for (const object of [...objects.values()]) {
        if (object.alarm !== null && object.alarm <= due + 1) yield* object.host.alarm()
      }
    }
  }).pipe(Effect.provide(TestClock.layer())))
  expect(await query(sql => sql`SELECT id FROM sessions WHERE id = ${id}`)).toHaveLength(0)
  expect(await query(sql => sql`SELECT session_tag FROM session_end_receipts WHERE session_tag = ${tag}`)).toHaveLength(1)
  expect(await query(sql => sql`SELECT session_tag FROM session_end_receipts WHERE session_tag = '00000000000000000000000000000000'`)).toHaveLength(0)
  expect(h.github.accepts(h.github.issued[0]!.accessToken)).toBe(false)
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE finished_at IS NOT NULL`)).toHaveLength(1)
  expect([...objects.values()].some(object => object.alarm !== null && object.alarm > due + 1 && object.alarm <= due + 300_001)).toBe(true)
})

test("a refused maintenance seed remains retryable and every admission uses the same durable intent", async () => {
  let unavailable = true
  const intents: Array<{ executionId: string; payload: unknown }> = []
  const starter = Flows.FlowStarter.of({
    start: (_flow, request) => Effect.suspend(() => {
      intents.push(request)
      return unavailable ? Effect.fail(new Flows.StartUnavailable({ errorCode: "test_admission" })) : Effect.void
    }),
  })
  expect(Cleanup.ensure).toBeDefined()
  const registry: Metric.MetricRegistry = new Map()
  const ensure = () => Effect.runPromiseExit(Cleanup.ensure.pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provideService(Metric.MetricRegistry, registry)))
  expect(Exit.isFailure(await ensure())).toBe(true)
  unavailable = false
  expect(Exit.isSuccess(await ensure())).toBe(true)
  expect(Exit.isSuccess(await ensure())).toBe(true)
  expect(intents).toHaveLength(3)
  expect(intents[1]).toEqual(intents[0])
  expect(intents[2]).toEqual(intents[0])
  const counts = Effect.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  expect(counts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "smithers_auth_session_maintenance", attributes: { outcome: "unavailable" }, state: expect.objectContaining({ count: 1 }) }),
    expect.objectContaining({ id: "smithers_auth_session_maintenance", attributes: { outcome: "admitted" }, state: expect.objectContaining({ count: 2 }) }),
  ]))
})
