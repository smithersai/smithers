import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import { afterAll, beforeAll, describe, test } from "vitest"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"
import { journalOf, makeRuns, row as makeRow } from "./MemoryHarness.ts"

const lineageId = "bench-run/root"

const makeRecords = (count: number): Array<MemoryTimeTravelStore.JournalRecord> =>
  Array.from({ length: count }, (_, seq) => ({
    runId: "bench-run",
    seq,
    eventId: `event-${seq}`,
    lineageId,
    payload: {
      eventType: "step.completed",
      payload: { step: seq, delta: (seq % 7) + 1 },
      meta: { lineageId, ...(seq % 10 === 0 ? { cacheKey: `sealed-${seq}` } : {}) }
    }
  }))

const makeLayer = (store: ReturnType<typeof MemoryTimeTravelStore.make>, runs: RunStore.Service) =>
  TimeTravel.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TimeTravelStore)(store),
        Layer.succeed(RunStore.RunStore)(runs),
        Layer.succeed(Journal.Journal)(journalOf(store)),
        Layer.succeed(Jj.Jj)(
          Jj.makeNoop({
            snapshot: () => Effect.succeed({ commitId: "commit-1", changeId: "change-1" }),
            workspaceAdd: () => Effect.void,
            workspaceForget: () => Effect.void
          })
        ),
        CacheStore.layerNoop({
          get: (key) =>
            Effect.succeed(
              key.startsWith("sealed-")
                ? Option.some({
                  keyDigest: key,
                  result: { cached: true },
                  meta: {},
                  createdAtMs: 1,
                  recordedRunId: "bench-run",
                  recordedEventSeq: 0
                })
                : Option.none()
            )
        })
      )
    )
  )

let runtime: ManagedRuntime.ManagedRuntime<TimeTravel, unknown>

beforeAll(() => {
  const store = MemoryTimeTravelStore.make({ records: makeRecords(500) })
  const runs = makeRuns([makeRow({ runId: "bench-run" })])
  runtime = ManagedRuntime.make(makeLayer(store, runs))
})

afterAll(async () => {
  await runtime.dispose()
})

const sumProjection = {
  initial: 0,
  reduce: (state: number, entry: { readonly payload: unknown }) => {
    const payload = entry.payload as { readonly delta?: number } | null
    return state + (payload?.delta ?? 0)
  }
}

describe("@smthrs/time-travel", () => {
  test("TimeTravel.inspect (fold 500 journal entries to frame 499)", async ({ bench }) => {
    const program = Effect.flatMap(
      TimeTravel,
      (tt) => tt.inspect({ runId: "bench-run", frame: { lineageId, seq: 499 } }, sumProjection)
    )
    await bench("TimeTravel.inspect 500 entries", async () => {
      await runtime.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("TimeTravel.replay (re-derive 500 entries with sealed cache lookups)", async ({ bench }) => {
    const program = Effect.flatMap(
      TimeTravel,
      (tt) => tt.replay({ runId: "bench-run", frame: { lineageId, seq: 499 } }, sumProjection)
    )
    await bench("TimeTravel.replay 500 entries", async () => {
      await runtime.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("TimeTravel.fork (branch from frame 250)", async ({ bench }) => {
    const program = Effect.flatMap(TimeTravel, (tt) => tt.fork({ runId: "bench-run", frame: { lineageId, seq: 250 } }))
    await bench("TimeTravel.fork frame 250", async () => {
      await runtime.runPromise(program)
    }).run({ iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 })
  })
})
