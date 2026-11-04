import { Control, type ControlSchema } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as RunHistory from "../src/cli/RunHistory.ts"
import { terminalSafeJson } from "../src/internal/Failure.ts"

const event = (
  sequence: number,
  payload: ControlSchema.ControlEvent["payload"],
  kind = "state"
): ControlSchema.ControlEvent => ({
  sequence,
  payload,
  kind,
  runId: "large",
  occurredAt: sequence
})

describe("streamed run diagnosis", () => {
  it("counts JSON bytes without constructing a serialized record", () => {
    for (const value of [null, true, 1, [], {}, "é😀\ud800\n\t", { a: ["é", "😀", "\ud800"], b: null }]) {
      expect(RunHistory.jsonBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)))
    }
  })

  it("preserves every event and the exact small-run shape at the inclusive limit", async () => {
    const values = [event(1, { cause: "x".repeat(5000) }, "control.run.failed")]
    const bytes = RunHistory.jsonBytes(values[0]) + 1
    expect(
      await Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", {
        maxEvents: 1,
        maxBytes: bytes,
        maxEventBytes: bytes
      }))
    ).toEqual({ events: values })
  })

  it("keeps a bounded recent window and the last error, node and round after a total 16 MiB overflow", async () => {
    const state = { text: "x".repeat(512 * 1024) }
    const stream = Stream.fromIterable((function*() {
      yield event(1, { cause: "early failure" }, "control.run.failed")
      yield event(2, { currentNode: "handoff", round: 401 })
      for (let i = 3; i < 43; i++) yield event(i, state)
    })())
    const result = await Effect.runPromise(RunHistory.read(stream, "large"))
    expect(result.history).toMatchObject({
      lastRecordedNode: "handoff",
      currentNodeUnavailable: true,
      round: 401,
      lastError: "early failure",
      events: 42
    })
    expect(result.history!.bytes).toBeGreaterThan(16 * 1024 * 1024)
    expect(result.history!.omittedEvents).toBeGreaterThan(0)
    expect(result.history!.omittedBytes).toBeGreaterThan(0)
    expect(result.events.at(-1)?.sequence).toBe(42)
    expect(result.events.reduce((n, v) => n + RunHistory.jsonBytes(v) + 1, 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
  })

  it("bounds both truncation receipts and many tiny events", async () => {
    const result = await Effect.runPromise(RunHistory.read(
      Stream.fromIterable((function*() {
        for (let i = 1; i <= 100; i++) yield event(i, { state: "x".repeat(2000) })
      })()),
      "large",
      { maxEvents: 3, maxBytes: 2000, maxEventBytes: 1000 }
    ))
    expect(result.events.length).toBeLessThanOrEqual(3)
    expect(result.history!.truncatedFields.length).toBe(20)
    expect(result.history!.truncatedFieldsOmitted).toBe(80)
  })

  it("reports nested state omissions while keeping its operational fields", async () => {
    const result = await Effect.runPromise(RunHistory.read(
      Stream.make(event(1, {
        state: { currentNode: "handoff", round: 401, blob: "x".repeat(17 * 1024 * 1024) }
      })),
      "large"
    ))
    expect(result.history).toMatchObject({ currentNode: "handoff", round: 401 })
    expect(result.history!.truncatedFields).toEqual([{
      path: "/events/1/payload/state/blob",
      bytes: 17 * 1024 * 1024 + 2
    }])
    expect(result.events[0]!.payload).toEqual({ state: { currentNode: "handoff", round: 401, blob: null } })
  })

  it("pages an oversized string and reads a small sibling through the same pointer reader", async () => {
    const value = "x".repeat(17 * 1024 * 1024) + "END"
    const stream = Stream.make(event(1, { "a/b~c": value, round: 401 }))
    const path = "/events/1/payload/a~1b~0c"
    expect(await Effect.runPromise(RunHistory.field(stream, path, undefined, { offset: value.length - 3, length: 3 })))
      .toMatchObject({ path, bytes: value.length + 2, value: "END", page: { totalCharacters: value.length } })
    expect(await Effect.runPromise(RunHistory.field(stream, "/events/1/payload/round")))
      .toEqual({ path: "/events/1/payload/round", bytes: 3, value: 401 })
    const first = await Effect.runPromise(RunHistory.field(stream, path))
    expect(String(first.value).length).toBe(4096)
    expect(first.page?.nextOffset).toBe(4096)
  })

  it("reports oversized objects instead of returning an unbounded field", async () => {
    const result = await Effect.runPromise(
      RunHistory.field(Stream.make(event(1, { state: { a: "x".repeat(1000) } })), "/events/1/payload/state", 100)
    )
    expect(result).toEqual({ path: "/events/1/payload/state", bytes: 1008, omitted: true })
  })

  it.each(["no pointer", "/events/1/payload/nope", "/events/1/payload/~2", "/events/2/payload"])(
    "refuses invalid or absent fields: %s",
    async (path) => {
      const error = await Effect.runPromise(Effect.flip(RunHistory.field(Stream.make(event(1, {})), path)))
      expect(error._tag).toBe("/cli/UsageError")
    }
  )

  it("propagates storage failures after a partial read", async () => {
    const error = await Effect.runPromise(
      Effect.flip(RunHistory.read(Stream.concat(Stream.make(event(1, {})), Stream.fail("read failed")), "large"))
    )
    expect(error).toBe("read failed")
  })
})

