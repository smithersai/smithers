import { FlowRegistry } from "../../flows/registry"
import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { ModelStep } from "@smthrs/agent"
import { Action, RetryPolicy } from "@smthrs/flow"
import { Model, ModelError, type ModelEvent } from "@smthrs/model"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Metric, Scope, Semaphore, Stream } from "effect"
import { expect, test, vi } from "vitest"
import { build } from "../../../worker/test/flowHost"
import { ClientEngine, FlowDispatch } from "../../flows/dispatch"
import { Message } from "../chat/schema"
import { deviceRegistry } from "../../device/registry"
import { deviceFrom, type Fixture, persistenceOn, prepare } from "../../test/deviceFixture"
import { Summarize } from "./flow"
import { registration, SummarySeat } from "./steps"
import { followSummaries, makeLane, makeSummaries, revisionOf, summaryQuery, summaryRemovals, summaryStops } from "./store"

const row = (id: string, text: string): Message => ({
  id, text, role: "user", status: "done", questionId: null, failure: null, modelId: null, stopReason: null,
  inputTokens: null, outputTokens: null, position: 1, createdAt: "2026-10-20 18:00:00+00", updatedAt: "2026-10-20 18:00:00+00",
})

test("real durable summary results project once, refresh changed content and skip streaming or empty entries", async () => {
  const scope = Effect.runSync(Scope.make())
  let calls = 0
  const model = Model.make({ stream: () => {
    calls++
    return Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "s", text: "Inspect both retry attempts" }, { type: "settle", stopReason: "stop" }])
  } })
  try {
    const { context: engine } = await Effect.runPromise(Scope.provide(scope)(build(registration.pipe(
      Layer.provide(SummarySeat.layer("https://summary.test", model)), Layer.provideMerge(Action.layerImplementations),
    ))))
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Layer.mergeAll(
      Persistence.memory,
      FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer)).pipe(Layer.provide(ClientEngine.layerRuntime([Summarize])), Layer.provide(Layer.succeedContext(engine))),
    ))))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: "test-timeline-messages", schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const query = await run(summaryQuery(summaries))
    expect(query.tanstack).toBeDefined()
    await run(Effect.forkIn(followSummaries(messages, messages, summaries, Context.get(context, FlowDispatch), await run(makeLane)), scope, { startImmediately: true }))
    await run(messages.insert(row("a", "Inspect retries")))
    await vi.waitFor(async () => expect((await run(summaries.get("a")))._tag).toBe("Some"), { timeout: 15_000 })
    expect(calls).toBe(1)
    await run(messages.update("a", draft => { draft.updatedAt = "2026-10-20 18:00:01+00" }))
    await run(messages.insert({ ...row("stream", "partial"), status: "streaming" }))
    await run(messages.insert(row("empty", " ")))
    await run(messages.update("a", draft => { draft.text = "Inspect failures" }))
    await vi.waitFor(async () => {
      const value = await run(summaries.get("a"))
      expect(value._tag === "Some" && value.value.revision).toBe(revisionOf(row("a", "Inspect failures")))
    }, { timeout: 15_000 })
    expect(calls).toBe(2)
    expect((await run(summaries.get("stream")))._tag).toBe("None")
    expect((await run(summaries.get("empty")))._tag).toBe("None")
    await run(messages.delete("a"))
    await vi.waitFor(async () => expect((await run(summaries.get("a")))._tag).toBe("None"))
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test.each(["failed", "unavailable", "changed", "deleted"] as const)("does not publish a %s summary result", async scenario => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: `fault-${scenario}`, schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    let processed = false
    const dispatch = {
      dispatch: () => Effect.gen(function* () {
        if (processed) return { _tag: "Failed", error: { _tag: "timeline/SummaryFailed", code: "invalid" } }
        if (scenario === "changed") yield* messages.update("a", draft => { draft.text = "Changed while summarizing" })
        if (scenario === "deleted") yield* messages.delete("a")
        processed = true
        if (scenario === "unavailable") return yield* Effect.fail(new Error("provider is unavailable"))
        if (scenario === "failed") return { _tag: "Failed", error: { _tag: "timeline/SummaryFailed", code: "invalid" } }
        return { _tag: "Done", value: { summary: "Inspect both retry attempts" } }
      }),
    } as unknown as FlowDispatch["Service"]
    await run(Effect.forkIn(followSummaries(messages, messages, summaries, dispatch, await run(makeLane)), scope, { startImmediately: true }))
    await run(messages.insert(row("a", "Inspect retries")))
    await vi.waitFor(() => expect(processed).toBe(true))
    expect((await run(summaries.get("a")))._tag).toBe("None")
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("an idle page whose summary model refuses for credit makes at most two model calls", async () => {
  // smithers.sh, 2026-10-25: one idle chat page made 63 summary calls in 3 minutes, every one refused 402, because
  // each entry's step asked six times and the lane went on to the next entry.
  const scope = Effect.runSync(Scope.make())
  let calls = 0
  const model = Model.make({ stream: () => {
    calls++
    return Stream.fail(new ModelError.ModelError({ code: "quota_exceeded", httpStatus: 402, message: "payment required" }))
  } })
  // Production's attempts, with test timings: every one of the six still runs on the real durable engine.
  const seat = Layer.effect(SummarySeat, Effect.map(SummarySeat, service => ({
    ...service, retryPolicy: RetryPolicy.make({ ...ModelStep.defaultRetryPolicy, initialMs: 1, maxMs: 1 }),
  }))).pipe(Layer.provide(SummarySeat.layer("https://summary.test", model)))
  try {
    const registry: Metric.MetricRegistry = new Map()
    const { context: engine } = await Effect.runPromise(Scope.provide(scope)(build(registration.pipe(
      Layer.provide(seat), Layer.provideMerge(Action.layerImplementations),
    ))))
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Layer.mergeAll(
      Persistence.memory,
      FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer)).pipe(Layer.provide(ClientEngine.layerRuntime([Summarize])), Layer.provide(Layer.succeedContext(engine))),
    ))))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context).pipe(Effect.provideService(Metric.MetricRegistry, registry))) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: "refusing-model", schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const ids = Array.from({ length: 10 }, (_, n) => `m${n}`)
    await run(messages.insert(ids.map(id => row(id, `Inspect ${id}`))))
    await run(Effect.forkIn(followSummaries(messages, messages, summaries, Context.get(context, FlowDispatch), await run(makeLane)), scope, { startImmediately: true }))
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1))
    // Long enough for every entry's six attempts at these timings, had the lane gone on.
    await run(Effect.sleep("500 millis"))
    expect(calls).toBeLessThanOrEqual(2)
    expect((await run(Metric.value(summaryStops))).count).toBe(1)
    for (const id of ids) expect((await run(summaries.get(id)))._tag).toBe("None")
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test.each(["unconfigured", "unavailable"] as const)("stops once a summary fails %s: no later entry is dispatched", async code => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: `stopped-${code}`, schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const dispatched: Array<string> = []
    const dispatch = {
      dispatch: (_name: string, payload: { readonly id: string }) => Effect.sync(() => {
        dispatched.push(payload.id)
        return { _tag: "Failed", error: { _tag: "timeline/SummaryFailed", code } }
      }),
    } as unknown as FlowDispatch["Service"]
    await run(messages.insert([row("a", "Inspect retries"), row("b", "Inspect failures")]))
    const followed = await run(Effect.forkIn(followSummaries(messages, messages, summaries, dispatch, await run(makeLane)), scope, { startImmediately: true }))
    await run(Fiber.join(followed))
    await run(summaries.insert({ id: "a", revision: revisionOf(row("a", "Inspect retries")), summary: "Inspect both retry attempts" }))
    await run(messages.delete("a"))
    await vi.waitFor(async () => expect((await run(summaries.get("a")))._tag).toBe("None"))
    await run(messages.insert(row("c", "Inspect deploys")))
    expect(dispatched).toEqual(["a"])
    expect((await run(summaries.get("a")))._tag).toBe("None")
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("a lane records its stop once, whichever summary stops it first", async () => {
  const registry: Metric.MetricRegistry = new Map()
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  const lane = await run(makeLane)
  await run(lane.stop("unavailable"))
  await run(lane.stop("unconfigured"))
  expect(await run(Deferred.isDone(lane.stopped))).toBe(true)
  expect((await run(Metric.value(summaryStops))).count).toBe(1)
})

test.each(["invalid", "refused"] as const)("a summary that fails %s belongs to its entry, so later entries still run", async code => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: `continues-${code}`, schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const dispatched: Array<string> = []
    const dispatch = {
      dispatch: (_name: string, payload: { readonly id: string }) => Effect.sync(() => {
        dispatched.push(payload.id)
        return { _tag: "Failed", error: { _tag: "timeline/SummaryFailed", code } }
      }),
    } as unknown as FlowDispatch["Service"]
    await run(messages.insert(["a", "b", "c"].map(id => row(id, `Inspect ${id}`))))
    // One turn, so each entry runs after the one before it failed.
    const lane = { ...(await run(makeLane)), permits: Semaphore.makeUnsafe(1) }
    await run(Effect.forkIn(followSummaries(shownWindow(["a", "b", "c"]), messages, summaries, dispatch, lane), scope, { startImmediately: true }))
    await vi.waitFor(() => expect(dispatched).toEqual(["a", "b", "c"]))
    expect(await run(Deferred.isDone(lane.stopped))).toBe(false)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("summarizes the window's asks and answers, never a view the window shows among them", async () => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: "with-view", schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const dispatched: Array<string> = []
    const dispatch = {
      dispatch: (_name: string, payload: { readonly id: string }) => Effect.sync(() => {
        dispatched.push(payload.id)
        return { _tag: "Failed", error: { _tag: "timeline/SummaryFailed", code: "invalid" } }
      }),
    } as unknown as FlowDispatch["Service"]
    const shown = (id: string, role: string) => ({ type: "insert" as const, key: id, value: { id, role, status: "done", text: "A page" }, previousValue: undefined })
    await run(messages.insert([row("ask", "A page"), { ...row("answer", "A page"), role: "assistant" }]))
    await run(followSummaries({ changes: () => Stream.make([shown("view", "view"), shown("ask", "user"), shown("answer", "assistant")]) }, messages, summaries, dispatch, await run(makeLane)))
    expect(dispatched).toEqual(["ask", "answer"])
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

// Faulty dispatch services exercise isolation without replacing collection persistence.
test.each(["stall", "defect"] as const)("a dispatch %s cannot block later summaries", async fault => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: `isolation-${fault}`, schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const entered = Effect.runSync(Deferred.make<void>())
    const dispatch = {
      dispatch: (_name: string, payload: { readonly id: string }) => payload.id === "a"
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(fault === "stall" ? Effect.never : Effect.die("private defect")))
        : Effect.succeed({ _tag: "Done", value: { summary: "Inspect both retry attempts" } }),
    } as unknown as FlowDispatch["Service"]
    await run(Effect.forkIn(followSummaries(messages, messages, summaries, dispatch, await run(makeLane)), scope, { startImmediately: true }))
    await run(messages.insert(row("a", "Inspect retries")))
    await run(Deferred.await(entered))
    await run(messages.insert(row("b", "Inspect failures")))
    await vi.waitFor(async () => expect((await run(summaries.get("b")))._tag).toBe("Some"))
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("deleting a message outside the shown window removes its persisted summary", async () => {
  const { path } = await deviceFrom({ build: "empty", collections: {}, outbox: {} } as Fixture)
  await prepare(path, deviceRegistry)
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(persistenceOn(path, deviceRegistry))))
    const registry: Metric.MetricRegistry = new Map()
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context).pipe(Effect.provideService(Metric.MetricRegistry, registry))) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: "delete-messages", schema: Message, getKey: message => message.id }))
    const window = await run(Collection.local<Message, Collection.Key>({ id: "delete-window", schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    await run(messages.insert(row("a", "Inspect retries")))
    await run(Effect.flatMap(summaries.insert({ id: "a", revision: revisionOf(row("a", "Inspect retries")), summary: "Inspect both retry attempts" }), transaction => transaction.persisted))
    const dispatch = { dispatch: () => Effect.die("No shown entries should dispatch") } as unknown as FlowDispatch["Service"]
    await run(Effect.forkIn(followSummaries(window, messages, summaries, dispatch, await run(makeLane)), scope, { startImmediately: true }))
    await run(window.insert(row("a", "Inspect retries")))
    await run(window.delete("a"))
    expect((await run(summaries.get("a")))._tag).toBe("Some")
    await run(messages.delete("a"))
    await vi.waitFor(async () => expect((await run(summaries.get("a")))._tag).toBe("None"))
    await vi.waitFor(async () => expect((await run(Metric.value(summaryRemovals))).count).toBe(1))
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
  const restored = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const summaries = yield* makeSummaries
    yield* summaries.restored
    return yield* summaries.get("a")
  })).pipe(Effect.provide(persistenceOn(path, deviceRegistry))))
  expect(restored._tag).toBe("None")
})

