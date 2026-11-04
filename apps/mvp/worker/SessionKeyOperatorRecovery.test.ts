import { ConfigProvider, Effect, Exit, Layer, Metric, Redacted, Scope } from "effect"
import { EngineStore } from "@smthrs/flows"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as Operator from "../ops/auth/session-keys.ts"
import * as Keys from "./SessionSigningKeys.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as Rotation from "./flows/SessionSigningKeys.ts"
import * as FlowHost from "./test/flowHost.ts"
import { testFile } from "./test/harness.ts"
import { holdSql } from "./test/sqlWait.ts"
import { configured, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("session_key_operator_recovery")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
const secret = Redacted.make(crypto.randomUUID().padEnd(64, "x"))
const secrets = { legacy: secret, target: secret, replacement: secret }

beforeEach(async () => {
  await query(sql => sql`TRUNCATE sessions, people CASCADE`)
  await query(sql => sql`DELETE FROM session_signing_keys`)
  await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, promoted_at) VALUES ('legacy', 'issuer', now())`)
})

test.each(["stage", "promote", "retire", "emergency-drop"])(
  "the operator retries a failed %s after correction in the same engine database", async operation => {
    if (operation === "stage") await query(sql => sql`INSERT INTO session_signing_keys (key_id, state) VALUES ('target', 'verifier')`)
    if (operation === "retire") await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, ceased_at)
      VALUES ('target', 'verifier', clock_timestamp())`)
    const database = (await runtime.runPromise(TestDatabase.Scratch)).database
    const registration = Layer.mergeAll(Rotation.registration(database, secrets), EngineStore.RunInspection.layer)
    const scope = Effect.runSync(Scope.make())
    const { context, engine } = await Effect.runPromise(Scope.provide(scope)(FlowHost.build(registration)))
    const metrics: Metric.MetricRegistry = new Map()
    const invoke = () => Effect.runPromise(Effect.exit(Operator.runOperation(operation, "target", "replacement"))
      .pipe(Effect.provide(context), Effect.provideService(Metric.MetricRegistry, metrics)))
    try {
      expect(Exit.isFailure(await invoke())).toBe(true)
      expect(await Effect.runPromise(engine.status(Operator.executionId(operation, "target")))).toBe("failed")
      if (operation === "stage") {
        expect(Exit.isFailure(await invoke())).toBe(true)
        expect(await Effect.runPromise(engine.status(`${Operator.executionId(operation, "target")}:retry:1`))).toBe("failed")
      }
      if (operation === "emergency-drop") {
        expect(Exit.isFailure(await Effect.runPromise(Effect.exit(Operator.runOperation(operation, "target", "different"))
          .pipe(Effect.provide(context))))).toBe(true)
        expect(await Effect.runPromise(engine.status(`${Operator.executionId(operation, "target")}:retry:1`))).toBeUndefined()
      }
      if (operation === "stage") {
        const fingerprint = await runtime.runPromise(Keys.fingerprint(secret))
        await query(sql => sql`UPDATE session_signing_keys SET fingerprint = ${fingerprint} WHERE key_id = 'target'`)
      } else if (operation === "promote") await runtime.runPromise(Keys.stage("target", secret))
      else if (operation === "retire") await query(sql => sql`UPDATE session_signing_keys SET ceased_at = clock_timestamp() - interval '402 days' WHERE key_id = 'target'`)
      else await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, ceased_at)
        VALUES ('target', 'verifier', clock_timestamp() - interval '1 minute')`)
      const expected = `${Operator.executionId(operation, "target")}:retry:${operation === "stage" ? 2 : 1}`
      expect(await invoke()).toEqual(Exit.succeed(expected))
      expect(await invoke()).toEqual(Exit.succeed(expected))
      const records = await Effect.runPromise(Effect.flatMap(EngineStore.RunInspection.RunInspection, reads => reads.list())
        .pipe(Effect.provide(context)))
      expect(records.runs.map(row => row.status).sort()).toEqual(operation === "stage"
        ? ["completed", "failed", "failed"] : ["completed", "failed"])
      for (const [mode, count] of [["new", 1], ["retried", operation === "stage" ? 2 : 1], ["resumed", 1]] as const) {
        expect(Effect.runSync(Metric.value(Metric.withAttributes(Operator.requests, { step: operation, mode }))
          .pipe(Effect.provideService(Metric.MetricRegistry, metrics))).count).toBe(count)
      }
      expect(await query(sql => sql`SELECT state FROM session_signing_keys WHERE key_id = 'target'`))
        .toEqual([{ state: operation === "stage" ? "verifier" : operation === "promote" ? "issuer" : operation === "retire" ? "retired" : "compromised" }])
      // Retrying never rewrites the failure receipt of the original execution.
      expect(await Effect.runPromise(engine.status(Operator.executionId(operation, "target")))).toBe("failed")
    } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
  }, 60_000,
)

test("concurrent operator invocations resume the active execution without another attempt", async () => {
  await runtime.runPromise(Keys.stage("target", secret))
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  const scope = Effect.runSync(Scope.make())
  const registration = Layer.mergeAll(Rotation.registration(database, secrets), EngineStore.RunInspection.layer)
  const { context } = await Effect.runPromise(Scope.provide(scope)(FlowHost.build(registration)))
  const held = await holdSql(runtime, sql => sql`SELECT 1 FROM session_signing_keys WHERE key_id = 'legacy' FOR UPDATE`)
  const metrics: Metric.MetricRegistry = new Map()
  const invoke = () => Effect.runPromise(Effect.exit(Operator.runOperation("promote", "target"))
    .pipe(Effect.provide(context), Effect.provideService(Metric.MetricRegistry, metrics)))
  const first = invoke()
  let second: ReturnType<typeof invoke> | undefined
  try {
    await expect.poll(async () => (await query(sql => sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE ${held.pid} = ANY(pg_blocking_pids(pid))`))[0]!.n, { timeout: 1000, interval: 10 }).toBe(1)
    second = invoke()
    await expect.poll(() => Effect.runSync(Metric.value(Metric.withAttributes(Operator.requests, { step: "promote", mode: "resumed" }))
      .pipe(Effect.provideService(Metric.MetricRegistry, metrics))).count, { timeout: 1000, interval: 10 }).toBe(1)
    await held.release()
    expect(await first).toEqual(Exit.succeed(Operator.executionId("promote", "target")))
    expect(await second).toEqual(Exit.succeed(Operator.executionId("promote", "target")))
    const records = await Effect.runPromise(Effect.flatMap(EngineStore.RunInspection.RunInspection, reads => reads.list())
      .pipe(Effect.provide(context)))
    expect(records.runs.map(row => row.status)).toEqual(["completed"])
  } finally {
    await held.release()
    await Promise.allSettled([first, ...(second === undefined ? [] : [second])])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})