it("reclaims long evicted prefixes while retaining the latest events", async () => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.fromIterable((function*() {
      for (let i = 1; i <= 1030; i++) yield event(i, null)
    })()),
    "large",
    { maxEvents: 3, maxBytes: 1000, maxEventBytes: 1000 }
  ))
  expect(result.events.map((v) => v.sequence)).toEqual([1028, 1029, 1030])
  expect(result.history!.omittedEvents).toBe(1027)
  expect(result.history!.truncatedFields).toEqual([])
})

it("refuses pagination on objects and terminates a string page past its end", async () => {
  const stream = Stream.make(event(1, { state: {}, text: "abc" }))
  const error = await Effect.runPromise(
    Effect.flip(RunHistory.field(stream, "/events/1/payload/state", undefined, { offset: 0, length: 10 }))
  )
  expect(error.message).toBe("--offset/--length require a string field")
  const page = await Effect.runPromise(
    RunHistory.field(stream, "/events/1/payload/text", undefined, { offset: 100, length: 10 })
  )
  expect(page).toMatchObject({ value: "", page: { offset: 100, length: 0, totalCharacters: 3 } })
  expect(page.page).not.toHaveProperty("nextOffset")
})

it("keeps field pages bounded by escaped UTF-8 size", async () => {
  const result = await Effect.runPromise(
    RunHistory.field(Stream.make(event(1, { text: "\u0000".repeat(20) })), "/events/1/payload/text", 20)
  )
  expect(RunHistory.jsonBytes(result.value)).toBeLessThanOrEqual(20)
  expect(result.page!.nextOffset).toBe(3)
})

it("bounds deep and wide payload projections, including arrays", async () => {
  const many = Array.from({ length: 300 }, () => "x".repeat(20))
  let nested: any = { blob: "x".repeat(20_000) }
  for (let i = 0; i < 40; i++) nested = { child: nested }
  const result = await Effect.runPromise(
    RunHistory.read(Stream.make(event(1, { many, nested })), "large", {
      maxEvents: 10,
      maxBytes: 2000,
      maxEventBytes: 1000
    })
  )
  expect(result.history!.truncatedFields.length).toBeGreaterThan(0)
  expect(result.events.reduce((n, v) => n + RunHistory.jsonBytes(v) + 1, 0)).toBeLessThanOrEqual(2000)
})

it("bounds a large prior error while preserving fault-only and empty error observations", async () => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.make(
      event(1, { cause: "x".repeat(10_000) }, "control.run.failed"),
      event(2, { blob: "x".repeat(2000) })
    ),
    "large",
    { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  ))
  expect(result.history!.lastError).toEqual({ omitted: true, bytes: 10002, path: "/events/1/payload/cause" })
  for (const payload of [{ fault: "last fault" }, {}]) {
    const last = await Effect.runPromise(
      RunHistory.read(
        Stream.make(event(1, payload, "control.run.failed"), event(2, { blob: "x".repeat(2000) })),
        "large",
        { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
      )
    )
    expect(last.history!.lastError).toBe("fault" in payload ? "last fault" : null)
  }
})

