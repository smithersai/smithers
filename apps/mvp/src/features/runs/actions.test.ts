// Latency, interruption and refusal are injected through the action's Effect services.
import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Deferred, Effect, Fiber, Layer, Logger, ManagedRuntime, Option, Stream } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { repoAuthority } from "../../test/repoAuthority"
import { DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { RemoteRunsClient, RepoRunsFailed } from "./api"
import * as actions from "./actions"
import { AnswersUnavailable } from "../agent/answers"
import { CancelPending } from "./flows"
import { REFUSAL_WORDS } from "./contract"
import type { Inspection } from "./schema"
import { VIEW } from "./schema"
import { RunsStore } from "./store"
import { actsOf, placeOf } from "./page"
import { headerStatusOf } from "./todoRun"

const inspection = (runId: string): Inspection => ({
  run: { runId, flowName: "flow/run", status: "completed", createdAtMs: 0, startedAtMs: 0, finishedAtMs: 1, parentRunId: null, cancelRequestedAtMs: null, waiting: null, lastSeq: 1, origin: null, input: { text: "{}", bytes: 2, clipped: false }, result: null },
  steps: [], children: [], journal: { events: [], afterSeq: -1, nextSeq: -1, hasMore: false },
})
const opened: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of opened.splice(0)) await runtime.dispose() })
const unused = { inspect: () => Effect.die("unused"), steer: () => Effect.die("unused"), stop: () => Effect.die("unused"), list: Effect.succeed([]), flows: () => Effect.die("unused"), inputs: () => Effect.die("unused"), start: () => Effect.die("unused") }
const setup = async (options: { dispatch?: Effect.Effect<unknown, DispatchFailed>; exists?: (id: string) => Effect.Effect<Inspection, BrowserEngine.RequestRefused | BrowserEngine.EngineUnavailable>; remote?: Partial<RemoteRunsClient["Service"]> } = {}) => {
  const started = Effect.runSync(Deferred.make<void>())
  const pending = Effect.runSync(Deferred.make<unknown, DispatchFailed>())
  const calls: Array<{ name: string; payload: unknown; executionId?: string }> = []
  const inspections: string[] = []
  const navigated: string[] = []
  const engine = Layer.succeed(BrowserEngine.BrowserEngine, BrowserEngine.BrowserEngine.of({
    retry: () => Effect.die("not reached"),
    start: () => Effect.die("unused"), result: () => Effect.die("unused"), cancel: () => Effect.die("unused"), signal: () => Effect.die("unused"), runs: () => Stream.empty,
    inspect: (id) => { inspections.push(id); return options.exists?.(id) ?? (id.includes("retry:") ? Effect.fail(new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/RunNotFound" })) : Effect.succeed(inspection(id))) },
    list: () => Effect.succeed({ runs: [], cursor: null }), events: Stream.never, unavailable: Effect.never,
  }))
  const dispatch = Layer.succeed(FlowDispatch, FlowDispatch.of({ dispatch: ((name: string, payload: unknown, opts: { executionId?: string }) => {
    calls.push({ name, payload, executionId: opts.executionId })
    return Effect.andThen(Deferred.succeed(started, undefined), options.dispatch ?? Deferred.await(pending))
  }) as never }))
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    RunsStore.layer({ origin: "http://test" }).pipe(Layer.provide(repoAuthority), Layer.provide(Layer.mergeAll(engine, Persistence.memory, Layer.succeed(RemoteRunsClient, RemoteRunsClient.of({ ...unused, ...options.remote } as RemoteRunsClient["Service"]))))),
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

const repo = { owner: "octo", name: "hello" }

test("the Run form: the repository's flows, then the chosen one's inputs at the default branch, the branch first", async () => {
  const asked: Array<string> = []
  const t = await setup({
    remote: {
      flows: (at) => Effect.sync(() => {
        asked.push(`flows ${at.owner}/${at.name}`)
        return { flows: [{ name: "release", title: "Release" }, { name: "ci" }], defaultBranch: "trunk" }
      }),
      inputs: (_at, flow, ref) => Effect.sync(() => {
        asked.push(`inputs ${flow}@${ref}`)
        return { sha: "a".repeat(40), inputs: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] } }
      }),
    },
  })
  const form = () => t.runtime.runPromise(t.store.form.get("form")).then(Option.getOrThrow)
  await t.runtime.runPromise(t.store.loadRepoFlows(repo))
  expect(await form()).toMatchObject({ repo, flows: [{ name: "release", title: "Release" }, { name: "ci" }], defaultBranch: "trunk", ref: "trunk", flow: null, state: "ready" })
  await t.runtime.runPromise(actions.chooseRepoFlow("release"))
  expect(await form()).toMatchObject({
    flow: "release",
    state: "ready",
    schema: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
  })
  // Another branch: the form reads again there once the person leaves the field.
  await t.runtime.runPromise(actions.setRunRef("feature/x"))
  await t.runtime.runPromise(actions.reloadRepoFlow)
  expect(asked).toEqual(["flows octo/hello", "inputs release@trunk", "inputs release@feature/x"])
})

test("the Run form says why it can't show: flows or inputs refused; a choice before the flows are read does nothing", async () => {
  const t = await setup({
    remote: {
      flows: () => Effect.fail(new RepoRunsFailed({ status: 503, code: "off" })),
      inputs: () => Effect.fail(new RepoRunsFailed({})),
    },
  })
  const form = () => t.runtime.runPromise(t.store.form.get("form")).then(Option.getOrThrow)
  await t.runtime.runPromise(actions.chooseRepoFlow("release"))
  expect(await form()).toMatchObject({ flow: null, state: "idle" })
  await t.runtime.runPromise(t.store.loadRepoFlows(repo))
  expect(await form()).toMatchObject({ state: "refused", refusal: "off" })
  expect(REFUSAL_WORDS.off).toBe("Flows are off here.")
  await t.runtime.runPromise(t.store.form.update("form", (draft) => { draft.ref = "main" }))
  await t.runtime.runPromise(actions.chooseRepoFlow("release"))
  expect(await form()).toMatchObject({ state: "refused", refusal: "unavailable" })
})

test("Retry reads the initial flow list again for the same repository", async () => {
  const asked: Array<string> = []
  const t = await setup({
    remote: {
      flows: (at) => Effect.suspend(() => {
        asked.push(`${at.owner}/${at.name}`)
        return asked.length === 1
          ? Effect.fail(new RepoRunsFailed({ status: 503, code: "unavailable" }))
          : Effect.succeed({ flows: [{ name: "ci" }], defaultBranch: "trunk" })
      }),
    },
  })
  const form = () => t.runtime.runPromise(t.store.form.get("form")).then(Option.getOrThrow)
  // No repository is open yet: Retry performs no read.
  await t.runtime.runPromise(actions.reloadRepoFlow)
  expect(asked).toEqual([])
  await t.runtime.runPromise(t.store.loadRepoFlows(repo))
  expect(await form()).toMatchObject({ repo, state: "refused", flows: [], refusal: "unavailable" })
  await t.runtime.runPromise(actions.reloadRepoFlow)
  expect(asked).toEqual(["octo/hello", "octo/hello"])
  expect(await form()).toMatchObject({ repo, state: "ready", flows: [{ name: "ci" }], ref: "trunk", refusal: null })
})

test("a slower answer for an earlier choice changes nothing", async () => {
  const slow = Effect.runSync(Deferred.make<void>())
  const t = await setup({
    remote: {
      flows: () => Effect.succeed({ flows: [{ name: "a" }, { name: "b" }], defaultBranch: "main" }),
      inputs: (_at, flow) =>
        Effect.andThen(flow === "a" ? Deferred.await(slow) : Effect.void, Effect.succeed({ sha: "s", inputs: { title: flow } })),
    },
  })
  await t.runtime.runPromise(t.store.loadRepoFlows(repo))
  const first = t.runtime.runFork(actions.chooseRepoFlow("a"))
  await t.runtime.runPromise(Effect.yieldNow)
  await t.runtime.runPromise(actions.chooseRepoFlow("b"))
  await t.runtime.runPromise(Deferred.succeed(slow, undefined))
  await t.runtime.runPromise(Fiber.join(first))
  const form = await t.runtime.runPromise(t.store.form.get("form")).then(Option.getOrThrow)
  expect(form).toMatchObject({ flow: "b", schema: { title: "b" } })
})

test("Run dispatches repo/run with the form's values, the branch apart, and opens the run's page", async () => {
  const t = await setup({
    remote: {
      flows: () => Effect.succeed({ flows: [{ name: "release" }], defaultBranch: "main" }),
      inputs: () => Effect.succeed({ sha: "s", inputs: {} }),
    },
    dispatch: Effect.succeed({ _tag: "Done", value: { runId: "release:1" } }),
  })
  // No flow chosen: nothing runs, and nothing reads again.
  await t.runtime.runPromise(actions.runRepoFlow({}))
  await t.runtime.runPromise(actions.reloadRepoFlow)
  expect(t.calls).toEqual([])
  await t.runtime.runPromise(t.store.loadRepoFlows(repo))
  await t.runtime.runPromise(actions.chooseRepoFlow("release"))
  await t.runtime.runPromise(actions.setRunRef("next"))
  await t.runtime.runPromise(actions.runRepoFlow({ tag: "v1", dry: true }))
  expect(t.calls).toEqual([{
    name: "repo/run",
    payload: { repo: "octo/hello", flow: "release", ref: "next", input: { tag: "v1", dry: true } },
    executionId: undefined,
  }])
  expect(t.navigated).toEqual(["/octo/hello/actions/runs/release%3A1"])
})

test("a refused Run stays on the form with why; one that couldn't be dispatched says unavailable; one starting ignores a second", async () => {
  const outcome = { value: Effect.succeed({ _tag: "Failed", error: { code: "inputs" } }) as Effect.Effect<unknown, DispatchFailed> }
  const t = await setup({
    remote: {
      flows: () => Effect.succeed({ flows: [{ name: "release" }], defaultBranch: "main" }),
      inputs: () => Effect.succeed({ sha: "s", inputs: {} }),
    },
    dispatch: Effect.suspend(() => outcome.value),
  })
  const form = () => t.runtime.runPromise(t.store.form.get("form")).then(Option.getOrThrow)
  await t.runtime.runPromise(t.store.loadRepoFlows(repo))
  await t.runtime.runPromise(actions.chooseRepoFlow("release"))
  await t.runtime.runPromise(actions.runRepoFlow({}))
  expect(await form()).toMatchObject({ state: "ready", refusal: "inputs" })
  expect(t.calls[0]!.payload).toMatchObject({ ref: "main", input: {} })
  outcome.value = Effect.fail(new DispatchFailed({ flow: "repo/run", reason: "defect" }))
  await t.runtime.runPromise(actions.runRepoFlow({}))
  expect(await form()).toMatchObject({ state: "ready", refusal: "unavailable" })
  outcome.value = Effect.succeed({ _tag: "Failed", error: { _tag: "Interrupted" } })
  await t.runtime.runPromise(actions.runRepoFlow({}))
  expect(await form()).toMatchObject({ refusal: "unavailable" })
  await t.runtime.runPromise(t.store.form.update("form", (draft) => { draft.state = "starting" }))
  await t.runtime.runPromise(actions.runRepoFlow({}))
  expect(t.calls).toHaveLength(3)
  // A Run in flight keeps its form: choosing again reads nothing.
  await t.runtime.runPromise(actions.chooseRepoFlow("release"))
  expect(await form()).toMatchObject({ state: "starting" })
})

test("a Run whose answer comes after the page was left moves nothing", async () => {
  const t = await setup({
    remote: {
      flows: () => Effect.succeed({ flows: [{ name: "release" }], defaultBranch: "main" }),
      inputs: () => Effect.succeed({ sha: "s", inputs: {} }),
    },
  })
  await t.runtime.runPromise(t.store.loadRepoFlows(repo))
  await t.runtime.runPromise(actions.chooseRepoFlow("release"))
  const running = t.runtime.runPromise(actions.runRepoFlow({}))
  await t.runtime.runPromise(Deferred.await(t.started))
  await t.runtime.runPromise(actions.closeRepoRuns)
  await t.runtime.runPromise(Deferred.succeed(t.pending, { _tag: "Done", value: { runId: "release:1" } }))
  await running
  expect(t.navigated).toEqual([])
})

test("a read that lost to a newer one changes nothing; a flow with no branch runs nothing", async () => {
  const slow = Effect.runSync(Deferred.make<void>())
  let first = true
  const t = await setup({
    remote: {
      flows: () => Effect.suspend(() => {
        if (!first) return Effect.fail(new RepoRunsFailed({ status: 500 }))
        first = false
        return Effect.andThen(Deferred.await(slow), Effect.succeed({ flows: [{ name: "late" }], defaultBranch: "main" }))
      }),
    },
  })
  const form = () => t.runtime.runPromise(t.store.form.get("form")).then(Option.getOrThrow)
  const earlier = t.runtime.runFork(t.store.loadRepoFlows(repo))
  await t.runtime.runPromise(Effect.yieldNow)
  // The newer read, refused with no code, says unavailable.
  await t.runtime.runPromise(t.store.loadRepoFlows(repo))
  await t.runtime.runPromise(Deferred.succeed(slow, undefined))
  await t.runtime.runPromise(Fiber.join(earlier))
  expect(await form()).toMatchObject({ flows: [], state: "refused", refusal: "unavailable" })
  await t.runtime.runPromise(t.store.form.update("form", (draft) => { draft.flow = "late" }))
  await t.runtime.runPromise(actions.runRepoFlow({}))
  expect(t.calls).toEqual([])
})

test("Retry and Retry failed on a repository's run run on Cloudflare and open the new run's page", async () => {
  const t = await setup({ dispatch: Effect.succeed({ _tag: "Done", value: { runId: "ci:2" } }) })
  // The open run, as a repository's run's page holds it.
  await t.runtime.runPromise(t.store.view.update(VIEW, (draft) => { draft.repo = repo }))
  await t.runtime.runPromise(actions.retry("pinned"))
  await t.runtime.runPromise(actions.retryFailed)
  expect(t.calls.map((call) => [call.name, call.payload])).toEqual([
    ["run/retry", { runId: "a", version: "pinned", host: "cloud", repo: "octo/hello", failed: false }],
    ["run/retry", { runId: "a", version: "pinned", host: "cloud", repo: "octo/hello", failed: true }],
  ])
  expect(t.navigated).toEqual(["/octo/hello/actions/runs/ci%3A2", "/octo/hello/actions/runs/ci%3A2"])
})

test("a repository's run opened at its global URL stops and runs again on Cloudflare; a system run acts nowhere", async () => {
  const cloudRun = (runId: string, kind: "repo" | "system", repo: string | null) => ({
    runId, flow: "ci", kind, status: "running" as const, cancelRequested: false, createdAtMs: 0, startedAtMs: 0,
    finishedAtMs: null, trigger: "push" as const, branch: "main", actor: null, repo,
  })
  const running = (runId: string): Inspection => {
    const read = inspection(runId)
    return { ...read, run: { ...read.run, status: "running", finishedAtMs: null, lastSeq: 7 } }
  }
  const t = await setup({
    dispatch: Effect.succeed({ _tag: "Done", value: { runId: "ci:2" } }),
    // This device's engine never held either run: ChatApi answers them.
    exists: (id) => id === "a" ? Effect.succeed(inspection(id)) : Effect.fail(new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/RunNotFound" })),
    remote: {
      inspect: (id: string) => Effect.succeed(running(id)),
      list: Effect.succeed([cloudRun("ci:1", "repo", "octo/hello"), cloudRun("deploy:1", "system", null)]),
    } as Partial<RemoteRunsClient["Service"]>,
  })
  await t.runtime.runPromise(t.store.loadCloud)
  const placed = async (runId: string) => {
    // `/app/runs/$runId` names no repository.
    await t.runtime.runPromise(actions.openRun(runId))
    await vi.waitFor(async () => expect(await t.runtime.runPromise(t.store.pages.get(runId)).then(Option.getOrThrow)).toMatchObject({ state: "read" }))
    const page = await t.runtime.runPromise(t.store.pages.get(runId)).then(Option.getOrThrow)
    return { page, acts: actsOf(page.inspection as Inspection, 0, undefined, placeOf(page, (await t.view()).repo)) }
  }
  const repoRun = await placed("ci:1")
  expect(repoRun.page.repoId).toBe("github/octo/hello")
  expect(repoRun.acts).toEqual({ stop: true, retry: false, retryFailed: false, resume: false })
  await t.runtime.runPromise(actions.stop)
  await t.runtime.runPromise(actions.retry("pinned"))
  expect(t.calls.map((call) => [call.name, call.payload])).toEqual([
    ["run/cancel", { runId: "ci:1", seq: 7, host: "cloud" }],
    ["run/retry", { runId: "ci:1", version: "pinned", host: "cloud", repo: "octo/hello", failed: false }],
  ])
  // A system flow: Cloudflare's stop and runs routes act only on a repository's run.
  const system = await placed("deploy:1")
  expect(system.page.system).toBe(true)
  expect(system.acts).toEqual({ stop: false, retry: false, retryFailed: false, resume: false })
  await t.runtime.runPromise(actions.retry("pinned"))
  await t.runtime.runPromise(actions.retryFailed)
  expect(t.calls).toHaveLength(2)
})

test("Retry failed refused stays on the page; on a device's run it does nothing", async () => {
  const t = await setup({ dispatch: Effect.succeed({ _tag: "Failed", error: { code: "nothing_failed" } }) })
  await t.runtime.runPromise(actions.retryFailed)
  expect(t.calls).toEqual([])
  await t.runtime.runPromise(t.store.view.update(VIEW, (draft) => { draft.repo = repo }))
  await t.runtime.runPromise(actions.retryFailed)
  expect(await t.view()).toMatchObject({ refusal: "nothing_failed" })
  expect(REFUSAL_WORDS.nothing_failed).toBe("Nothing failed.")
  expect(t.navigated).toEqual([])
})

test("a Retry on Cloudflare whose answer comes after the page moved on opens nothing", async () => {
  const t = await setup()
  await t.runtime.runPromise(t.store.view.update(VIEW, (draft) => { draft.repo = repo }))
  const retried = t.runtime.runPromise(actions.retry("pinned"))
  await t.runtime.runPromise(Deferred.await(t.started))
  await t.runtime.runPromise(actions.openRun("b"))
  await t.runtime.runPromise(Deferred.succeed(t.pending, { _tag: "Done", value: { runId: "ci:2" } }))
  await retried
  expect(t.navigated).toEqual([])
})

test("a repository's run whose jobs failed reads Failed and offers Retry failed, though the engine completed it", () => {
  const failure = { text: '{"state":"failure","outcome":"sent","jobs":[]}', bytes: 40, clipped: false }
  const run = { ...inspection("ci:1").run, flowName: "repo/Run", status: "completed" as const, result: failure }
  expect(headerStatusOf(run)).toBe("failed")
  expect(headerStatusOf({ ...run, result: null })).toBe("completed")
  expect(headerStatusOf({ ...run, result: { ...failure, text: "not json" } })).toBe("completed")
  expect(headerStatusOf({ ...run, result: { ...failure, clipped: true } })).toBe("completed")
  expect(headerStatusOf({ ...run, flowName: "flow/run" })).toBe("completed")
  expect(actsOf({ ...inspection("ci:1"), run }, 0, undefined, { owner: "octo", name: "hello" })).toEqual({ stop: false, retry: true, retryFailed: true, resume: false })
  expect(actsOf({ ...inspection("ci:1"), run: { ...run, result: null } }, 0, undefined, { owner: "octo", name: "hello" }).retryFailed).toBe(false)
})
