import { FlowRegistry } from "../../flows/registry"
import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { ModelStep } from "@smthrs/agent"
import { Action, RetryPolicy } from "@smthrs/flow"
import { Model, ModelError, type ModelEvent } from "@smthrs/model"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Metric, Scope, Semaphore, Stream } from "effect"
import { expect, test, vi } from "vitest"
import { build } from "../../../worker/test/flowHost"
import { ClientEngine, DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { Message } from "../chat/schema"
import { Summarize } from "./flow"
import { registration, SummaryLedger, SummarySeat } from "./steps"
import { followSummaries, makeLane, revisionOf, STOPPING_FAILURES, summaryStops } from "./store"

const LONG = "The release retried twice; both recorded attempts kept the missing projection entry."
/** A finished answer, long enough that its label can't say what it found. */
const answer = (id: string, text = `${LONG} ${id}`): Message => ({
  id, text, role: "assistant", status: "done", questionId: `q-${id}`, failure: null, modelId: null, stopReason: null,
  inputTokens: null, outputTokens: null, position: 2, createdAt: "2026-10-20 18:00:00+00", updatedAt: "2026-10-20 18:00:00+00",
})
/** The question `answer(id)` replies to. */
const question = (id: string, text: string): Message => ({ ...answer(id, text), id: `q-${id}`, role: "user", questionId: null, position: 1 })

/** The server's claims, as worker/TimelineSummaries.ts keeps them, shared by every tab and device that uses it. */
const memoryLedger = () => {
  const claimed = new Set<string>()
  const recorded: Array<{ readonly messageId: string; readonly revision: string; readonly summary: string }> = []
  const claims: Array<{ readonly messageId: string; readonly reason: string }> = []
  return {
    claims, recorded,
    layer: Layer.succeed(SummaryLedger, SummaryLedger.of({
      claim: ({ messageId, revision, reason }) => Effect.sync(() => {
        claims.push({ messageId, reason })
        const key = `${messageId}:${revision}`
        return !claimed.has(key) && !!claimed.add(key)
      }),
      record: record => Effect.sync(() => { recorded.push(record) }),
    })),
  }
}
const scoped = async <A>(use: (scope: Scope.Closeable) => Promise<A>) => {
  const scope = Effect.runSync(Scope.make())
  try { return await use(scope) } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
}
/** A device: its own durable engine and store over `ledger`, the server's claims, and `model`. */
const device = async (scope: Scope.Closeable, ledger: Layer.Layer<SummaryLedger>, model: Model.Model, seat?: (layer: ReturnType<typeof SummarySeat.layer>) => ReturnType<typeof SummarySeat.layer>) => {
  const seated = SummarySeat.layer("https://summary.test", model)
  const { context: engine } = await Effect.runPromise(Scope.provide(scope)(build(registration.pipe(
    Layer.provide(Layer.merge(seat === undefined ? seated : seat(seated), ledger)), Layer.provideMerge(Action.layerImplementations),
  ))))
  const registry: Metric.MetricRegistry = new Map()
  const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Layer.mergeAll(
    Persistence.memory,
    FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer)).pipe(Layer.provide(ClientEngine.layerRuntime([Summarize])), Layer.provide(Layer.succeedContext(engine))),
  ))))
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context).pipe(Effect.provideService(Metric.MetricRegistry, registry))) as Effect.Effect<A, E>)
  return { run, dispatch: Context.get(context, FlowDispatch), registry }
}
const summarizing = () => {
  let calls = 0
  const model = Model.make({ stream: () => {
    calls++
    return Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "s", text: "Release retry check completed" }, { type: "settle", stopReason: "stop" }])
  } })
  return { model, calls: () => calls }
}
/** The recorded summaries arriving with their messages, as Electric syncs them to every device. */
const sync = (run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>, messages: Collection.Collection<Message>, recorded: ReadonlyArray<{ readonly messageId: string; readonly revision: string; readonly summary: string }>) =>
  Promise.all(recorded.map(({ messageId, revision, summary }) => run(messages.update(messageId, draft => { draft.summary = summary; draft.summaryRevision = revision }))))