it("bounds metadata for a 17 MiB JSON key using its bounded ancestor", async () => {
  const huge = "k".repeat(17 * 1024 * 1024)
  const result = await Effect.runPromise(RunHistory.read(Stream.make(event(1, { [huge]: true })), "large"))
  expect(result.history!.truncatedFields).toEqual([{ path: "/events/1/payload", bytes: huge.length + 9 }])
  expect(result.history!.largestFields[0]).toEqual({ path: "/events/1/payload", bytes: huge.length + 9 })
  expect(JSON.stringify(result).length).toBeLessThan(100_000)
})

it("bounds deep pointer metadata even when each segment fits", async () => {
  let payload: any = "x".repeat(17 * 1024 * 1024)
  for (let i = 0; i < 20; i++) payload = { ["k".repeat(256)]: payload }
  const result = await Effect.runPromise(RunHistory.read(Stream.make(event(1, payload)), "large"))
  expect(result.history!.truncatedFields.every((field) => Buffer.byteLength(field.path) <= 2048)).toBe(true)
})

it("reads the actual expanded watch member named by each omission receipt", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const journal = yield* Journal.Journal
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make("large"),
          sourceId: JournalEvent.SourceId.make("test"),
          eventType: "flows/notifications/Promoted",
          payload: { boundary: "b".repeat(2000), ids: ["one", "two"] }
        })
      )
      const stream = control.watch({ runId: "large", follow: false })
      const result = yield* RunHistory.read(stream, "large", { maxEvents: 10, maxBytes: 10000, maxEventBytes: 1000 })
      const receipt = result.history!.truncatedFields.find((field) => field.path.includes(":1/"))!
      expect(receipt.path).toMatch(/\/events\/\d+:1\/payload\/boundary/)
      expect((yield* RunHistory.field(stream, receipt.path)).value).toBe("b".repeat(2000))
      const path = receipt.path.replace("/boundary", "/messageId")
      const operation = RunHistory.field(stream, path)
      expect((yield* operation).value).toBe("one")
      expect((yield* operation).value).toBe("one")
      const last = path.replace(":1/", ":2/")
      expect((yield* RunHistory.field(stream, last)).value).toBe("two")
    }).pipe(Effect.provide(TestControl.layer()), Effect.scoped)
  )
})

const engine = (
  sequence: number,
  eventType: string,
  payload: Record<string, any>,
  executionId = "execution",
  generation?: number | string | null
) =>
  event(sequence, {
    executionId,
    eventType,
    payload,
    ...(generation === undefined ? {} : { generation })
  }, "control.engine.event")

it("invalidates a missed settlement on a compaction gap and accepts fresh scheduling", async () => {
  const values = [
    event(1, { currentNode: "historical" }),
    engine(2, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "a", action: "stale" }),
    event(3, { executionId: "execution", generation: 0, reason: "compacted" }, "control.engine.projection-gap")
  ]
  const limits = { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  const read = () => Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits, "execution"))
  expect((await read()).history).toMatchObject({ currentNodeUnavailable: true, lastRecordedNode: "historical" })
  expect((await read()).history!.currentNode).toBeUndefined()
  values.push(engine(4, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "b", action: "fresh" }))
  expect((await read()).history!.currentNode).toBe("fresh")
})