test("the confirmed seal reset unblocks publication and can be used again after another lost secret", async () => {
  await runtime.runPromise(Keys.gate({ legacy: secret }, secret))
  const replacement = Redacted.make("replacement-seal".padEnd(64, "x"))
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  const scope = Effect.runSync(Scope.make())
  const { context } = await Effect.runPromise(Scope.provide(scope)(FlowHost.build(
    Layer.mergeAll(Rotation.registration(database, secrets), EngineStore.RunInspection.layer),
  )))
  try {
    // Missing or misspelled confirmation must never clear the pin.
    for (const args of [["reset-seal"], ["reset-seal", "--confirm"], ["reset-seal", "--confirm-sign-out", "extra"]]) {
      expect(Exit.isFailure(await Effect.runPromise(Effect.exit(Operator.main(args))))).toBe(true)
    }
    expect(await query(sql => sql`SELECT fingerprint IS NOT NULL AS pinned FROM session_seal_key`)).toEqual([{ pinned: true }])
    for (const seal of [replacement, secret]) {
      expect(await runtime.runPromise(Effect.result(Keys.gate({ legacy: secret }, seal)))).toMatchObject({
        _tag: "Failure", failure: { reason: "seal_fingerprint" },
      })
      if (seal === replacement) {
        const connection = new URL(await runtime.runPromise(TestDatabase.serverUrl))
        connection.searchParams.set("options", `-c search_path=${(await runtime.runPromise(TestDatabase.Scratch)).name}`)
        await Effect.runPromise(Effect.scoped(Operator.main(["reset-seal", "--confirm-sign-out"]).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ DATABASE_URL: connection.toString() })),
        )))
      } else await Effect.runPromise(Operator.runOperation("reset-seal", "seal").pipe(Effect.provide(context)))
      expect(await query(sql => sql`SELECT fingerprint FROM session_seal_key`)).toEqual([{ fingerprint: null }])
      await runtime.runPromise(Keys.gate({ legacy: secret }, seal))
    }
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test.each([false, true])("a migrated session with refresh=%s ends unreadable after confirmed seal reset and the same person signs in afresh", async refresh => {
  const config = { ...configured, SESSION_SECRET: Redacted.value(secret),
    SESSION_SECRETS: JSON.stringify({ legacy: Redacted.value(secret) }), SESSION_SEAL_SECRET: Redacted.value(secret) }
  await query(sql => sql`UPDATE session_seal_key SET fingerprint = NULL WHERE id`)
  await runtime.runPromise(Keys.gate({ legacy: secret }, secret))
  const before = await signInHarness(runtime, { config })
  const first = await before.signInAs()
  expect(first.response.headers.get("location")).toBe("/app")
  // 0111 leaves migrated rows' pair digest NULL and token generation zero.
  const [old] = await query(sql => sql<{ id: string; person: string; tag: string }>`UPDATE sessions
    SET github_pair_digest = NULL, github_token_gen = 0,
      github_refresh = CASE WHEN ${refresh} THEN github_refresh ELSE NULL END,
      github_refresh_digest = CASE WHEN ${refresh} THEN github_refresh_digest ELSE NULL END
    RETURNING id, person_id AS person, session_tag AS tag`)
  const [held] = await query(sql => sql`SELECT github_access, github_refresh FROM sessions WHERE id = ${old!.id}`)
  const replacement = Redacted.make("replacement-lost-legacy-seal".padEnd(64, "x"))
  expect(await runtime.runPromise(Effect.result(Keys.gate({ legacy: secret }, replacement)))).toMatchObject({
    _tag: "Failure", failure: { reason: "seal_fingerprint" },
  })
  const connection = new URL(await runtime.runPromise(TestDatabase.serverUrl))
  connection.searchParams.set("options", `-c search_path=${(await runtime.runPromise(TestDatabase.Scratch)).name}`)
  await Effect.runPromise(Effect.scoped(Operator.main(["reset-seal", "--confirm-sign-out"]).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ DATABASE_URL: connection.toString() })),
  )))
  expect(await query(sql => sql`SELECT fingerprint FROM session_seal_key`)).toEqual([{ fingerprint: null }])
  await runtime.runPromise(Keys.gate({ legacy: secret }, replacement))
  expect(await query(sql => sql`SELECT id FROM sessions WHERE revoked_at IS NULL`)).toEqual([{ id: old!.id }])
  const after = await signInHarness(runtime, { github: before.github,
    config: { ...config, SESSION_SEAL_SECRET: Redacted.value(replacement) } })
  const started = await after.start()
  const response = await after.callback(after.github.approve(started.location), {
    ...first.cookies, smithers_sign_in: started.cookies.smithers_sign_in!.value,
  })
  expect(response.headers.get("location")).toBe("/app")
  const sessionCookie = setCookies(response).smithers_session
  expect(sessionCookie !== undefined && sessionCookie.value !== first.cookies.smithers_session).toBe(true)
  const [fresh] = await query(sql => sql<{ id: string; person: string; access: Parameters<SessionKeys.SessionKeys["open"]>[0] }>`
    SELECT id, person_id AS person, github_access AS access FROM sessions WHERE revoked_at IS NULL`)
  expect(fresh!.id === old!.id).toBe(false)
  expect(fresh!.person).toBe(old!.person)
  expect(await query(sql => sql`SELECT revoked_reason, github_access, github_refresh, github_refresh_digest
    FROM sessions WHERE id = ${old!.id}`)).toEqual([{
      revoked_reason: "unreadable", github_access: null, github_refresh: null, github_refresh_digest: null,
    }])
  expect(await query(sql => sql`SELECT reason FROM session_end_receipts WHERE session_tag = ${old!.tag}`))
    .toEqual([{ reason: "unreadable" }])
  expect(await query(sql => sql`SELECT sealed_access AS github_access, sealed_refresh AS github_refresh
    FROM github_token_cleanups WHERE session_id = ${old!.id} AND finished_at IS NULL`)).toEqual([held])
  expect(await after.session(first.cookies)).toMatchObject({ signedIn: false })
  expect(await after.session({ smithers_session: sessionCookie!.value })).toMatchObject({ signedIn: true, personId: old!.person })
  const keys = await runtime.runPromise(SessionKeys.make(secret, { sealSecret: replacement }))
  expect((await runtime.runPromise(Effect.result(keys.open(fresh!.access, { id: fresh!.id, name: "github_access", version: 1 }))))._tag)
    .toBe("Success")
  expect(after.line("auth.session_end").map(line => line.annotations)).toContainEqual(expect.objectContaining({ reason: "unreadable", kind: "home" }))
  expect(after.count({ route: "callback", outcome: "signed_in" })).toBe(1)
  expect(after.count({ route: "callback", outcome: "failed" })).toBe(0)
}, 60_000)
