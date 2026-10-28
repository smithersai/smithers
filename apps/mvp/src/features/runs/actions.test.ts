// Latency, interruption and refusal are injected through the action's Effect services.
import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Deferred, Effect, Fiber, Layer, Logger, ManagedRuntime, Option, Stream } from "effect"
import { afterEach, expect, test } from "vitest"
import { DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { RemoteRunsClient } from "./api"
import * as actions from "./actions"
import { AnswersUnavailable } from "../agent/answers"
import { CancelPending } from "./flows"
import { REFUSAL_WORDS } from "./contract"
import type { Inspection } from "./schema"
import { VIEW } from "./schema"
import { RunsStore } from "./store"

const inspection = (runId: string): Inspection => ({
  run: { runId, flowName: "flow/run", status: "completed", createdAtMs: 0, startedAtMs: 0, finishedAtMs: 1, parentRunId: null, cancelRequestedAtMs: null, waiting: null, lastSeq: 1, origin: null, input: { text: "{}", bytes: 2, clipped: false }, result: null },
  steps: [], children: [], journal: { events: [], afterSeq: -1, nextSeq: -1, hasMore: false },
})
const opened: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of opened.splice(0)) await runtime.dispose() })
const setup = async (options: { dispatch?: Effect.Effect<unknown, DispatchFailed>; exists?: (id: string) => Effect.Effect<Inspection, BrowserEngine.RequestRefused | BrowserEngine.EngineUnavailable> } = {}) => {
  const started = Effect.runSync(Deferred.make<void>())
  const pending = Effect.runSync(Deferred.make<unknown, DispatchFailed>())
  const calls: Array<{ name: string; payload: unknown; executionId?: string }> = []
  const inspections: string[] = []
  const navigated: string[] = []
  const engine = Layer.succeed(BrowserEngine.BrowserEngine, BrowserEngine.BrowserEngine.of({
    start: () => Effect.die("unused"), result: () => Effect.die("unused"), cancel: () => Effect.die("unused"), signal: () => Effect.die("unused"), runs: () => Stream.empty,
    inspect: (id) => { inspections.push(id); return options.exists?.(id) ?? (id.includes("retry:") ? Effect.fail(new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/RunNotFound" })) : Effect.succeed(inspection(id))) },
    list: () => Effect.succeed({ runs: [], cursor: null }), events: Stream.never, unavailable: Effect.never,
  }))
  const dispatch = Layer.succeed(FlowDispatch, FlowDispatch.of({ dispatch: ((name: string, payload: unknown, opts: { executionId?: string }) => {
    calls.push({ name, payload, executionId: opts.executionId })
    return Effect.andThen(Deferred.succeed(started, undefined), options.dispatch ?? Deferred.await(pending))
  }) as never }))
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    RunsStore.layer({ origin: "http://test" }).pipe(Layer.provide(Layer.mergeAll(engine, Persistence.memory, Layer.succeed(RemoteRunsClient, RemoteRunsClient.of({ inspect: () => Effect.die("unused"), steer: () => Effect.die("unused"), stop: () => Effect.die("unused"), list: Effect.succeed([]) }))))),
    dispatch, engine, Layer.succeed(actions.RunsNavigation, { navigate: (path) => { navigated.push(path) } }),
  ))
  opened.push(runtime)
  const store = await runtime.runPromise(Effect.service(RunsStore))
  const view = () => runtime.runPromise(store.view.get(VIEW)).then(Option.getOrThrow)
  await runtime.runPromise(actions.openRun("a"))
  return { runtime, store, view, calls, inspections, navigated, started, pending }
}

test("an earlier act cannot clear a newer run's act or write its refusal", async () => {
  const t = await setup()
  const old = t.runtime.runPromise(actions.stop)
  await t.runtime.runPromise(Deferred.await(t.started))
  await t.runtime.runPromise(actions.openRun("b"))
  const newer = t.runtime.runFork(actions.resume)
  await t.runtime.runPromise(Effect.yieldNow)
  await t.runtime.runPromise(Deferred.succeed(t.pending, { _tag: "Failed", error: { code: "stale" } }))
  await old
  await t.runtime.runPromise(Fiber.join(newer))
  // The old completion may never refresh a after b has opened.
  expect(t.inspections).toEqual(["a", "b", "b"])
  expect(await t.view()).toMatchObject({ runId: "b", acting: null, refusal: "stale" })
})

test("an older act for the same run cannot clear the newer act", async () => {
  const t = await setup()
  const second = Effect.runSync(Deferred.make<unknown>())
  let count = 0
  const dispatch = FlowDispatch.of({ dispatch: (() => ++count === 1 ? Deferred.await(t.pending) : Deferred.await(second)) as never })
  const old = t.runtime.runPromise(actions.stop.pipe(Effect.provideService(FlowDispatch, dispatch)))
  await t.runtime.runPromise(Effect.yieldNow)
  const newer = t.runtime.runPromise(actions.resume.pipe(Effect.provideService(FlowDispatch, dispatch)))
  await t.runtime.runPromise(Effect.yieldNow)
  await t.runtime.runPromise(Deferred.succeed(t.pending, { _tag: "Failed", error: { code: "stale" } }))
  await old
  expect(await t.view()).toMatchObject({ acting: "resume", refusal: null })
  await t.runtime.runPromise(Deferred.succeed(second, { _tag: "Done", value: {} }))
  await newer
  expect((await t.view()).acting).toBeNull()
})

test.each(["interruption", "defect"])("%s clears the action indicator", async (kind) => {
  const t = await setup({ dispatch: kind === "defect" ? Effect.die("fault") : Effect.never })
  const fiber = t.runtime.runFork(actions.stop)
  await t.runtime.runPromise(Deferred.await(t.started))
  if (kind === "interruption") await t.runtime.runPromise(Fiber.interrupt(fiber))
  else await t.runtime.runPromise(Fiber.await(fiber))
  expect((await t.view()).acting).toBeNull()
})

test("a late retry stays on the run opened afterward", async () => {
  const t = await setup()
  const retrying = t.runtime.runPromise(actions.retry("pinned"))
  await t.runtime.runPromise(Deferred.await(t.started))
  await t.runtime.runPromise(actions.openRun("b"))
  await t.runtime.runPromise(Deferred.succeed(t.pending, { _tag: "Done", value: { runId: "retried" } }))
  await retrying
  expect(t.navigated).toEqual([])
})

test("a late retry stays put once the person left the run page, for the list or another page", async () => {
  // The list: opening it releases the act.
  const listed = await setup()
  const toList = listed.runtime.runPromise(actions.retry("pinned"))
  await listed.runtime.runPromise(Deferred.await(listed.started))
  await listed.runtime.runPromise(actions.openList())
  await listed.runtime.runPromise(Deferred.succeed(listed.pending, { _tag: "Done", value: { runId: "retried" } }))
  await toList
  expect(listed.navigated).toEqual([])
  // Another page: the run route's onLeave closes the run.
  const left = await setup()
  const elsewhere = left.runtime.runPromise(actions.retry("pinned"))
  await left.runtime.runPromise(Deferred.await(left.started))
  await left.runtime.runPromise(actions.closeRun("a"))
  expect(await left.view()).toMatchObject({ runId: null, acting: null, actToken: null })
  await left.runtime.runPromise(Deferred.succeed(left.pending, { _tag: "Done", value: { runId: "retried" } }))
  await elsewhere
  expect(left.navigated).toEqual([])
})

test("leaving a run whose page another run's already replaced keeps that page", async () => {
  const t = await setup()
  await t.runtime.runPromise(actions.openRun("b"))
  await t.runtime.runPromise(actions.closeRun("a"))
  expect((await t.view()).runId).toBe("b")
})

test("retry probes the engine past older retries missing from the bounded list", async () => {
  const t = await setup({ dispatch: Effect.succeed({ _tag: "Done", value: { runId: "retry:a:3/run" } }), exists: (id) => id === "retry:a:3/run" || id === "retry:a:3" ? Effect.fail(new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/RunNotFound" })) : Effect.succeed(inspection(id)) })
  await t.runtime.runPromise(actions.retry("current"))
  expect(t.calls[0]?.executionId).toBe("retry:a:3")
  expect(t.navigated).toEqual(["/app/runs/retry%3Aa%3A3%2Frun"])
})

test.each(["invalid", "refused", "interrupted", "unavailable"] as const)("dispatch %s keeps its own refusal and copy", async (reason) => {
  const t = await setup({ dispatch: Effect.fail(new DispatchFailed({ flow: "run/cancel", reason })) })
  await t.runtime.runPromise(actions.stop)
  expect((await t.view()).refusal).toBe(reason)
  expect(REFUSAL_WORDS[reason]).toBeTruthy()
  expect(new Set(["invalid", "refused", "interrupted", "unavailable"].map((code) => REFUSAL_WORDS[code])).size).toBe(4)
})

test("local selections, list opening, journal More and returning live use the store", async () => {
  const t = await setup()
  await t.runtime.runPromise(actions.openList())
  await t.runtime.runPromise(actions.select("step"))
  await t.runtime.runPromise(actions.showTab("journal"))
  await t.runtime.runPromise(actions.more)
  await t.runtime.runPromise(actions.scrub(1))
  expect(await t.view()).toMatchObject({ listOpen: true, selected: "step", tab: "journal", at: 1 })
  await t.runtime.runPromise(actions.scrub(null))
  await t.runtime.runPromise(actions.inspectStep("other"))
  await t.runtime.runPromise(actions.showInspector(false))
  expect(await t.view()).toMatchObject({ selected: "other", inspectorOpen: false, at: null })
  await t.runtime.runPromise(t.store.view.update(VIEW, (draft) => { draft.runId = null }))
  await t.runtime.runPromise(actions.stop)
  await t.runtime.runPromise(actions.more)
  await t.runtime.runPromise(actions.scrub(null))
  expect(t.calls).toEqual([])
  await t.runtime.runPromise(t.store.view.update(VIEW, (draft) => { draft.runId = "missing" }))
  await t.runtime.runPromise(actions.resume)
  await t.runtime.runPromise(t.store.pages.insert({ id: "missing", state: "not_found", inspection: null, more: [], hasMore: false }))
  await t.runtime.runPromise(actions.stop)
  expect(t.calls).toEqual([])
})

test("a refused retry retains its refusal without navigating", async () => {
  const t = await setup({ dispatch: Effect.succeed({ _tag: "Failed", error: { code: "not_retryable" } }) })
  await t.runtime.runPromise(actions.retry("pinned"))
  expect(await t.view()).toMatchObject({ acting: null, refusal: "not_retryable" })
  expect(t.navigated).toEqual([])
})

test.each(["engine", "refusal", "exhausted"])("retry fails closed when probing finds %s", async (mode) => {
  const t = await setup({ exists: (id) => id === "a" || mode === "exhausted" ? Effect.succeed(inspection(id)) : mode === "engine"
    ? Effect.fail(new BrowserEngine.EngineUnavailable({ reason: "worker-failed", error: "fault" }))
    : Effect.fail(new BrowserEngine.RequestRefused({ request: "Inspect", error: "not-a-missing-run" })) })
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  await t.runtime.runPromise(actions.retry("pinned").pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
  ))
  expect(t.calls).toEqual([])
  expect((await t.view()).refusal).toBe(mode === "exhausted" ? "refused" : "unavailable")
  // An engine that can't say whether the id is taken is logged once with its code; running out of ids is an answer.
  expect(logs.filter((log) => log.message === "run.retry.reserve")).toEqual(mode === "exhausted" ? [] : [
    expect.objectContaining({
      level: "WARN",
      annotations: expect.objectContaining({
        feature: "runs",
        outcome: "unavailable",
        errorCode: mode === "engine" ? "worker-failed" : "not-a-missing-run",
      }),
    }),
  ])
})

test("Retry from here dispatches run/retry/from with the step as the next retry act, and opens its new run", async () => {
  const t = await setup({ dispatch: Effect.succeed({ _tag: "Done", value: { runId: "retry:a:1/run" } }) })
  await t.runtime.runPromise(actions.retryFrom("root.flow.prompt"))
  expect(t.calls).toEqual([{ name: "run/retry/from", payload: { runId: "a", step: "root.flow.prompt" }, executionId: "retry:a:1" }])
  expect(t.navigated).toEqual(["/app/runs/retry%3Aa%3A1%2Frun"])
  expect(await t.view()).toMatchObject({ acting: null, refusal: null })
})

test("a refused Retry from here keeps its refusal without navigating, and a probe that fails starts nothing", async () => {
  const refused = await setup({ dispatch: Effect.succeed({ _tag: "Failed", error: { code: "step_not_run" } }) })
  await refused.runtime.runPromise(actions.retryFrom("root.flow.load"))
  expect(await refused.view()).toMatchObject({ acting: null, refusal: "step_not_run" })
  expect(refused.navigated).toEqual([])
  expect(REFUSAL_WORDS["step_not_run"]).toBe("This step didn't run.")
  const unreadable = await setup({ exists: (id) => id === "a" ? Effect.succeed(inspection(id)) : Effect.fail(new BrowserEngine.EngineUnavailable({ reason: "worker-failed", error: "fault" })) })
  await unreadable.runtime.runPromise(actions.retryFrom("root.flow.prompt"))
  expect(unreadable.calls).toEqual([])
  expect((await unreadable.view()).refusal).toBe("unavailable")
})

test("a dispatch defect keeps its failure code", async () => {
  const t = await setup({ dispatch: Effect.fail(new DispatchFailed({ flow: "run/cancel", reason: "defect" })) })
  await t.runtime.runPromise(actions.stop)
  expect((await t.view()).refusal).toBe("defect")
})

test("a failed retry act reserves its id even when it never created a child run", async () => {
  const t = await setup({ dispatch: Effect.succeed({ _tag: "Done", value: { runId: "retry:a:2/run" } }), exists: (id) => id === "a" || id === "retry:a:1"
    ? Effect.succeed({ ...inspection(id), run: { ...inspection(id).run, ...(id === "retry:a:1" ? { flowName: "run/retry", status: "failed" as const } : {}) } })
    : Effect.fail(new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/RunNotFound" })) })
  await t.runtime.runPromise(actions.retry("pinned"))
  expect(t.calls[0]?.executionId).toBe("retry:a:2")
})


test.each(["engine", "refusal"])("retry refuses an unreadable act after its child was absent: %s", async (mode) => {
  const t = await setup({ exists: (id) => id === "a" ? Effect.succeed(inspection(id)) : id.endsWith("/run")
    ? Effect.fail(new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/RunNotFound" }))
    : mode === "engine" ? Effect.fail(new BrowserEngine.EngineUnavailable({ reason: "worker-failed", error: "fault" }))
    : Effect.fail(new BrowserEngine.RequestRefused({ request: "Inspect", error: "unreadable" })) })
  await t.runtime.runPromise(actions.retry("pinned"))
  expect(t.calls).toEqual([])
  expect((await t.view()).refusal).toBe("unavailable")
})

test("an act clears its indicator before refreshing the completed run", async () => {
  const t = await setup({ dispatch: Effect.succeed({ _tag: "Done", value: {} }) })
  const store = { ...t.store, readRun: (id: string) => Effect.gen(function* () {
    const view = Option.getOrThrow(yield* t.store.view.get(VIEW))
    expect(view.acting).toBeNull()
    expect(view.actToken).toBeNull()
    yield* t.store.readRun(id)
  }) }
  await t.runtime.runPromise(actions.stop.pipe(Effect.provideService(RunsStore, store)))
})

for (const error of [new CancelPending(), new AnswersUnavailable({ status: 503 })]) {
  test(`a cancellation exhausted with ${error._tag} leaves a visible refusal`, async () => {
    const t = await setup({ dispatch: Effect.succeed({ _tag: "Failed", error }) })
    await t.runtime.runPromise(actions.stop)
    expect((await t.view()).refusal).toBe("unavailable")
  })
}

test("the run page retries a system TODO through todo/Retry instead of replaying the old attempt", async () => {
  const t = await setup({ dispatch: Effect.succeed({ _tag: "Done", value: { opId: "press", status: "requested" } }) })
  const read = inspection("a")
  const text = JSON.stringify({ repoId: "github/octo/hello", number: 1, attemptId: "old-attempt" })
  await t.runtime.runPromise(t.store.pages.update("a", (row) => {
    row.inspection = { ...read, run: { ...read.run, flowName: "todo", status: "failed", input: { text, bytes: text.length, clipped: false } } }
  }))
  await t.runtime.runPromise(actions.retry("pinned"))
  expect(t.calls).toEqual([{ name: "todo/Retry", payload: { repo: "octo/hello", number: 1 }, executionId: undefined }])
  expect(t.navigated).toEqual([])
  expect(t.inspections.some((id) => id.startsWith("retry:"))).toBe(false)
})

test("Retry refuses a TODO run whose stored input cannot identify its TODO", async () => {
  const t = await setup({ exists: (id) => Effect.succeed({ ...inspection(id), run: { ...inspection(id).run, flowName: "todo", input: { text: "{}", bytes: 2, clipped: false } } }) })
  await t.runtime.runPromise(actions.retry("current"))
  expect((await t.view()).refusal).toBe("not_retryable")
  expect(t.calls).toEqual([])
})