it.each([true, false])("discards old-generation activity and hints with a rewind receipt: %s", async (receipt) => {
  const values = [
    engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "a", action: "stale" }),
    event(2, { currentNode: "prior-epoch", round: 400 }),
    ...(receipt ? [
      event(3, { executionId: "execution", generation: 1, reason: "rewound" }, "control.engine.projection-gap")
    ] : []),
    engine(4, "checkpoint", {}, "execution", 1),
    engine(5, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "a", action: "replayed-old" }, "execution", 0)
  ]
  const limits = { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  const read = () => Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits, "execution"))
  const rewound = (await read()).history!
  expect(rewound.currentNodeUnavailable).toBe(true)
  expect(rewound.currentNode).toBeUndefined()
  expect(rewound.lastRecordedNode).toBeUndefined()
  expect(rewound.round).toBeUndefined()
  values.push(engine(6, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "b", action: "fresh" }, "execution", 1))
  values.push(engine(7, "flows.engine.node-settled", { nodeId: "b" }, "execution", 0))
  values.push(engine(8, "terminal", {
    executionFact: { observation: { executionId: "execution", status: "completed", roundOrdinal: 999 } }
  }, "execution", 0))
  values.push(event(9, { executionId: "execution", generation: 0, reason: "compacted" }, "control.engine.projection-gap"))
  const fresh = (await read()).history!
  expect(fresh.currentNode).toBe("fresh")
  expect(fresh.round).toBeUndefined()
  values.push(engine(10, "checkpoint", {}, "execution", 2))
  expect((await read()).history!.currentNodeUnavailable).toBe(true)
  values.push(engine(11, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "new-epoch" }, "execution", 2))
  expect((await read()).history!.currentNode).toBe("new-epoch")
})

it.each(["completed", "failed", "cancelled"])("starts a fresh terminal lifecycle after %s and rewind", async (status) => {
  const values = [
    engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "old" }),
    event(2, {}, `control.run.${status}`),
    event(3, { executionId: "execution", generation: 1, reason: "rewound" }, "control.engine.projection-gap"),
    event(4, {}, "control.run.resume"),
    engine(5, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "delayed-old" }, "execution", 0)
  ]
  const read = () => Effect.runPromise(RunHistory.read(
    Stream.fromIterable(values), "large", { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }, "execution"
  ))
  expect((await read()).history!.currentNodeUnavailable).toBe(true)
  values.push(engine(6, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "fresh" }, "execution", 1))
  values.push(engine(7, "terminal", {
    executionFact: { observation: { executionId: "execution", status: "failed" } }
  }, "execution", 0))
  expect((await read()).history!.currentNode).toBe("fresh")

  values.push(event(8, {}, `control.run.${status}`))
  values.push(engine(9, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "late" }, "execution", 1))
  expect((await read()).history!.currentNodeUnavailable).toBe(true)
  // An observed generation advance also confirms a rewind without its gap receipt.
  values.push(engine(10, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "next" }, "execution", 2))
  expect((await read()).history!.currentNode).toBe("next")
})

it.each(["control.run.resume", "control.run.resumed"])("requires fresh evidence for a resumed lifecycle: %s", async (kind) => {
  const values = [
    event(1, {}, "control.run.failed"),
    engine(2, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "delayed-old" }),
    event(3, { currentNode: "old-hint" }),
    event(4, {}, kind)
  ]
  const read = () => Effect.runPromise(RunHistory.read(
    Stream.fromIterable(values), "large", { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }, "execution"
  ))
  expect((await read()).history).toMatchObject({ currentNodeUnavailable: true, lastRecordedNode: "old-hint" })
  values.push(engine(5, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "fresh" }))
  expect((await read()).history!.currentNode).toBe("fresh")
})

it.each([
  { hint: true, rewound: false },
  { hint: false, rewound: false },
  { hint: true, rewound: true },
  { hint: false, rewound: true }
])("scopes child gaps and ignores foreign records: %j", async ({ hint, rewound }) => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.make(
      engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "root" }),
      engine(2, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "child" }, "child"),
      event(3, { round: 401, ...(hint ? { currentNode: "fresh-root" } : {}) }),
      event(4, { executionId: "child", generation: rewound ? 1 : 0, reason: rewound ? "rewound" : "compacted" },
        "control.engine.projection-gap"),
      { ...engine(5, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "rogue" }), runId: "other" },
      { ...event(6, {}, "control.engine.projection-gap"), runId: "other" }
    ),
    "large",
    { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 },
    "execution"
  ))
  if (rewound) {
    expect(result.history!.currentNode).toBeUndefined()
    expect(result.history!.currentNodeUnavailable).toBe(true)
    expect(result.history!.round).toBeUndefined()
  } else {
    expect(result.history!.currentNode).toBe(hint ? "fresh-root" : "root")
    expect(result.history!.round).toBe(401)
  }
})

