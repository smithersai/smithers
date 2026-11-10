import vibelang from "vibelang-unplugin/esbuild"
/**
 * `ObjectDatabase` in local workerd, run when a host opts in with
 * `FLOWS_WORKERD_SMOKE=1`, as the other workerd smoke is. It needs no
 * database server: a real SQLite-backed Durable Object runs `AnswerFlow` from
 * its real alarms with the engine's journal in its own storage, the
 * `@effect/sql-sqlite-do` client underneath. `ctx.abort()` inside a step
 * resets the object; the alarm Cloudflare retries runs in a new incarnation,
 * which must read the run back from the object's SQLite and finish it. Only
 * workerd refuses `BEGIN` and runs `storage.transaction()`, so only workerd
 * shows the engine's transactions and read transactions work there.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll } from "vitest"
import { ExecutionObject } from "../src/index.ts"
import { Answer } from "./fixtures/AnswerFlow.ts"

const entry = fileURLToPath(new URL("./workerd/object-database-worker.ts", import.meta.url))

const bundle = async () => {
  const result = await build({
    plugins: [vibelang()],
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent"
  })
  return result.outputFiles[0]!.text
}

const eventually = async <A>(read: () => Promise<A>, done: (value: A) => boolean, ms = 60_000): Promise<A> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms; last value ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

interface Report {
  readonly steps: ReadonlyArray<{ readonly incarnation: string; readonly label: string; readonly at: number }>
  readonly outcomes: ReadonlyArray<ExecutionObject.Outcome>
  readonly alarm: number | null
}

describe.skipIf(process.env.FLOWS_WORKERD_SMOKE !== "1")("ObjectDatabase in workerd (FLOWS_WORKERD_SMOKE=1)", () => {
  let worker: Miniflare

  beforeAll(async () => {
    worker = new Miniflare({
      workers: [{
        config: {
          name: "objects",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: await bundle() } } },
          env: { LOCAL: { type: "durable-object", worker: "objects", exportName: "Local" } },
          exports: { Local: { type: "durable-object", storage: "sqlite" } }
        }
      }]
    })
  }, 120_000)

  afterAll(async () => {
    await worker?.dispose()
  })

  it("runs a flow from real alarms in the object's own SQLite, and a new incarnation finishes it", async () => {
    const executionId = `answer-${randomUUID()}`
    const intent = await Effect.runPromise(
      ExecutionObject.intent(Answer, { executionId, payload: { question: "hi", pauseMs: 0 } })
    )
    const started = await worker.dispatchFetch(`http://objects/${executionId}/start`, {
      method: "POST",
      body: JSON.stringify(intent)
    })
    expect(await started.text()).toBe("accepted")

    const read = async () => (await (await worker.dispatchFetch(`http://objects/${executionId}/`)).json()) as Report
    const answered = await eventually(read, (value) => value.outcomes.length > 0)
    expect(answered.outcomes).toEqual([{ _tag: "Settled", forgetAtMs: expect.any(Number) }])
    expect(answered.steps.map((step) => step.label)).toEqual(["ask:hi", "answer", "answer"])
    const [asked, aborted, answer] = answered.steps
    expect(aborted!.incarnation).toBe(asked!.incarnation)
    expect(answer!.incarnation).not.toBe(aborted!.incarnation)

    const rows = (await (await worker.dispatchFetch(`http://objects/${executionId}/rows`)).json()) as ReadonlyArray<{
      readonly run_id: string
      readonly status: string
    }>
    expect(rows).toEqual([{ run_id: executionId, status: "completed" }])
  }, 120_000)
})
