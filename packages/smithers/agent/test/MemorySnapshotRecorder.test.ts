import * as EngineLike from "@smthrs/harness/EngineLike"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Source from "@smthrs/memory/Source"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as MemorySnapshotRecorder from "../src/MemorySnapshotRecorder.ts"

describe("MemorySnapshotRecorder", () => {
  it("replays the opening snapshot through EngineLike.record for a resumed source", async () => {
    const records = new Map<string, unknown>()
    const boundaries: Array<EngineLike.RecordBoundary<unknown>> = []
    const engine = EngineLike.makeNoop({
      record: <A>(boundary: EngineLike.RecordBoundary<A>) =>
        Effect.suspend(() => {
          boundaries.push(boundary as EngineLike.RecordBoundary<unknown>)
          const key = JSON.stringify([boundary.name, boundary.identity])
          if (records.has(key)) return Effect.succeed(records.get(key) as A)
          return boundary.execute.pipe(Effect.tap((value) => Effect.sync(() => records.set(key, value))))
        })
    })
    const recorder = MemorySnapshotRecorder.layer.pipe(Layer.provide(EngineLike.layer(engine)))
    let reads = 0
    let memory = "memory before the crash"
    const store = MemoryStore.makeNoop({
      searchRows: () =>
        Effect.sync(() => {
          reads += 1
          return [{
            id: "note",
            kind: "note",
            bank: "bank",
            namespace: { kind: "global", id: "bank" },
            key: "note",
            text: memory,
            tags: [],
            updatedAtMs: 0
          }]
        })
    })
    const input = { lineageId: "run-1", iteration: 7, banks: ["bank"], query: "q" }
    const read = (source: Source.Source) =>
      Effect.runPromise(
        Source.declaredText(source, input).pipe(
          Effect.provideService(MemoryStore.MemoryStore, store),
          Effect.provideService(Recall.Recall, Recall.makeNoop()),
          Effect.provide(recorder)
        )
      )

    const first = await read(Source.make())
    memory = "memory after the crash"
    const resumed = await read(Source.make())

    expect(resumed).toEqual(first)
    expect(resumed.text).toContain("memory before the crash")
    expect(resumed.text).not.toContain("memory after the crash")
    expect(reads).toBe(1)
    expect(boundaries).toHaveLength(2)
    expect(boundaries[0]).toMatchObject({
      name: "memory-snapshot",
      identity: { session: "run-1", frame: 7, boundary: "opening-context" }
    })
  })
})