it("invalidates a grandchild action when a non-selected child is rewound", async () => {
  const values = [
    engine(1, "observed", { executionFact: { observation: { executionId: "root", parentRunId: null } } }, "root"),
    engine(2, "observed", { executionFact: { observation: { executionId: "child", parentRunId: "root" } } }, "child"),
    engine(3, "observed", { executionFact: { observation: { executionId: "grandchild", parentRunId: "child" } } }, "grandchild"),
    engine(4, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "old-grandchild" }, "grandchild"),
    event(5, { executionId: "child", generation: 1, reason: "rewound" }, "control.engine.projection-gap")
  ]
  const limits = { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  const read = () => Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits, "root"))
  expect((await read()).history!.currentNode).toBeUndefined()
  expect((await read()).history!.currentNodeUnavailable).toBe(true)
  values.push(engine(6, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "fresh-child" }, "child", 1))
  expect((await read()).history!.currentNode).toBe("fresh-child")
})

it.each([null, undefined])("invalidates an unknown generation (%s) without forgetting the last known epoch", async (generation) => {
  const values = [
    engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "a" }, "execution", 1),
    event(2, {
      executionId: "execution", ...(generation === undefined ? {} : { generation }), reason: "unavailable"
    }, "control.engine.projection-gap"),
    engine(3, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "old" }, "execution", 0)
  ]
  const limits = { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  const read = () => Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits, "execution"))
  expect((await read()).history!.currentNodeUnavailable).toBe(true)
  values.push(engine(4, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "b" }, "execution", 1))
  expect((await read()).history!.currentNode).toBe("b")
})

it.each([null, {}, { executionId: "" }, { executionId: "x".repeat(257) }])(
  "reports unavailable activity for an unscoped or oversized projection gap: %j",
  async (payload) => {
    const result = await Effect.runPromise(RunHistory.read(
      Stream.make(
        engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "a" }),
        event(2, payload, "control.engine.projection-gap")
      ),
      "large",
      { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
    ))
    expect(result.history!.currentNodeUnavailable).toBe(true)
    expect(result.history!.currentNode).toBeUndefined()
  }
)

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null])(
  "refuses current-node evidence from a malformed native generation: %s",
  async (generation) => {
    const result = await Effect.runPromise(RunHistory.read(
      Stream.make(
        engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "a" }),
        engine(2, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "b" }, "execution", generation)
      ),
      "large",
      { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
    ))
    expect(result.history!.currentNodeUnavailable).toBe(true)
    expect(result.history!.currentNode).toBeUndefined()
  }
)

it("invalidates current evidence when a native envelope is missing", async () => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.make(
      engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "a" }),
      event(2, null, "control.engine.event")
    ),
    "large",
    { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  ))
  expect(result.history!.currentNodeUnavailable).toBe(true)
  expect(result.history!.currentNode).toBeUndefined()
})

it.each([127, 128])("bounds generation tracking after %s other rewound executions", async (count) => {
  const values = Array.from({ length: count }, (_, index) => engine(index, "checkpoint", {}, `other-${index}`, 1))
  values.push(engine(count, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "fresh" }, "execution", 1))
  const result = await Effect.runPromise(RunHistory.read(
    Stream.fromIterable(values), "large", { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  ))
  if (count === 127) expect(result.history!.currentNode).toBe("fresh")
  else expect(result.history!.currentNodeUnavailable).toBe(true)
})

it("keeps current evidence after thousands of ordinary executions without retaining generation-zero watermarks", async () => {
  const values = Array.from({ length: 1000 }, (_, index) => engine(index, "checkpoint", {}, `other-${index}`))
  values.push(engine(1000, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "fresh" }))
  const result = await Effect.runPromise(RunHistory.read(
    Stream.fromIterable(values), "large", { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  ))
  expect(result.history!.currentNode).toBe("fresh")
})
it("preserves a running action independently of evicted payloads, then clears its settlement", async () => {
  const values = [
    engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "node", action: "long.action" })
  ]
  for (let i = 2; i <= 20; i++) values.push(event(i, {}))
  const limits = { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  const result = await Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits))
  expect(result.history!.currentNode).toBe("long.action")
  values.push(engine(21, "flows.engine.node-settled", { nodeId: "node" }))
  const settled = await Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits))
  expect(settled.history!.currentNode).toBeUndefined()
  expect(settled.history!.currentNodeUnavailable).toBe(true)
})