test("summarizes a long answer once on the real durable engine, and its synced summary ends every later ask", () => scoped(async scope => {
  const ledger = memoryLedger()
  const { model, calls } = summarizing()
  const { run, dispatch } = await device(scope, ledger.layer, model)
  const messages = await run(Collection.local<Message, Collection.Key>({ id: "test-timeline-messages", schema: Message, getKey: message => message.id }))
  await run(Effect.forkIn(followSummaries(messages, messages, dispatch, await run(makeLane)), scope, { startImmediately: true }))
  await run(messages.insert([question("a", "Did the release retry?"), answer("a")]))
  await vi.waitFor(() => expect(ledger.recorded).toHaveLength(1), { timeout: 15_000 })
  expect(ledger.recorded[0]).toEqual({ messageId: "a", revision: revisionOf(answer("a")), summary: "Release retry check completed" })
  expect(ledger.claims).toEqual([{ messageId: "a", reason: "long_answer" }])
  expect(calls()).toBe(1)
  await sync(run, messages, ledger.recorded)
  // Syncs, re-renders and metadata changes never ask again; streaming, empty, short and question rows never ask.
  await run(messages.update("a", draft => { draft.updatedAt = "2026-10-20 18:00:01+00" }))
  await run(messages.insert([{ ...answer("stream"), status: "streaming" }, answer("empty", " "), answer("short", "Retried twice."), question("long-question", `${LONG}\n${LONG}`)]))
  await run(Effect.sleep("50 millis"))
  expect(ledger.claims).toHaveLength(1)
  // Changed content is a new revision: one more claim and call.
  await run(messages.update("a", draft => { draft.text = `${LONG}\nIt also found a stale cache.` }))
  await vi.waitFor(() => expect(ledger.recorded).toHaveLength(2), { timeout: 15_000 })
  expect(ledger.claims.at(-1)).toEqual({ messageId: "a", reason: "multiline_answer" })
  expect(calls()).toBe(2)
}), 30_000)

test("two devices showing the same answers make one model call per answer between them", () => scoped(async scope => {
  const ledger = memoryLedger()
  const { model, calls } = summarizing()
  const devices = await Promise.all([device(scope, ledger.layer, model), device(scope, ledger.layer, model)])
  const tabs = await Promise.all(devices.map(async ({ run, dispatch }, n) => {
    const messages = await run(Collection.local<Message, Collection.Key>({ id: `shared-${n}`, schema: Message, getKey: message => message.id }))
    await run(Effect.forkIn(followSummaries(messages, messages, dispatch, await run(makeLane)), scope, { startImmediately: true }))
    return { run, messages }
  }))
  const ids = ["a", "b", "c"]
  for (const { run, messages } of tabs) await run(messages.insert(ids.map(id => answer(id))))
  await vi.waitFor(() => expect(ledger.recorded).toHaveLength(3), { timeout: 15_000 })
  for (const { run, messages } of tabs) await sync(run, messages, ledger.recorded)
  await tabs[0]!.run(Effect.sleep("50 millis"))
  expect(calls()).toBe(3)
  expect(ledger.claims.length).toBeLessThanOrEqual(6)
}), 30_000)

test("an idle page whose summary model refuses for credit makes at most two model calls", () => scoped(async scope => {
  // smithers.sh, 2026-10-25: one idle chat page made 63 summary calls in 3 minutes, every one refused 402, because
  // each entry's step asked six times and the lane went on to the next entry.
  let calls = 0
  const model = Model.make({ stream: () => {
    calls++
    return Stream.fail(new ModelError.ModelError({ code: "quota_exceeded", httpStatus: 402, message: "payment required" }))
  } })
  // Production's attempts, with test timings: every one of the six still runs on the real durable engine.
  const fast = (layer: ReturnType<typeof SummarySeat.layer>) => Layer.effect(SummarySeat, Effect.map(SummarySeat, service => ({
    ...service, retryPolicy: RetryPolicy.make({ ...ModelStep.defaultRetryPolicy, initialMs: 1, maxMs: 1 }),
  }))).pipe(Layer.provide(layer))
  const { run, dispatch } = await device(scope, memoryLedger().layer, model, fast)
  const messages = await run(Collection.local<Message, Collection.Key>({ id: "refusing-model", schema: Message, getKey: message => message.id }))
  await run(messages.insert(Array.from({ length: 10 }, (_, n) => answer(`m${n}`))))
  await run(Effect.forkIn(followSummaries(messages, messages, dispatch, await run(makeLane)), scope, { startImmediately: true }))
  await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1))
  // Long enough for every entry's six attempts at these timings, had the lane gone on.
  await run(Effect.sleep("500 millis"))
  expect(calls).toBeLessThanOrEqual(2)
  expect((await run(Metric.value(summaryStops))).count).toBe(1)
}), 30_000)

