// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect } from "@effect/vitest"
import { Action, DurableDeferred, DurableQueue, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Fiber, Layer, Logger, Metric, Option, Schedule, Schema, Tracer } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import { PersistedQueue } from "effect/persistence"
import { TestClock } from "effect/testing"
import { effectOnTestClock as effect, isComplete, pollUntil } from "./Harness.ts"
import { layerMemory, layerMemoryOver, makeInstance, makeMemoryState } from "./MemoryFlowRuntime.ts"

const PersistedQueueLayer = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreMemory)
)

describe("DurableQueue", () => {
  const Queue = DurableQueue.make({
    name: "DurableQueue/SuppliedKey",
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })
  const Offer = Action.make("DurableQueue/SuppliedKey/offer", {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String
  })
  const Flow_ = Flow.make("DurableQueue/SuppliedKey", {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id,
    body: (payload) => Offer.call(payload)
  })
  const successLayer = Layer.mergeAll(
    Offer.toLayer(({ id, value }) => DurableQueue.process(Queue, { id, value })),
    Interpreter.layer(Flow_),
    DurableQueue.worker(Queue, ({ value }) => Effect.succeed(value + 1))
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(layerMemory),
    Layer.provideMerge(PersistedQueueLayer)
  )

  effect("processes queued work through the supplied-key engine seam", () =>
    Effect.gen(function*() {
      const executionId = yield* Flow_.execute({ id: "success", value: 41 }, { discard: true })
      const result = yield* pollUntil(Flow_.poll(executionId), isComplete, { turns: 10, advance: "10 millis" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(42)
      }
    }).pipe(Effect.provide(successLayer)))

  effect("propagates queue worker failures", () => {
    const Offer = Action.make("DurableQueue/Failure/offer", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const Failure = Flow.make("DurableQueue/Failure", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Offer.call(payload)
    })
    const layer = Layer.mergeAll(
      Offer.toLayer(({ id }) => DurableQueue.process(Queue, { id, value: 0 }).pipe(Effect.asVoid)),
      Interpreter.layer(Failure),
      DurableQueue.worker(Queue, () => Effect.fail("boom"))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory),
      Layer.provideMerge(PersistedQueueLayer)
    )

    return Effect.gen(function*() {
      const executionId = yield* Failure.execute({ id: "failure" }, { discard: true })
      const result = yield* pollUntil(Failure.poll(executionId), isComplete, { turns: 10, advance: "10 millis" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("accepts an already-built payload schema as well as a field record", () => {
    // `make` adopts a schema as-is and wraps a field record; both forms must
    // round-trip an item through a worker identically.
    const payloadSchema = Schema.Struct({ id: Schema.String, value: Schema.Number })
    const SchemaQueue = DurableQueue.make({
      name: "DurableQueue/SchemaPayload",
      payload: payloadSchema,
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    expect(SchemaQueue.payloadSchema).toBe(payloadSchema)

    const Offer = Action.make("DurableQueue/SchemaPayload/offer", {
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String
    })
    const SchemaFlow = Flow.make("DurableQueue/SchemaPayload", {
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Offer.call(payload)
    })
    const layer = Layer.mergeAll(
      Offer.toLayer(({ id, value }) => DurableQueue.process(SchemaQueue, { id, value })),
      Interpreter.layer(SchemaFlow),
      DurableQueue.worker(SchemaQueue, ({ value }) => Effect.succeed(value * 2))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory),
      Layer.provideMerge(PersistedQueueLayer)
    )

    return Effect.gen(function*() {
      const executionId = yield* SchemaFlow.execute({ id: "schema", value: 21 }, { discard: true })
      const result = yield* pollUntil(SchemaFlow.poll(executionId), isComplete, { turns: 10, advance: "10 millis" })
      expect(
        Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit) &&
          result.value.exit.value
      ).toBe(42)
    }).pipe(Effect.provide(layer))
  })

  effect("refuses invalid concurrency inside the worker effect before opening the queue", () => {
    let opened = 0
    return Effect.gen(function*() {
      for (const concurrency of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        const worker = DurableQueue.makeWorker(Queue, () => Effect.succeed(0), { concurrency })
        const exit = yield* Effect.exit(worker)
        expect(Exit.isFailure(exit) && exit.cause.reasons).toEqual([
          expect.objectContaining({ _tag: "Die", defect: expect.any(RangeError) })
        ])
      }
      expect(opened).toBe(0)
    }).pipe(
      Effect.provide(layerMemory),
      Effect.provideService(PersistedQueue.PersistedQueueFactory, {
        make: () =>
          Effect.sync(() => {
            opened++
            throw new Error("must not open queue")
          })
      })
    )
  })

  effect("logs a malformed item token at error and continues the worker loop", () => {
    const WorkerQueue = DurableQueue.make({
      name: "DurableQueue/MalformedWorker",
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const itemSchema = Schema.Struct({
      token: DurableDeferred.Token,
      payload: WorkerQueue.payloadSchema,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean
    })
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: String(entry.message) })
    })
    let handled = 0

    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({
        name: `DurableQueue/${WorkerQueue.name}`,
        schema: itemSchema
      })
      yield* Effect.forkChild(
        DurableQueue.makeWorker(
          WorkerQueue,
          ({ value }) => Effect.sync(() => (handled++, value + 1))
        ),
        { startImmediately: true }
      )
      yield* queue.offer({
        token: ("\n\r\t\u001b\u0085" + "*".repeat(100)) as DurableDeferred.Token,
        payload: { id: "bad", value: 1 },
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
        sampled: false
      }, { id: "bad" })
      for (let turn = 0; turn < 50 && !logs.some((entry) => entry.level === "Error"); turn++) {
        yield* Effect.yieldNow
      }

      const completion = DurableDeferred.make(`${WorkerQueue.deferred.name}/valid`, {
        success: WorkerQueue.deferred.successSchema,
        error: WorkerQueue.deferred.errorSchema
      })
      const token = new DurableDeferred.TokenParsed({
        flowName: "DurableQueue/MalformedWorker/Host",
        executionId: "worker",
        deferredName: completion.name
      }).asToken
      yield* queue.offer({
        token,
        payload: { id: "valid", value: 41 },
        traceId: "1".repeat(32),
        spanId: "1".repeat(16),
        sampled: false
      }, { id: "valid" })
      for (let turn = 0; turn < 50 && handled === 0; turn++) yield* Effect.yieldNow

      expect(handled).toBe(1)
      const reported = logs.find((entry) => entry.level === "Error")
      expect(reported?.message).toContain(WorkerQueue.name)
      expect(reported?.message).toContain("64")
      expect(reported?.message).toContain("characters dropped")
      expect(reported?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provide(layerMemory),
      Effect.provide(PersistedQueueLayer)
    )
  })

  effect("refuses an item whose token names a deferred this queue does not own", () => {
    // Regression: the worker completed whatever deferred a stored token named,
    // so a forged item could settle a WaitFor gate, a human task, or another
    // queue's wait under this queue's success schema.
    const WorkerQueue = DurableQueue.make({
      name: "DurableQueue/ForeignToken",
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const itemSchema = Schema.Struct({
      token: DurableDeferred.Token,
      payload: WorkerQueue.payloadSchema,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean
    })
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: String(entry.message) })
    })
    const handled: Array<string> = []
    const tokenFor = (deferredName: string) =>
      new DurableDeferred.TokenParsed({
        flowName: "DurableQueue/ForeignToken/Host",
        executionId: "victim",
        deferredName
      }).asToken

    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({
        name: `DurableQueue/${WorkerQueue.name}`,
        schema: itemSchema
      })
      yield* Effect.forkChild(
        DurableQueue.makeWorker(
          WorkerQueue,
          ({ id, value }) => Effect.sync(() => (handled.push(id), value + 1))
        ),
        { startImmediately: true }
      )
      for (
        const [id, deferredName] of [
          ["gate", "approve-deploy"],
          ["sibling", `${WorkerQueue.deferred.name}/other`],
          ["prefix", `${WorkerQueue.deferred.name}/prefix/extra`],
          ["long", `approve-${"x".repeat(200)}`]
        ] as const
      ) {
        yield* queue.offer({
          token: tokenFor(deferredName),
          payload: { id, value: 1 },
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
          sampled: false
        }, { id })
      }
      yield* queue.offer({
        token: tokenFor(`${WorkerQueue.deferred.name}/valid`),
        payload: { id: "valid", value: 41 },
        traceId: "1".repeat(32),
        spanId: "1".repeat(16),
        sampled: false
      }, { id: "valid" })
      for (let turn = 0; turn < 100 && handled.length === 0; turn++) yield* Effect.yieldNow

      expect(handled).toEqual(["valid"])
      const refused = logs.filter((entry) => entry.level === "Error").map((entry) => entry.message)
      expect(refused).toHaveLength(4)
      expect(refused[0]).toContain("approve-deploy")
      expect(refused[1]).toContain(`${WorkerQueue.deferred.name}/other`)
      expect(refused[2]).toContain(`${WorkerQueue.deferred.name}/prefix/extra`)
      expect(refused[3]).toContain(`approve-${"x".repeat(120)} [80 characters dropped]`)
      expect(refused[3]).not.toContain("x".repeat(121))
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provide(layerMemory),
      Effect.provide(PersistedQueueLayer)
    )
  })

  effect("links the worker span only to a stored parent with trace-context ids", () => {
    const WorkerQueue = DurableQueue.make({
      name: "DurableQueue/TraceParent",
      payload: { id: Schema.String },
      success: Schema.Void,
      idempotencyKey: ({ id }) => id
    })
    const itemSchema = Schema.Struct({
      token: DurableDeferred.Token,
      payload: WorkerQueue.payloadSchema,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean
    })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const handled: Array<string> = []

    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({
        name: `DurableQueue/${WorkerQueue.name}`,
        schema: itemSchema
      })
      yield* Effect.forkChild(
        DurableQueue.makeWorker(WorkerQueue, ({ id }) => Effect.sync(() => void handled.push(id))),
        { startImmediately: true }
      )
      for (
        const [id, traceId, spanId] of [
          ["forged", "attacker-chosen-trace", "attacker-span"],
          ["zero-trace", "0".repeat(32), "b".repeat(16)],
          ["zero-span", "a".repeat(32), "0".repeat(16)],
          ["linked", "a".repeat(32), "b".repeat(16)]
        ] as const
      ) {
        yield* queue.offer({
          token: new DurableDeferred.TokenParsed({
            flowName: "DurableQueue/TraceParent/Host",
            executionId: id,
            deferredName: `${WorkerQueue.deferred.name}/${id}`
          }).asToken,
          payload: { id },
          traceId,
          spanId,
          sampled: true
        }, { id })
      }
      for (let turn = 0; turn < 100 && handled.length < 4; turn++) yield* Effect.yieldNow

      expect(handled).toEqual(["forged", "zero-trace", "zero-span", "linked"])
      const workerSpans = spans.filter((span) => span.name === `DurableQueue/${WorkerQueue.name}/worker`)
      expect(workerSpans).toHaveLength(4)
      const parents = workerSpans.map((span) => Option.getOrUndefined(span.parent))
      expect(parents[0]).toBeUndefined()
      expect(parents[1]).toBeUndefined()
      expect(parents[2]).toBeUndefined()
      expect(parents[3]?.traceId).toBe("a".repeat(32))
      expect(parents[3]?.spanId).toBe("b".repeat(16))
    }).pipe(
      Effect.provide(layerMemory),
      Effect.provide(PersistedQueueLayer),
      Effect.provideService(Tracer.Tracer, tracer)
    )
  })

  effect("a failed take terminates the worker without an in-memory retry", () => {
    let takes = 0
    const store = PersistedQueue.PersistedQueueStore.of({
      cleanup: () => Effect.void,
      offer: () => Effect.void,
      take: () =>
        Effect.suspend(() => {
          takes++
          return Effect.fail(new PersistedQueue.PersistedQueueError({ message: "take unavailable" }))
        })
    })
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        DurableQueue.makeWorker(Queue, () => Effect.succeed(0)).pipe(Effect.exit),
        { startImmediately: true }
      )
      for (let turn = 0; turn < 100 && fiber.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
      expect(fiber.pollUnsafe()).toBeDefined()
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(takes).toBe(1)
    }).pipe(
      Effect.provide(layerMemory),
      Effect.provide(PersistedQueue.layer.pipe(
        Layer.provide(Layer.succeed(PersistedQueue.PersistedQueueStore)(store))
      ))
    )
  })

  const itemSchema = Schema.Struct({
    token: DurableDeferred.Token,
    payload: Queue.payloadSchema,
    traceId: Schema.String,
    spanId: Schema.String,
    sampled: Schema.Boolean
  })

  const offerFailureLayer = (offer: PersistedQueue.PersistedQueueStore["Service"]["offer"]) =>
    PersistedQueue.layer.pipe(Layer.provide(
      Layer.succeed(PersistedQueue.PersistedQueueStore)({
        cleanup: () => Effect.void,
        offer,
        take: () => Effect.never
      })
    ))

  effect("exhausts a supplied offer retry schedule as a defect after three offers", () => {
    let offers = 0
    const error = new PersistedQueue.PersistedQueueError({ message: "offer unavailable" })
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(DurableQueue.process(Queue, { id: "retry", value: 0 }, {
        retrySchedule: Schedule.recurs(2)
      }))
      expect(offers).toBe(3)
      expect(exit).toEqual(Exit.die(error))
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Flow_, "retry")),
      Effect.provide(layerMemory),
      Effect.provide(offerFailureLayer(() =>
        Effect.suspend(() => {
          offers++
          return Effect.fail(error)
        })
      ))
    )
  })

  effect("the default offer schedule keeps retrying past three attempts", () => {
    let offers = 0
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(DurableQueue.process(Queue, { id: "default-retry", value: 0 }), {
        startImmediately: true
      })
      for (let turn = 0; turn < 50 && offers === 0; turn++) yield* Effect.yieldNow
      expect(offers).toBe(1)
      yield* TestClock.adjust(499)
      expect(offers).toBe(1)
      yield* TestClock.adjust(1)
      expect(offers).toBe(2)
      yield* TestClock.adjust(750)
      expect(offers).toBe(3)
      yield* TestClock.adjust(1125)
      expect(offers).toBe(4)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(fiber)
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Flow_, "default-retry")),
      Effect.provide(layerMemory),
      Effect.provide(offerFailureLayer(() =>
        Effect.suspend(() => {
          offers++
          return Effect.fail(new PersistedQueue.PersistedQueueError({ message: "offer unavailable" }))
        })
      ))
    )
  })

  effect("invalid payloads die with SchemaError before opening the queue", () => {
    let opened = 0
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(DurableQueue.process(Queue, { id: 1 } as never))
      expect(Exit.isFailure(exit) && exit.cause.reasons).toEqual([
        expect.objectContaining({ _tag: "Die", defect: expect.objectContaining({ _tag: "SchemaError" }) })
      ])
      expect(opened).toBe(0)
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Flow_, "invalid")),
      Effect.provide(layerMemory),
      Effect.provideService(PersistedQueue.PersistedQueueFactory, {
        make: () =>
          Effect.sync(() => {
            opened++
            throw new Error("must not open queue")
          })
      })
    )
  })

  effect("an offer SchemaError dies immediately without retrying", () => {
    let offers = 0
    const logs: Array<string> = []
    const capture = Logger.make((entry) => logs.push(Logger.formatJson.log(entry)))
    return Effect.gen(function*() {
      const schemaExit = yield* Effect.exit(
        Schema.decodeUnknownEffect(Schema.Number)("rejected-private-payload", { reportInput: true })
      )
      if (!Exit.isFailure(schemaExit)) throw new Error("expected invalid number")
      const reason = schemaExit.cause.reasons.find(Cause.isFailReason)!
      const exit = yield* Effect.exit(
        DurableQueue.process(Queue, { id: "offer-schema", value: 0 }, {
          retrySchedule: Schedule.recurs(2)
        }).pipe(Effect.provideService(PersistedQueue.PersistedQueueFactory, {
          make: () =>
            Effect.succeed({
              [PersistedQueue.TypeId]: PersistedQueue.TypeId,
              offer: () =>
                Effect.suspend(() => {
                  offers++
                  return Effect.fail(reason.error)
                }),
              take: () => Effect.never
            })
        }))
      )
      expect(offers).toBe(1)
      expect(exit).toEqual(Exit.die(reason.error))
      expect(logs.length).toBeGreaterThan(0)
      expect(logs.join("\n")).not.toContain("rejected-private-payload")
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Flow_, "offer-schema")),
      Effect.provide(Logger.layer([capture])),
      Effect.provide(layerMemory)
    )
  })

  effect("offers have per-run, per-occurrence identity and replay keeps the token", () => {
    const offered: Array<{ id: string; token: string }> = []
    const waits: Array<FlowRuntime.FlowInstance["Service"]["waiting"]> = []
    return Effect.gen(function*() {
      const tokens: Array<string> = []
      const offer = (instance: FlowRuntime.FlowInstance["Service"]) =>
        Effect.gen(function*() {
          const result = yield* DurableQueue.process(Queue, { id: "same", value: 0 }).pipe(Flow.intoResult)
          expect(result._tag).toBe("Suspended")
          const token = offered[offered.length - 1]!.token
          waits.push(instance.waiting)
          tokens.push(token)
        }).pipe(Effect.provideService(FlowRuntime.FlowInstance, instance))
      const instance = makeInstance(Flow_, "identity")
      yield* offer(instance)
      yield* offer(instance)
      yield* offer(makeInstance(Flow_, "other-run"))
      yield* offer(makeInstance(Flow_, "identity"))
      expect(new Set(tokens.slice(0, 3)).size).toBe(3)
      expect(tokens[3]).toBe(tokens[0])
      expect(new Set(offered.slice(0, 3).map((item) => item.id)).size).toBe(3)
      expect(offered[3]!.id).toBe(offered[0]!.id)
      expect(waits).toEqual(tokens.map((token) => ({ reason: "event", token })))
    }).pipe(
      Effect.provide(layerMemory),
      Effect.provide(offerFailureLayer((options) =>
        Effect.sync(() => {
          const item = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(options.element)
          offered.push({ id: options.id, token: item.token })
        })
      ))
    )
  })

  // This in-memory runtime runs no retry policies, so the item's execution ends at the failed completion; the
  // engine's retries, and the caller's result, are proved on a durable engine in @smthrs/engine-store
  // (`test/DurableQueueCrash.test.ts`). That a redelivery replays the recorded handler exit is the next case.
  effect("a completion the store fails to record is logged without the item's private data", () => {
    let handled = 0
    let writes = 0
    const logs: Array<string> = []
    const spans: Array<Tracer.NativeSpan> = []
    const capture = Logger.make((entry) => logs.push(Logger.formatJson.log(entry)))
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const runtime = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
      const base = yield* FlowRuntime.FlowRuntime
      return FlowRuntime.FlowRuntime.of({
        ...base,
        deferredDone: (deferred, options) =>
          Effect.suspend(() => {
            if (options.deferredName.startsWith(Queue.deferred.name)) {
              writes++
              return Effect.die({ privateCause: "private-handler-cause", result: options.exit })
            }
            return base.deferredDone(deferred, options)
          })
      })
    })).pipe(Layer.provide(layerMemory))
    const layer = Layer.mergeAll(
      Offer.toLayer((payload) => DurableQueue.process(Queue, payload)),
      Interpreter.layer(Flow_),
      DurableQueue.worker(Queue, ({ id, value }) =>
        Effect.suspend(() => {
          expect({ id, value }).toEqual({ id: "private-payload", value: 41 })
          handled++
          return Effect.fail("private-handler-failure")
        }))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(runtime),
      Layer.provideMerge(PersistedQueueLayer)
    )
    return Effect.gen(function*() {
      const id = yield* Flow_.execute({ id: "private-payload", value: 41 }, { discard: true })
      for (let turn = 0; turn < 500 && writes === 0; turn++) yield* Effect.yieldNow
      expect(writes).toBe(1)
      expect(handled).toBe(1)
      expect(Option.isSome(yield* Flow_.poll(id))).toBe(true)
      expect(logs.some((line) => line.includes("completion is retried"))).toBe(true)
      const telemetry = JSON.stringify({
        logs,
        spans: spans.map((span) => ({
          name: span.name,
          attributes: [...span.attributes],
          events: span.events,
          status: span.status
        })),
        metrics: yield* Metric.snapshot
      }, (_, value) => typeof value === "bigint" ? String(value) : value)
      for (const secret of ["private-payload", "private-handler-cause", "private-handler-failure"]) {
        expect(telemetry).not.toContain(secret)
      }
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  })

  // A handler result the store recorded is never produced twice. The first process records the handle step, then is
  // gone before the completion is recorded. The second process, over the same durable record and the same persisted
  // queue, is delivered the item again: the item's execution runs a second time, replays the recorded handler exit,
  // and completes the caller with it.
  effect("a delivery after a restart replays the recorded handler exit instead of running the handler again", () => {
    const itemFlow = `DurableQueue/${Queue.name}/item`
    const payload = { id: "restarted", value: 0 }
    const durable = makeMemoryState()
    let handled = 0
    let executions = 0
    let completions = 0
    const process = (stopsBeforeCompletion: boolean) => {
      const runtime = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
        const base = yield* FlowRuntime.FlowRuntime
        return FlowRuntime.FlowRuntime.of({
          ...base,
          execute: ((flow, options) =>
            Effect.suspend(() => {
              if (flow._tag === itemFlow) executions++
              return base.execute(flow, options)
            })) as typeof base.execute,
          // The first process stops while it records the completion, with the handler's exit already recorded.
          deferredDone: (deferred, options) =>
            Effect.suspend(() => {
              if (!options.deferredName.startsWith(Queue.deferred.name)) return base.deferredDone(deferred, options)
              completions++
              return stopsBeforeCompletion ? Effect.never : base.deferredDone(deferred, options)
            })
        })
      })).pipe(Layer.provide(layerMemoryOver(durable)))
      return Layer.mergeAll(
        Offer.toLayer((payload) => DurableQueue.process(Queue, payload)),
        Interpreter.layer(Flow_),
        DurableQueue.worker(Queue, () => Effect.suspend(() => (handled++, Effect.fail("handled once"))))
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(runtime)
      )
    }
    return Effect.gen(function*() {
      yield* Effect.gen(function*() {
        yield* Flow_.execute(payload, { discard: true })
        for (let turn = 0; turn < 500 && completions === 0; turn++) yield* Effect.yieldNow
      }).pipe(Effect.provide(process(true)))
      expect({ handled, executions, completions }).toEqual({ handled: 1, executions: 1, completions: 1 })

      const exit = yield* Effect.gen(function*() {
        for (let turn = 0; turn < 500 && completions < 2; turn++) {
          yield* Effect.yieldNow
          yield* TestClock.adjust("1 second")
        }
        return yield* Effect.exit(Flow_.execute(payload))
      }).pipe(Effect.provide(process(false)))
      expect({ handled, executions, completions }).toEqual({ handled: 1, executions: 2, completions: 2 })
      expect(Exit.isFailure(exit) && exit.cause.reasons.map((reason) => Cause.isFailReason(reason) && reason.error))
        .toEqual(["handled once"])
    }).pipe(Effect.provide(PersistedQueueLayer))
  })

  const itemFor = (id: string) => ({
    token: new DurableDeferred.TokenParsed({
      flowName: Flow_._tag,
      executionId: id,
      deferredName: `${Queue.deferred.name}/${id}`
    }).asToken,
    payload: { id, value: 0 },
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    sampled: false
  })

  effect("an item whose execution fails is delivered again and the worker keeps taking items", () => {
    let executions = 0
    const runtime = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
      const base = yield* FlowRuntime.FlowRuntime
      return FlowRuntime.FlowRuntime.of({
        ...base,
        execute: ((flow, options) =>
          ++executions === 1
            ? Effect.fail(new FlowRuntime.StoreUnavailable({ executionId: options.executionId }))
            : base.execute(flow, options)) as typeof base.execute
      })
    })).pipe(Layer.provide(layerMemory))
    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({ name: `DurableQueue/${Queue.name}`, schema: itemSchema })
      const handled: Array<string> = []
      const worker = yield* Effect.forkChild(
        DurableQueue.makeWorker(Queue, ({ id }) => Effect.sync(() => (handled.push(id), 1))),
        { startImmediately: true }
      )
      yield* queue.offer(itemFor("outage"), { id: "outage" })
      for (let turn = 0; turn < 500 && executions === 0; turn++) yield* Effect.yieldNow
      expect(executions).toBe(1)
      expect(handled).toEqual([])
      yield* queue.offer(itemFor("next"), { id: "next" })
      for (let turn = 0; turn < 500 && handled.length < 2; turn++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
      }
      expect([...handled].sort()).toEqual(["next", "outage"])
      expect(worker.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(worker)
    }).pipe(Effect.provide(runtime), Effect.provide(PersistedQueueLayer))
  })

  for (const mixed of [false, true]) {
    effect(
      mixed
        ? "workers strip interrupts from mixed handler failures"
        : "interrupt-only handler exits requeue without an attempt and the worker keeps taking items",
      () => {
        const recorded: Array<Exit.Exit<unknown, unknown>> = []
        const executed: Array<string> = []
        const runtime = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
          const base = yield* FlowRuntime.FlowRuntime
          return FlowRuntime.FlowRuntime.of({
            ...base,
            execute: ((flow, options) => {
              executed.push(options.executionId)
              return base.execute(flow, options)
            }) as typeof base.execute,
            deferredDone: (deferred, options) => {
              recorded.push(options.exit)
              return base.deferredDone(deferred, options)
            }
          })
        })).pipe(Layer.provide(layerMemory))
        return Effect.gen(function*() {
          const queue = yield* PersistedQueue.make({ name: `DurableQueue/${Queue.name}`, schema: itemSchema })
          yield* queue.offer(itemFor("interrupt"), { id: "interrupt" })
          const handled: Array<string> = []
          const worker = yield* Effect.forkChild(
            DurableQueue.makeWorker(Queue, ({ id }) =>
              Effect.gen(function*() {
                handled.push(id)
                if (id !== "interrupt") return 1
                if (mixed) {
                  return yield* Effect.failCause(Cause.fromReasons([
                    ...Cause.fail("boom").reasons,
                    ...Cause.interrupt(7).reasons
                  ]))
                }
                const child = yield* Effect.forkChild(Effect.never)
                yield* Fiber.interrupt(child)
                return yield* Fiber.join(child)
              })),
            { startImmediately: true }
          )
          for (let turn = 0; turn < 500 && (handled.length === 0 || (mixed && recorded.length === 0)); turn++) {
            yield* Effect.yieldNow
          }
          expect(handled[0]).toBe("interrupt")
          if (mixed) {
            yield* Fiber.interrupt(worker)
            expect(recorded).toHaveLength(1)
            const exit = recorded[0]!
            if (!Exit.isFailure(exit)) throw new Error("expected handler failure")
            expect(exit.cause.reasons).toEqual([expect.objectContaining({ _tag: "Fail", error: "boom" })])
          } else {
            // The same worker takes the interrupted item again on redelivery, and takes the next item.
            const interruptExecution = `${Queue.deferred.name}/interrupt`
            yield* queue.offer(itemFor("later"), { id: "later" })
            for (
              let turn = 0;
              turn < 500 && (recorded.length === 0 || executed.filter((id) => id === interruptExecution).length < 2);
              turn++
            ) {
              yield* Effect.yieldNow
            }
            expect(executed.filter((id) => id === interruptExecution).length).toBeGreaterThanOrEqual(2)
            expect(handled).toContain("later")
            expect(recorded).toEqual([Exit.succeed(1)])
            expect(worker.pollUnsafe()).toBeUndefined()
            yield* Fiber.interrupt(worker)
            const take = yield* Effect.forkChild(queue.take((item, metadata) => Effect.succeed({ item, metadata })), {
              startImmediately: true
            })
            for (let turn = 0; turn < 50 && take.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
            expect(take.pollUnsafe()).toEqual(Exit.succeed({
              item: expect.objectContaining({ token: itemFor("interrupt").token }),
              metadata: { id: "interrupt", attempts: 1 }
            }))
            yield* Fiber.interrupt(take)
          }
        }).pipe(Effect.provide(runtime), Effect.provide(PersistedQueueLayer))
      }
    )
  }
})