it("bounds operational state and never substitutes an execution identity", async () => {
  const values = Array.from(
    { length: 129 },
    (_, i) => engine(i, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: String(i), action: "action" })
  )
  const result = await Effect.runPromise(
    RunHistory.read(Stream.fromIterable(values), "large", { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 })
  )
  expect(result.history!.currentNode).toBeUndefined()
  expect(result.history!.currentNodeUnavailable).toBe(true)
})

it.each([
  { nodeId: "n".repeat(257), action: "action" },
  { nodeId: "node", action: "a".repeat(1025) }
])("reports unavailable evidence for oversized operational identities: %j", async (fields) => {
  const result = await Effect.runPromise(
    RunHistory.read(
      Stream.make(engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", ...fields }), event(2, {})),
      "large",
      { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
    )
  )
  expect(result.history!.currentNodeUnavailable).toBe(true)
})

it("removes a terminal execution's active nodes and keeps its observed round", async () => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.make(
      engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "node" }),
      engine(2, "flows.engine.completed", {
        executionFact: { observation: { executionId: "execution", status: "completed", roundOrdinal: 401 } }
      })
    ),
    "large",
    { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 },
    "execution"
  ))
  expect(result.history!.round).toBe(401)
  expect(result.history!.currentNodeUnavailable).toBe(true)
})

it("shell-quotes the run identity in the suggested field command", async () => {
  const result = await Effect.runPromise(
    RunHistory.read(Stream.make(event(1, {}), event(2, {})), "run-$(echo unsafe)-`id`", {
      maxEvents: 1,
      maxBytes: 1000,
      maxEventBytes: 1000
    })
  )
  expect(result.history!.read).toBe(
    "smthrs runs show 'run-$(echo unsafe)-`id`' --field '/events/<sequence>[:<member>]/payload/<field>'"
  )
})

it("refuses oversized field pointers before reading any data", async () => {
  const error = await Effect.runPromise(
    Effect.flip(RunHistory.field(Stream.fail("must not read"), "/events/1/" + "x".repeat(2048)))
  )
  expect(error).toMatchObject({ _tag: "/cli/UsageError" })
})

it("matches JSON's treatment of inherited members and undefined array entries", async () => {
  const payload = Object.assign(Object.create({ inherited: "excluded" }), { blob: "x".repeat(2000) })
  expect(RunHistory.jsonBytes(payload)).toBe(Buffer.byteLength(JSON.stringify(payload)))
  expect(RunHistory.jsonBytes([undefined])).toBe(Buffer.byteLength(JSON.stringify([undefined])))
  const result = await Effect.runPromise(
    RunHistory.read(Stream.make(event(1, payload)), "large", { maxEvents: 10, maxBytes: 2000, maxEventBytes: 1000 })
  )
  expect(result.events[0]!.payload).toEqual({ blob: null })
})

it("retains small array siblings when an array element is truncated", async () => {
  const result = await Effect.runPromise(
    RunHistory.read(Stream.make(event(1, ["x".repeat(2000), 123])), "large", {
      maxEvents: 10,
      maxBytes: 2000,
      maxEventBytes: 1000
    })
  )
  expect(result.events[0]!.payload).toEqual([null, 123])
  expect(result.history!.truncatedFields).toEqual([{ path: "/events/1/payload/0", bytes: 2002 }])
})

it("clears only the execution that finished", async () => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.make(
      engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "node", action: "first" }),
      engine(2, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "node", action: "second" }, "other"),
      engine(3, "flows.engine.completed", {
        executionFact: { observation: { executionId: "execution", status: "completed", roundOrdinal: 401 } }
      })
    ),
    "large",
    { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  ))
  expect(result.history!.currentNode).toBe("second")
})

