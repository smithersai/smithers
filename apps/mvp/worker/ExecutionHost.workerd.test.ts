// worker/ExecutionHost.ts in local workerd: a real Durable Object (worker/test/workerd/worker.ts, run by Miniflare)
// runs `probe/Pause` from real alarms over the compose Postgres (`pnpm db:up`) through Miniflare's local Hyperdrive.
// Its `:after` step resets the object with `ctx.abort()`; the alarm Cloudflare retries must run in a new incarnation,
// take the run over and finish it. Node can't show this: only workerd resets an object mid-step and retries its alarm.
import * as Pg from "@effect/sql-pg"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as Pause from "./flows/Pause.ts"

const entry = fileURLToPath(new URL("./test/workerd/worker.ts", import.meta.url))

/** The harness Worker as one ES module, with workerd's own modules left to it. */
const bundle = async () => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent",
    // Workspace packages export their source, which can hold `.vibe` modules.
    plugins: [vibelang()],
  })
  return result.outputFiles[0]!.text
}

interface Mark {
  readonly incarnation: string
  readonly label: string
  readonly at: number
}

interface Report {
  readonly marks: ReadonlyArray<Mark>
  readonly outcomes: ReadonlyArray<{ readonly _tag: string; readonly forgetAtMs?: number }>
  readonly alarm: number | null
}

/** Runs `effect` with a client on the compose Postgres itself, outside any engine schema. */
const admin = <A, E>(url: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })), Effect.scoped),
  )

/** The compose Postgres's URL, once it answers; fails with `TestDatabase.Unusable`, naming `pnpm db:up`, when not. */
const server = Effect.gen(function* () {
  const url = (yield* TestDatabase.serverUrl).toString()
  yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT 1`).pipe(
    Effect.provide(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })),
    Effect.scoped,
    Effect.mapError(TestDatabase.explain("Postgres", "localhost:54321")),
  )
  return url
})

describe("a remote execution in local workerd", () => {
  const schema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
  let url: string
  let worker: Miniflare

  beforeAll(async () => {
    url = await Effect.runPromise(server)
    worker = new Miniflare({
      workers: [{
        config: {
          name: "executions",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: await bundle() } } },
          env: {
            HYPERDRIVE: { type: "hyperdrive", id: "executions", dev: { connectionString: url } },
            SCHEMA: { type: "text", value: schema },
            EXECUTION: { type: "durable-object", worker: "executions", exportName: "Execution" },
          },
          exports: { Execution: { type: "durable-object", storage: "sqlite" } },
        },
      }],
    })
  }, 120_000)

  afterAll(async () => {
    await worker?.dispose()
    if (url !== undefined) {
      await admin(url, Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`))
    }
  })

  test("runs probe/Pause from real alarms, and a new incarnation finishes it after ctx.abort() mid-step", async () => {
    const executionId = crypto.randomUUID()
    const intent = await Effect.runPromise(
      // Longer than the drive's hold for a wake due soon (`EngineStore.defaultHoldMs`, 5 s), so the first alarm parks on
      // the timer.
      ExecutionHost.intent(Pause.Pause, { executionId, payload: { label: "w", pauseMs: 8_000 } }),
    )
    const started = await worker.dispatchFetch(`http://executions/${executionId}/start`, {
      method: "POST",
      body: JSON.stringify(intent),
    })
    expect(await started.text()).toBe("started")

    const read = async () =>
      (await (await worker.dispatchFetch(`http://executions/${executionId}/report`)).json()) as Report
    const report = await vi.waitFor(async () => {
      const value = await read()
      if (!value.outcomes.some((outcome) => outcome._tag === "Settled")) throw new Error("not settled yet")
      return value
    }, { timeout: 60_000, interval: 100 })

    // The first alarm parked on the durable timer; the alarm that ran `:after` died with the object, so it reported
    // nothing; the retried alarm settled the run and armed the alarm that forgets it after the retention window.
    expect(report.outcomes.map((outcome) => outcome._tag)).toEqual(["Parked", "Settled"])
    expect(report.alarm).toBe(report.outcomes[1]!.forgetAtMs)
    expect(report.marks.map((mark) => mark.label)).toEqual(["w:before", "w:after", "w:after"])
    const [before, aborted, after] = report.marks
    expect(aborted!.incarnation).toBe(before!.incarnation)
    expect(after!.incarnation).not.toBe(aborted!.incarnation)
    // The second step waited for the timer, and the new incarnation took over one alarm backoff later, not a lease.
    expect(aborted!.at - before!.at).toBeGreaterThanOrEqual(8_000)
    expect(after!.at - aborted!.at).toBeLessThan(20_000)

    const [run] = await admin(
      url,
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly status: string }>`SELECT status FROM ${sql(schema)}.flows_runs WHERE run_id = ${executionId}`,
      ),
    )
    expect(run).toEqual({ status: "completed" })
  }, 120_000)
})
