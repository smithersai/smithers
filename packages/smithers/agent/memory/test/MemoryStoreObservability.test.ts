import { Effect, Metric, Tracer } from "effect"
import { describe, expect, it } from "vitest"
import { operations } from "../src/internal/Instrument.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "observed" } as const

const recordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  return { spans, tracer }
}

describe("MemoryStore observability", () => {
  it("traces each operation with shape attributes and never values", async () => {
    const { spans, tracer } = recordingTracer()
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        yield* store.putFact({ namespace, key: "secret-key", value: "secret-value", provenance: {} })
        yield* store.listFacts({ namespace, limit: 5 })
      }).pipe(Effect.provide(TestMemory.layer), Effect.provideService(Tracer.Tracer, tracer))
    )
    const put = spans.find((span) => span.name === "MemoryStore.putFact")
    const list = spans.find((span) => span.name === "MemoryStore.listFacts")
    expect(put?.attributes.get("memory.namespace_kind")).toBe("flow")
    expect(list?.attributes.get("memory.limit")).toBe(5)
    expect(list?.attributes.get("memory.rows")).toBe(1)
    const serialized = JSON.stringify(spans.map((span) => [...span.attributes.entries()]))
    expect(serialized).not.toContain("secret")
  })

  it("counts operation outcomes by method", async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const failures = Metric.withAttributes(operations, { method: "putFact", outcome: "failure" })
        const before = (yield* Metric.value(failures)).count
        yield* store.putFact({ namespace, key: "", value: "value", provenance: {} }).pipe(Effect.ignore)
        return { before, after: (yield* Metric.value(failures)).count }
      }).pipe(Effect.provide(TestMemory.layer))
    )
    expect(counts.after).toBe(counts.before + 1)
  })
})