/** A dispatch service that answers every summary `answer`, recording what it was asked. */
const answering = (reply: (id: string) => Effect.Effect<unknown, unknown>) => {
  const dispatched: Array<string> = []
  const dispatch = {
    dispatch: (_name: string, payload: { readonly id: string }) => Effect.suspend(() => {
      dispatched.push(payload.id)
      return reply(payload.id)
    }),
  } as unknown as FlowDispatch["Service"]
  return { dispatched, dispatch }
}
const failing = (code: string) => Effect.succeed({ _tag: "Failed", error: { _tag: "timeline/SummaryFailed", code } })
const done = Effect.succeed({ _tag: "Done", value: { summary: "Release retry check completed" } })
const store = async (scope: Scope.Closeable, id: string) => {
  const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(Persistence.memory)))
  const registry: Metric.MetricRegistry = new Map()
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Scope.provide(scope)(Effect.provide(effect, context).pipe(Effect.provideService(Metric.MetricRegistry, registry))) as Effect.Effect<A, E>)
  const messages = await run(Collection.local<Message, Collection.Key>({ id, schema: Message, getKey: message => message.id }))
  return { run, messages }
}
/** A window that shows `ids` as finished long answers, each twice when `twice` (an update that kept its content). */
const shownWindow = (ids: ReadonlyArray<string>, twice = false) => ({
  changes: () => Stream.concat(Stream.make(ids.flatMap(id => {
    const change = { type: "insert" as const, key: id, value: answer(id), previousValue: undefined }
    return twice ? [change, { ...change, type: "update" as const }] : [change]
  })), Stream.never),
})

test.each(STOPPING_FAILURES)("stops once a summary fails %s: no later entry is dispatched", code => scoped(async scope => {
  const { run, messages } = await store(scope, `stopped-${code}`)
  const { dispatched, dispatch } = answering(() => failing(code))
  await run(messages.insert([answer("a"), answer("b")]))
  const followed = await run(Effect.forkIn(followSummaries(messages, messages, dispatch, await run(makeLane)), scope, { startImmediately: true }))
  await run(Fiber.join(followed))
  await run(messages.insert(answer("c")))
  expect(dispatched).toEqual(["a"])
}))

test("a lane records its stop once, whichever summary stops it first", async () => {
  const registry: Metric.MetricRegistry = new Map()
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  const lane = await run(makeLane)
  await run(lane.stop("unavailable"))
  await run(lane.stop("capped"))
  expect(await run(Deferred.isDone(lane.stopped))).toBe(true)
  expect((await run(Metric.value(summaryStops))).count).toBe(1)
})

test.each(["invalid", "refused", "taken"] as const)("a summary that fails %s belongs to its entry: later entries run, it is never asked again", code => scoped(async scope => {
  const { run, messages } = await store(scope, `continues-${code}`)
  const { dispatched, dispatch } = answering(() => failing(code))
  await run(messages.insert(["a", "b", "c"].map(id => answer(id))))
  // One turn, so each entry runs after the one before it failed.
  const lane = { ...(await run(makeLane)), permits: Semaphore.makeUnsafe(1) }
  await run(Effect.forkIn(followSummaries(shownWindow(["a", "b", "c"], true), messages, dispatch, lane), scope, { startImmediately: true }))
  await vi.waitFor(() => expect(dispatched).toEqual(["a", "b", "c"]))
  // Another conversation on the lane showing the same answers asks nothing.
  await run(Effect.forkIn(followSummaries(shownWindow(["a", "b", "c"]), messages, dispatch, lane), scope, { startImmediately: true }))
  await run(Effect.sleep("20 millis"))
  expect(dispatched).toEqual(["a", "b", "c"])
  expect(await run(Deferred.isDone(lane.stopped))).toBe(false)
}))