/** A window that shows `ids` as settled asks, each twice when `twice` (an update that kept its content). */
const shownWindow = (ids: ReadonlyArray<string>, twice = false) => ({
  changes: () => Stream.concat(Stream.make(ids.flatMap(id => {
    const change = { type: "insert" as const, key: id, value: { id, role: "user", status: "done", text: `Inspect ${id}` }, previousValue: undefined }
    return twice ? [change, { ...change, type: "update" as const }] : [change]
  })), Stream.never),
})

test("a long window runs at most two summaries at once, each entry once", async () => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: "long-window", schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const ids = Array.from({ length: 40 }, (_, n) => `m${n}`)
    await run(messages.insert(ids.map(id => row(id, `Inspect ${id}`))))
    let running = 0
    let most = 0
    const dispatched: Array<string> = []
    const dispatch = {
      dispatch: (_name: string, payload: { readonly id: string }) => Effect.gen(function* () {
        dispatched.push(payload.id)
        most = Math.max(most, ++running)
        yield* Effect.sleep("2 millis")
        running--
        return { _tag: "Done", value: { summary: "Inspect both retry attempts" } }
      }),
    } as unknown as FlowDispatch["Service"]
    const lane = await run(makeLane)
    await run(Effect.forkIn(followSummaries(shownWindow(ids, true), messages, summaries, dispatch, lane), scope, { startImmediately: true }))
    await vi.waitFor(async () => expect((await run(summaries.get("m39")))._tag).toBe("Some"))
    await vi.waitFor(() => expect(dispatched.length).toBe(40))
    expect(new Set(dispatched).size).toBe(40)
    expect(most).toBeLessThanOrEqual(2)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("a summary role with no model costs at most two requests for both conversations a page follows", async () => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: "no-model", schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const dispatched: Array<string> = []
    const dispatch = {
      dispatch: (_name: string, payload: { readonly id: string }) => Effect.gen(function* () {
        dispatched.push(payload.id)
        yield* Effect.sleep("2 millis")
        return { _tag: "Failed", error: { _tag: "timeline/SummaryFailed", code: "unconfigured" } }
      }),
    } as unknown as FlowDispatch["Service"]
    const lane = await run(makeLane)
    const home = Array.from({ length: 50 }, (_, n) => `home${n}`)
    const branch = Array.from({ length: 50 }, (_, n) => `branch${n}`)
    await run(messages.insert([...home, ...branch].map(id => row(id, `Inspect ${id}`))))
    await run(Effect.all([
      followSummaries(shownWindow(home), messages, summaries, dispatch, lane),
      followSummaries(shownWindow(branch), messages, summaries, dispatch, lane),
    ], { concurrency: "unbounded" }))
    await run(Effect.sleep("50 millis"))
    expect(dispatched.length).toBeGreaterThanOrEqual(1)
    expect(dispatched.length).toBeLessThanOrEqual(2)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("an entry that changes or leaves while it waits for its turn is never sent", async () => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: "waiting", schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    const ids = ["a", "b", "c", "d"]
    await run(messages.insert(ids.map(id => row(id, `Inspect ${id}`))))
    const release = Effect.runSync(Deferred.make<void>())
    const dispatched: Array<string> = []
    const dispatch = {
      dispatch: (_name: string, payload: { readonly id: string }) => Effect.gen(function* () {
        dispatched.push(payload.id)
        yield* Deferred.await(release)
        return { _tag: "Done", value: { summary: "Inspect both retry attempts" } }
      }),
    } as unknown as FlowDispatch["Service"]
    await run(Effect.forkIn(followSummaries(shownWindow(ids), messages, summaries, dispatch, await run(makeLane)), scope, { startImmediately: true }))
    await vi.waitFor(() => expect(dispatched).toEqual(["a", "b"]))
    await run(messages.delete("c"))
    await run(messages.update("d", draft => { draft.text = "Inspect deploys" }))
    await run(Deferred.succeed(release, undefined))
    await vi.waitFor(async () => expect((await run(summaries.get("b")))._tag).toBe("Some"))
    await run(Effect.sleep("20 millis"))
    expect(dispatched).toEqual(["a", "b"])
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})

test("an entry waiting for its turn when the role answers it has no model is never sent", async () => {
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context)) as Effect.Effect<A, E>)
    const messages = await run(Collection.local<Message, Collection.Key>({ id: "waiting-stop", schema: Message, getKey: message => message.id }))
    const summaries = await run(makeSummaries)
    await run(messages.insert(["a", "b"].map(id => row(id, `Inspect ${id}`))))
    const dispatched: Array<string> = []
    const dispatch = {
      dispatch: (_name: string, payload: { readonly id: string }) => Effect.sync(() => {
        dispatched.push(payload.id)
        return { _tag: "Failed", error: { _tag: "timeline/SummaryFailed", code: "unconfigured" } }
      }),
    } as unknown as FlowDispatch["Service"]
    // One turn: "b" waits while "a" holds it, and takes it the moment "a" answers that there is no model.
    const lane = { ...(await run(makeLane)), permits: Semaphore.makeUnsafe(1) }
    await run(followSummaries(shownWindow(["a", "b"]), messages, summaries, dispatch, lane))
    expect(dispatched).toEqual(["a"])
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})
