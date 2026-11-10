import vibelang from "vibelang-unplugin/esbuild"
/**
 * The workerd smoke, run when a host opts in with `FLOWS_WORKERD_SMOKE=1`.
 *
 * It is off by default because it is not a unit test: it starts workerd
 * through Miniflare and needs the compose Postgres behind Miniflare's local
 * Hyperdrive. What it proves is what no Node test can: a real Durable Object
 * runs a flow from a real alarm, `ctx.abort()` inside a step leaves a run the
 * retried alarm's new incarnation takes over and finishes, and workerd never
 * runs a second alarm handler beside one still running, which is what lets an
 * incarnation declare every earlier one on its host dead. And one execution
 * per object holds across objects: a parent starts its child's object and the
 * child's settlement wakes the parent's, a child's failure fails its parent,
 * and each round of a handoff lineage runs on its own object, one of them
 * reset inside its step. And a settled object forgets its execution once its
 * retention window passes: its storage is empty and no alarm is armed, and a
 * late start is answered from the engine's store without running a step.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { ExecutionObject } from "../src/index.ts"
import { Answer } from "./fixtures/AnswerFlow.ts"
import * as NestedFlows from "./fixtures/NestedFlows.ts"
import * as Postgres from "./fixtures/Postgres.ts"

const entry = fileURLToPath(new URL("./workerd/worker.ts", import.meta.url))

/** The Worker as one ES module, with the runtime's own modules left for workerd. */
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

/** Polls `read` until `done` holds, failing after `ms`. */
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

interface Retained {
  readonly steps: ReadonlyArray<string>
  readonly outcomes: ReadonlyArray<ExecutionObject.Outcome>
  readonly storage: Readonly<Record<string, unknown>>
  readonly alarm: number | null
}

interface Run {
  readonly runId: string
  readonly flow: string
  readonly status: string
  readonly roundOrdinal: number
}