test("summarizes long finished answers only, never a question, a short answer or a view the window shows", () => scoped(async scope => {
  const { run, messages } = await store(scope, "with-view")
  const { dispatched, dispatch } = answering(() => failing("invalid"))
  const shown = (value: { readonly id: string; readonly role: string; readonly text: string }) => ({ type: "insert" as const, key: value.id, value: { ...value, status: "done" }, previousValue: undefined })
  const rows = [question("ask", LONG), answer("short", "Done: two retries."), answer("multi", "Retried.\nKept."), answer("long")]
  await run(messages.insert(rows))
  await run(followSummaries({ changes: () => Stream.make([shown({ id: "view", role: "view", text: LONG }), ...rows.map(shown)]) }, messages, dispatch, await run(makeLane)))
  expect(dispatched).toEqual(["multi", "long"])
}))

test("sends the question the answer replies to, and nothing when its question isn't held", () => scoped(async scope => {
  const { run, messages } = await store(scope, "with-question")
  const payloads: Array<Record<string, unknown>> = []
  const dispatch = { dispatch: (_name: string, payload: Record<string, unknown>) => Effect.sync(() => { payloads.push(payload); return { _tag: "Done", value: { summary: "x" } } }) } as unknown as FlowDispatch["Service"]
  const rows = [answer("a"), { ...answer("b"), questionId: null }, answer("c")]
  await run(messages.insert([question("a", "Did the release retry?"), ...rows]))
  await run(followSummaries({ changes: () => Stream.make(rows.map(row => ({ type: "insert" as const, key: row.id, value: row, previousValue: undefined }))) }, messages, dispatch, await run(makeLane)))
  await vi.waitFor(() => expect(payloads).toHaveLength(3))
  const byId = Object.fromEntries(payloads.map(payload => [payload.id, payload]))
  expect(byId.a).toMatchObject({ role: "assistant", reason: "long_answer", question: "Did the release retry?", revision: revisionOf(answer("a")) })
  expect(byId.b).not.toHaveProperty("question")
  expect(byId.c).not.toHaveProperty("question")
}))

// Faulty dispatch services exercise isolation without replacing collection persistence.
test.each(["stall", "defect", "failure"] as const)("a dispatch %s cannot block later summaries", fault => scoped(async scope => {
  const { run, messages } = await store(scope, `isolation-${fault}`)
  const entered = Effect.runSync(Deferred.make<void>())
  const { dispatched, dispatch } = answering(id => id === "a"
    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(
      fault === "stall"
        ? Effect.never
        : fault === "defect"
        ? Effect.die("private defect")
        : Effect.fail(new DispatchFailed({ flow: "timeline/summarize", reason: "unavailable" })),
    ))
    : done)
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logged = Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make(entry => void logs.push(Logger.formatStructured.log(entry)))]))
  await run(Effect.forkIn(logged(followSummaries(messages, messages, dispatch, await run(makeLane))), scope, { startImmediately: true }))
  await run(messages.insert(answer("a")))
  await run(Deferred.await(entered))
  await run(messages.insert(answer("b")))
  await vi.waitFor(() => expect(dispatched).toEqual(["a", "b"]))
  // A failed or defective summary is logged once with its code, never the defect's content.
  const lines = () => logs.filter(log => String(log.message).startsWith("timeline.summary.")).map(({ message, level, annotations }) => ({ message, level, ...annotations }))
  await vi.waitFor(() => expect(lines()).toEqual(fault === "stall" ? [] : [expect.objectContaining(fault === "defect"
    ? { message: "timeline.summary.defect", level: "WARN", feature: "timeline", errorCode: "unknown" }
    : { message: "timeline.summary.unavailable", level: "WARN", feature: "timeline", errorCode: "@smthrs/mvp/flows/DispatchFailed", reason: "unavailable" })]))
  expect(JSON.stringify(logs)).not.toContain("private defect")
}))