it("scopes round and failure observations to the selected execution and run", async () => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.make(
      event(1, { cause: "own failure" }, "control.run.failed"),
      engine(
        2,
        "observation",
        { executionFact: { observation: { executionId: "current", roundOrdinal: 401 } } },
        "current"
      ),
      engine(
        3,
        "observation",
        { round: 0, executionFact: { observation: { executionId: "child", roundOrdinal: 0 } } },
        "child"
      ),
      { ...event(4, { round: 0, cause: "foreign failure" }, "control.run.failed"), runId: "child" }
    ),
    "large",
    { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 },
    "current"
  ))
  expect(result.history!.round).toBe(401)
  expect(result.history!.lastError).toBe("own failure")
})

it("keeps the actual field address for an oversized fault-only error", async () => {
  const stream = Stream.make(event(1, { fault: "x".repeat(6000) }, "control.run.failed"), event(2, {}))
  const result = await Effect.runPromise(
    RunHistory.read(stream, "large", { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 })
  )
  expect(result.history!.lastError).toEqual({ omitted: true, bytes: 6002, path: "/events/1/payload/fault" })
  expect((await Effect.runPromise(RunHistory.field(stream, "/events/1/payload/fault"))).value).toBe("x".repeat(6000))
})

it("renders structured error evidence and explicit omission receipts", () => {
  expect(RunHistory.errorText({ code: "broken", message: "synthetic" })).toBe(
    "{\"code\":\"broken\",\"message\":\"synthetic\"}"
  )
  expect(RunHistory.errorText({ omitted: true, bytes: 6002, path: "/events/1/payload/fault" })).toBe(
    "omitted 6002 bytes; read /events/1/payload/fault"
  )
  expect(RunHistory.errorText("failure")).toBe("failure")
  expect(RunHistory.errorText(undefined)).toBe("null")
  expect(RunHistory.errorText(null)).toBe("null")
  expect(RunHistory.errorText({ omitted: true, bytes: "invalid" })).toBe("{\"omitted\":true,\"bytes\":\"invalid\"}")
})

it("measures deeply nested persisted JSON iteratively before depth-bounded projection", async () => {
  // JSON.parse models a decoded persisted/wire value without a large fixture
  // or a recursive fixture generator. Depth is separate from encoded bytes.
  const depth = 20_000
  const text = "{\"a\":".repeat(depth) + "0" + "}".repeat(depth)
  const value = JSON.parse(text)
  expect(RunHistory.jsonBytes(value)).toBe(depth * 6 + 1)
  const stream = Stream.make(event(1, { value }))
  const result = await Effect.runPromise(
    RunHistory.read(stream, "large", { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 })
  )
  expect(JSON.stringify(result).length).toBeLessThan(10_000)
  expect(result.history!.truncatedFields.length).toBeGreaterThan(0)
  expect(await Effect.runPromise(RunHistory.field(stream, "/events/1/payload/value", 100)))
    .toEqual({ path: "/events/1/payload/value", bytes: text.length, omitted: true })
})

it("reconciles historical state nodes with newer scheduling, settlement and terminal evidence", async () => {
  const values = [
    event(1, { currentNode: "old" }),
    engine(2, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "new", action: "new.action" })
  ]
  const limits = { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  const current = await Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits, "execution"))
  expect(current.history).toMatchObject({ currentNode: "new.action", lastRecordedNode: "old" })
  values.push(engine(3, "flows.engine.node-settled", { nodeId: "new" }))
  const settled = await Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits, "execution"))
  expect(settled.history!.currentNode).toBeUndefined()
  expect(settled.history).toMatchObject({ currentNodeUnavailable: true, lastRecordedNode: "old" })
  values.push(event(4, { currentNode: "later" }))
  values.push(engine(5, "terminal", { executionFact: { observation: { executionId: "execution", status: "failed" } } }))
  const finished = await Effect.runPromise(RunHistory.read(Stream.fromIterable(values), "large", limits, "execution"))
  expect(finished.history!.currentNode).toBeUndefined()
  expect(finished.history!.lastRecordedNode).toBe("later")
})

it("accepts a newer selected state observation without confusing another execution's completion", async () => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.make(
      engine(1, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "new", action: "new.action" }, "other"),
      event(2, { currentNode: "later" }),
      engine(3, "terminal", { executionFact: { observation: { executionId: "unrelated", status: "failed" } } })
    ),
    "large",
    { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 },
    "execution"
  ))
  expect(result.history!.currentNode).toBe("later")
})