describe.skipIf(process.env.FLOWS_WORKERD_SMOKE !== "1" || !Postgres.direct.available)(
  `workerd smoke (FLOWS_WORKERD_SMOKE=1, ${Postgres.direct.label})`,
  () => {
    const schema = Postgres.freshSchema()
    /** `Retained`'s retention window: long enough to see the settlement, short enough to wait out. */
    const retainMs = 5_000
    let worker: Miniflare

    beforeAll(async () => {
      worker = new Miniflare({
        workers: [{
          config: {
            name: "smoke",
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: await bundle() } } },
            env: {
              HYPERDRIVE: { type: "hyperdrive", id: "smoke", dev: { connectionString: Postgres.url } },
              SCHEMA: { type: "text", value: schema },
              RETAIN_MS: { type: "text", value: String(retainMs) },
              EXECUTION: { type: "durable-object", worker: "smoke", exportName: "Execution" },
              NESTED: { type: "durable-object", worker: "smoke", exportName: "Nested" },
              RETAINED: { type: "durable-object", worker: "smoke", exportName: "Retained" },
              PROBE: { type: "durable-object", worker: "smoke", exportName: "Probe" }
            },
            exports: {
              Execution: { type: "durable-object", storage: "sqlite" },
              Nested: { type: "durable-object", storage: "sqlite" },
              Retained: { type: "durable-object", storage: "sqlite" },
              Probe: { type: "durable-object", storage: "sqlite" }
            }
          }
        }]
      })
    }, 120_000)

    afterAll(async () => {
      await worker?.dispose()
      await Postgres.dropSchema(schema)
    })

    const report = async (kind: string, executionId: string) =>
      (await (await worker.dispatchFetch(`http://smoke/${kind}/${executionId}/report`)).json()) as Report

    const start = async (kind: string, intent: ExecutionObject.Intent) => {
      const started = await worker.dispatchFetch(`http://smoke/${kind}/${intent.executionId}/start`, {
        method: "POST",
        body: JSON.stringify(intent)
      })
      expect(await started.text()).toBe("accepted")
    }

    /** Every run in the smoke's schema; none before an alarm's runtime has migrated it. */
    const runs = () =>
      Postgres.admin(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const [table] = yield* sql<{ readonly name: string | null }>`
          SELECT to_regclass(${`${schema}.flows_runs`})::text AS name`
        if (table?.name === null) return []
        const rows = yield* sql<
          {
            readonly run_id: string
            readonly status: string
            readonly state_json: string
            readonly round_ordinal: number
          }
        >`
          SELECT run_id, status, state_json, round_ordinal FROM ${sql(schema)}.flows_runs
          ORDER BY created_at_ms, round_ordinal`
        return rows.map((row): Run => ({
          runId: row.run_id,
          flow: (JSON.parse(row.state_json) as { readonly flowName: string }).flowName,
          status: row.status,
          roundOrdinal: Number(row.round_ordinal)
        }))
      }))

    /** The runs of one tree: `root`, and every run created after it whose flow is in `flows`. */
    const tree = async (root: string, flows: ReadonlyArray<string>) => {
      const all = await runs()
      return all.slice(all.findIndex((run) => run.runId === root)).filter((run) => flows.includes(run.flow))
    }

    const settled = (status: string) => status === "completed" || status === "failed" || status === "cancelled"

    /** A `Settled` outcome, whatever window it was armed to forget at. */
    const settledOutcome = { _tag: "Settled", forgetAtMs: expect.any(Number) }

    /** Whether an object's last alarm settled its execution: its next alarm forgets it. */
    const quiet = (value: Report) => value.outcomes.at(-1)?._tag === "Settled"

    it("runs a flow from a real alarm and finishes it after ctx.abort() inside a step", async () => {
      const executionId = `answer-${randomUUID()}`
      await start(
        "execution",
        await Effect.runPromise(
          ExecutionObject.intent(Answer, { executionId, payload: { question: "hi", pauseMs: 0 } })
        )
      )

      const answered = await eventually(() => report("execution", executionId), (value) => value.outcomes.length > 0)
      expect(answered.outcomes).toEqual([{ _tag: "Settled", forgetAtMs: expect.any(Number) }])
      // The object keeps the intent for its retention window: the alarm waits to forget it.
      expect(answered.alarm).toBe((answered.outcomes[0] as { readonly forgetAtMs: number }).forgetAtMs)
      const [asked, aborted, answer] = answered.steps
      expect(answered.steps.map((step) => step.label)).toEqual(["ask:hi", "answer", "answer"])
      // The reset object came back as a new incarnation, which took the run
      // over when the alarm armed before the drive fired: one backoff
      // later, not a lease later.
      expect(aborted!.incarnation).toBe(asked!.incarnation)
      expect(answer!.incarnation).not.toBe(aborted!.incarnation)
      expect(answer!.at - aborted!.at).toBeLessThan(20_000)
      expect((await runs()).find((run) => run.runId === executionId)?.status).toBe("completed")

      // An alarm armed while a handler runs waits for that handler to end.
      await worker.dispatchFetch("http://smoke/probe/one/arm", { method: "POST" })
      const probe = await eventually(
        async () =>
          (await (await worker.dispatchFetch("http://smoke/probe/one/report")).json()) as {
            readonly handled: number
            readonly most: number
          },
        (value) => value.handled >= 2
      )
      expect(probe.most).toBe(1)
    }, 180_000)

    it("a parent starts its child on the child's own object, and the child's settlement wakes it", async () => {
      const parentId = `parent-${randomUUID()}`
      await start(
        "nested",
        await Effect.runPromise(
          ExecutionObject.intent(NestedFlows.Parent, { executionId: parentId, payload: { label: "hi" } })
        )
      )
      const flows = [NestedFlows.Parent._tag, NestedFlows.Child._tag]
      const [parent, child] = await eventually(
        () => tree(parentId, flows),
        (found) => found.length === 2 && found.every((run) => settled(run.status))
      )
      expect([parent!.status, child!.status]).toEqual(["completed", "completed"])
      const parentObject = await eventually(() => report("nested", parentId), quiet)
      const childObject = await eventually(() => report("nested", child!.runId), quiet)
      expect(childObject.steps.map((step) => step.label)).toEqual(["child:hi"])
      expect(childObject.outcomes).toEqual([settledOutcome])
      expect(parentObject.steps.map((step) => step.label)).toEqual(["parent:child:hi"])
      expect(parentObject.outcomes.at(-1)).toEqual(settledOutcome)
    }, 180_000)

    it("a child's failure fails its parent", async () => {
      const parentId = `guardian-${randomUUID()}`
      await start(
        "nested",
        await Effect.runPromise(ExecutionObject.intent(NestedFlows.Guardian, { executionId: parentId, payload: {} }))
      )
      const flows = [NestedFlows.Guardian._tag, NestedFlows.Faulty._tag]
      const found = await eventually(
        () => tree(parentId, flows),
        (value) => value.length === 2 && value.every((run) => settled(run.status))
      )
      expect(found.map((run) => run.status)).toEqual(["failed", "failed"])
      expect((await eventually(() => report("nested", parentId), quiet)).outcomes.at(-1)).toEqual(settledOutcome)
    }, 180_000)

    it("each round of a lineage runs on its own object, and a reset inside a round's step resumes there", async () => {
      const rootId = `counter-${randomUUID()}`
      await start(
        "nested",
        await Effect.runPromise(
          ExecutionObject.intent(NestedFlows.Counter, { executionId: rootId, payload: { value: 0, target: 3 } })
        )
      )
      const rounds = await eventually(
        () => tree(rootId, [NestedFlows.Counter._tag]),
        (value) => value.length === 3 && value.every((run) => settled(run.status))
      )
      expect(rounds.map((run) => [run.roundOrdinal, run.status])).toEqual([
        [0, "completed"],
        [1, "completed"],
        [2, "completed"]
      ])
      const objects = await Promise.all(
        rounds.map((run) => eventually(() => report("nested", run.runId), quiet))
      )
      expect(objects.map((object) => object.steps.map((step) => step.label))).toEqual([
        ["bump:0"],
        ["bump:1", "bump:1"],
        ["bump:2"]
      ])
      // Round one's object was reset inside its step; a new incarnation
      // finished the round on the same object.
      const [aborted, finished] = objects[1]!.steps
      expect(finished!.incarnation).not.toBe(aborted!.incarnation)
      expect(objects.map((object) => object.outcomes.at(-1))).toEqual([settledOutcome, settledOutcome, settledOutcome])
    }, 180_000)

    it("a settled object forgets its execution after its window, and a late start runs no step again", async () => {
      const executionId = `retained-${randomUUID()}`
      const intent = await Effect.runPromise(
        ExecutionObject.intent(Answer, { executionId, payload: { question: "hi", pauseMs: 0 } })
      )
      const retained = async () =>
        (await (await worker.dispatchFetch(`http://smoke/retained/${executionId}/report`)).json()) as Retained
      const forgotten = (value: Retained) => value.outcomes.at(-1)?._tag === "Forgotten"
      await start("retained", intent)

      // It settles and keeps its intent until the window ends, then the
      // final alarm empties its storage and arms nothing.
      const settledObject = await eventually(retained, (value) => value.outcomes.length > 0)
      expect(settledObject.outcomes).toEqual([settledOutcome])
      expect(Object.keys(settledObject.storage).sort()).toEqual([ExecutionObject.intentKey, ExecutionObject.settledKey])
      const { forgetAtMs } = settledObject.outcomes[0] as { readonly forgetAtMs: number }
      expect(settledObject.alarm).toBe(forgetAtMs)
      expect(forgetAtMs - (settledObject.storage[ExecutionObject.settledKey] as number)).toBe(retainMs)

      const emptied = await eventually(retained, forgotten)
      expect(emptied.outcomes).toEqual([settledOutcome, { _tag: "Forgotten" }])
      expect(emptied.storage).toEqual({})
      expect(emptied.alarm).toBeNull()
      expect(emptied.steps).toEqual(["ask:hi", "answer"])
      expect((await runs()).find((run) => run.runId === executionId)?.status).toBe("completed")

      // A late wake finds nothing to drive.
      const woken = await worker.dispatchFetch(`http://smoke/retained/${executionId}/wake`, { method: "POST" })
      expect(await woken.text()).toBe("idle")

      // A late start of the same intent settles from the engine's stored run,
      // runs no step again, and the object forgets it once more.
      await start("retained", intent)
      const again = await eventually(retained, (value) => value.outcomes.length === 4 && forgotten(value))
      expect(again.outcomes).toEqual([settledOutcome, { _tag: "Forgotten" }, settledOutcome, { _tag: "Forgotten" }])
      expect(again.steps).toEqual(["ask:hi", "answer"])
      expect(again.storage).toEqual({})
      expect(again.alarm).toBeNull()
    }, 180_000)
  }
)