test("a long window runs at most two summaries at once, each entry once", () => scoped(async scope => {
  const { run, messages } = await store(scope, "long-window")
  const ids = Array.from({ length: 40 }, (_, n) => `m${n}`)
  await run(messages.insert(ids.map(id => answer(id))))
  let running = 0
  let most = 0
  const { dispatched, dispatch } = answering(() => Effect.gen(function* () {
    most = Math.max(most, ++running)
    yield* Effect.sleep("2 millis")
    running--
    return yield* done
  }))
  await run(Effect.forkIn(followSummaries(shownWindow(ids, true), messages, dispatch, await run(makeLane)), scope, { startImmediately: true }))
  await vi.waitFor(() => expect(dispatched.length).toBe(40))
  await run(Effect.sleep("20 millis"))
  expect(new Set(dispatched).size).toBe(40)
  expect(dispatched.length).toBe(40)
  expect(most).toBeLessThanOrEqual(2)
}))

test("a summary role with no model costs at most two requests for both conversations a page follows", () => scoped(async scope => {
  const { run, messages } = await store(scope, "no-model")
  const { dispatched, dispatch } = answering(() => Effect.sleep("2 millis").pipe(Effect.andThen(failing("unconfigured"))))
  const lane = await run(makeLane)
  const home = Array.from({ length: 50 }, (_, n) => `home${n}`)
  const branch = Array.from({ length: 50 }, (_, n) => `branch${n}`)
  await run(messages.insert([...home, ...branch].map(id => answer(id))))
  await run(Effect.all([
    followSummaries(shownWindow(home), messages, dispatch, lane),
    followSummaries(shownWindow(branch), messages, dispatch, lane),
  ], { concurrency: "unbounded" }))
  await run(Effect.sleep("50 millis"))
  expect(dispatched.length).toBeGreaterThanOrEqual(1)
  expect(dispatched.length).toBeLessThanOrEqual(2)
}))

test("an entry that changes, leaves or gets its summary while it waits for its turn is never sent", () => scoped(async scope => {
  const { run, messages } = await store(scope, "waiting")
  const ids = ["a", "b", "c", "d", "e"]
  await run(messages.insert(ids.map(id => answer(id))))
  const release = Effect.runSync(Deferred.make<void>())
  const { dispatched, dispatch } = answering(() => Deferred.await(release).pipe(Effect.andThen(done)))
  await run(Effect.forkIn(followSummaries(shownWindow(ids), messages, dispatch, await run(makeLane)), scope, { startImmediately: true }))
  await vi.waitFor(() => expect(dispatched).toEqual(["a", "b"]))
  await run(messages.delete("c"))
  await run(messages.update("d", draft => { draft.text = `${LONG} changed` }))
  await run(messages.update("e", draft => { draft.summary = "Made elsewhere"; draft.summaryRevision = revisionOf(answer("e")) }))
  await run(Deferred.succeed(release, undefined))
  await run(Effect.sleep("30 millis"))
  expect(dispatched).toEqual(["a", "b"])
}))

test("an answer whose summary is already on the message is never sent", () => scoped(async scope => {
  const { run, messages } = await store(scope, "summarized")
  const { dispatched, dispatch } = answering(() => done)
  const summarized = { ...answer("a"), summary: "Release retry check completed", summaryRevision: revisionOf(answer("a")) }
  await run(messages.insert(summarized))
  await run(followSummaries({ changes: () => Stream.make([{ type: "insert" as const, key: "a", value: summarized, previousValue: undefined }]) }, messages, dispatch, await run(makeLane)))
  expect(dispatched).toEqual([])
}))

test("an entry waiting for its turn when the role answers it has no model is never sent", () => scoped(async scope => {
  const { run, messages } = await store(scope, "waiting-stop")
  await run(messages.insert(["a", "b"].map(id => answer(id))))
  const { dispatched, dispatch } = answering(() => failing("unconfigured"))
  // One turn: "b" waits while "a" holds it, and takes it the moment "a" answers that there is no model.
  const lane = { ...(await run(makeLane)), permits: Semaphore.makeUnsafe(1) }
  await run(followSummaries(shownWindow(["a", "b"]), messages, dispatch, lane))
  expect(dispatched).toEqual(["a"])
}))