it("bounds oversized state node evidence and ignores foreign state observations", async () => {
  const result = await Effect.runPromise(RunHistory.read(
    Stream.make(
      { ...event(1, { currentNode: "foreign" }), runId: "other" },
      event(2, { currentNode: "x".repeat(1025) }),
      event(3, {})
    ),
    "large",
    { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 }
  ))
  expect(result.history!.currentNode).toBeUndefined()
  expect(result.history!.lastRecordedNode!.length).toBe(1024)
})

it("measures formatted JSON and rejects output inflation and excessive field depth", async () => {
  const values = [
    [],
    {},
    [0, { a: [1, 2] }],
    { a: [], b: {}, c: ["é", 0] },
    "",
    "\u007f\u0085\u009b\u200d\u202e\u{e0001}\ud800",
    { "\u0085": ["\u200d", "\u{e0001}"] }
  ]
  for (const value of values) {
    expect(RunHistory.jsonBytes(value, { indent: 2, initialDepth: 0, maxDepth: 100, maxBytes: Infinity }))
      .toBe(Buffer.byteLength(terminalSafeJson(JSON.stringify(value, null, 2))))
  }
  const deep = JSON.parse("[".repeat(800) + "0" + "]".repeat(800))
  const result = await Effect.runPromise(RunHistory.field(Stream.make(event(1, { deep })), "/events/1/payload/deep"))
  expect(result).toEqual({ path: "/events/1/payload/deep", bytes: 1601, omitted: true, reason: "rendering-limit" })
  const wide = Array.from({ length: 200_000 }, () => 0)
  const inflated = await Effect.runPromise(RunHistory.field(Stream.make(event(1, { wide })), "/events/1/payload/wide"))
  expect(inflated).toMatchObject({ omitted: true, reason: "rendering-limit" })
  expect(RunHistory.jsonBytes([0], { indent: 2, initialDepth: 0, maxDepth: 100, maxBytes: 1 })).toBe(Infinity)
  expect(RunHistory.jsonBytes({}, { indent: 2, initialDepth: 0, maxDepth: 100, maxBytes: 1 })).toBe(Infinity)
})

it("bounds terminal-escaped field values, nested values and explicit string pages", async () => {
  const text = "\u0085".repeat(200_000)
  const stream = Stream.make(event(1, { text, nested: { text } }))
  for (const key of ["text", "nested"]) {
    expect(await Effect.runPromise(RunHistory.field(stream, `/events/1/payload/${key}`)))
      .toMatchObject({ omitted: true, reason: "rendering-limit" })
  }
  const page = await Effect.runPromise(RunHistory.field(
    stream,
    "/events/1/payload/text",
    undefined,
    { offset: 0, length: Number.MAX_SAFE_INTEGER }
  ))
  expect(Buffer.byteLength(terminalSafeJson(JSON.stringify(page, null, 2)))).toBeLessThan(1024 * 1024)
  expect(page.value).toBe(text.slice(0, page.page!.length))
  expect(page.page!.nextOffset).toBeLessThan(text.length)
})

it.each(["completed", "failed", "cancelled"])(
  "invalidates current nodes on control %s without a native terminal observation",
  async (status) => {
    const values = [
      event(1, { currentNode: "handoff" }),
      engine(2, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "node", action: "active" }),
      event(3, { cause: "terminal evidence" }, `control.run.${status}`),
      // A delayed native scheduling record must not resurrect a terminal run.
      engine(4, "flows.engine.node-scheduled", { kind: "ActionCall", nodeId: "late", action: "late.action" })
    ]
    const result = await Effect.runPromise(
      RunHistory.read(
        Stream.fromIterable(values),
        "large",
        { maxEvents: 1, maxBytes: 1000, maxEventBytes: 1000 },
        "execution"
      )
    )
    expect(result.history!.currentNode).toBeUndefined()
    expect(result.history).toMatchObject({ currentNodeUnavailable: true, lastRecordedNode: "handoff" })
  }
)
