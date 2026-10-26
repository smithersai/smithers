// Delayed Effect services wrap real collections and dispatches. A late read or persistence receipt must never
// overwrite the next editor; the underlying storage, API and durable engine are the real app's Node services.
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { nodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { RunsNavigation } from "../runs/actions"
import { deleteDraft, editCode, openCode, openDraft, save, saveCode } from "./actions"
import { FlowsUiStore, SHOWN } from "./store"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const open = async () => {
  const app = openTestApp()
  runtimes.push(app)
  const api = await app.runPromise(Effect.service(TestChatApi))
  const host = nodeDevice({ agent: api })
  const tab = openTab(api, { host })
  runtimes.push(tab)
  const runtime = ManagedRuntime.make(FlowsUiStore.layer({
    origin: api.origin, editorTabId: host.editorTabId, editorTabPersistent: true,
  }).pipe(Layer.provideMerge(Layer.succeedContext(await tab.context()))))
  runtimes.push(runtime)
  const store = await runtime.runPromise(Effect.service(FlowsUiStore))
  // The editor's rows restore in the background; its rows exist once it is ready.
  expect(await runtime.runPromise(store.editorReady)).toBe(true)
  const dispatch = await runtime.runPromise(Effect.service(FlowDispatch))
  const run = <A, E>(effect: Effect.Effect<A, E, FlowsUiStore | FlowDispatch | RunsNavigation>, faulty = store, flows = dispatch) =>
    runtime.runPromise(effect.pipe(
      Effect.provideService(FlowsUiStore, faulty),
      Effect.provideService(FlowDispatch, flows),
      Effect.provideService(RunsNavigation, { navigate: host.navigate, pathname: () => "/app/conversations" }),
    ))
  return { api, host, runtime, store, dispatch, run }
}

const gate = async () => {
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  return {
    entered: () => Effect.runPromise(Deferred.await(entered)),
    release: () => Effect.runPromise(Deferred.succeed(release, undefined)),
    wait: Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
  }
}

type Operation = "get" | "insert" | "update" | "delete" | "before-update"
const cases = [
  { stage: "outgoing editor hide", op: "update", at: 1, name: "first", state: "read", text: "source", action: "open" },
  { stage: "outgoing stash receipt", op: "insert", at: 1, name: "first", state: "loading", text: "edited", action: "open" },
  { stage: "same-name snapshot read", op: "get", at: 1, name: "loser", state: "read", text: "edited", action: "open" },
  { stage: "incoming stash read", op: "get", at: 2, name: "", state: "loading", text: "source", action: "open" },
  { stage: "incoming stash restore", op: "update", at: 1, name: "", state: "loading", text: "source", action: "open", stash: true },
  { stage: "incoming stash removal", op: "delete", at: 1, name: "", state: "loading", text: "source", action: "open", stash: true },
  { stage: "new editor loading receipt", op: "update", at: 1, name: "", state: "loading", text: "source", action: "open" },
  { stage: "save snapshot read", op: "get", at: 1, name: "first", state: "read", text: "edited", action: "save" },
  { stage: "save busy receipt", op: "update", at: 1, name: "first", state: "read", text: "edited", action: "save" },
  { stage: "queued keystroke transaction", op: "before-update", at: 1, name: "first", state: "read", text: "source", action: "edit" },
] as const

test.each(cases)("navigation wins over a delayed $stage", async (scenario) => {
  const t = await open()
  const { store } = t
  await t.runtime.runPromise(Effect.gen(function* () {
    yield* (yield* store.code.update(store.codeId, (row) => Object.assign(row, {
      name: scenario.name, state: scenario.state, source: "source", text: scenario.text,
    }))).persisted
    yield* (yield* store.code.insert({
      id: `${store.codeId}:draft:winner`, name: "winner", state: "read", revision: 0,
      source: "base", text: "winning edit", busy: false, refusal: null,
    })).persisted
    if ("stash" in scenario) yield* (yield* store.code.insert({
      id: `${store.codeId}:draft:loser`, name: "loser", state: "read", revision: 0,
      source: "base", text: "retained", busy: false, refusal: null,
    })).persisted
  }))
  const held = await gate()
  let calls = 0
  const pause = <A, E, R>(op: Operation, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tap(effect, () => op === scenario.op && ++calls === scenario.at ? held.wait : Effect.void)
  const code = { ...store.code,
    get: (key: string) => pause("get", store.code.get(key)),
    insert: (...args: Parameters<typeof store.code.insert>) => store.code.insert(...args).pipe(
      Effect.map((write) => ({ ...write, persisted: pause("insert", write.persisted) }))),
    update: (...args: Parameters<typeof store.code.update>) =>
      Effect.andThen(pause("before-update", Effect.void), store.code.update(...args)).pipe(
        Effect.map((write) => ({ ...write, persisted: pause("update", write.persisted) }))),
    delete: (...args: Parameters<typeof store.code.delete>) => store.code.delete(...args).pipe(
      Effect.map((write) => ({ ...write, persisted: pause("delete", write.persisted) }))),
  }
  const action = scenario.action === "open" ? openCode("loser")
    : scenario.action === "save" ? saveCode() : editCode("first", "late keystroke", store.codeEpoch.current)
  const delayed = t.run(action, { ...store, code })
  try {
    await held.entered()
    await t.run(openCode("winner"))
  } finally {
    await held.release()
  }
  await delayed
  expect(await t.runtime.runPromise(store.code.get(store.codeId))).toMatchObject({
    value: { name: "winner", state: "read", text: "winning edit", busy: false, refusal: "not_found" },
  })
  expect(await t.runtime.runPromise(store.code.get(`${store.codeId}:draft:winner`))).toMatchObject({ _tag: "None" })
}, 60_000)

test.each(["read", "save"])("a late %s dispatch cannot attach its refusal to the next editor", async (action) => {
  const t = await open()
  const { store } = t
  await t.runtime.runPromise(store.code.update(store.codeId, (row) => Object.assign(row, {
    name: "absent", state: "read" as const, revision: 1, source: "before", text: "edited",
  })))
  const held = await gate()
  const faulty = FlowDispatch.of({ dispatch: (name, payload, options) =>
    t.dispatch.dispatch(name, payload, options).pipe(Effect.onExit(() => held.wait)),
  })
  const saving = t.run(action === "save" ? saveCode() : openCode("absent"), store, faulty)
  try {
    await held.entered()
    await t.run(openCode("winner"))
  } finally { await held.release() }
  await saving
  expect(await t.runtime.runPromise(store.code.get(store.codeId))).toMatchObject({
    value: { name: "winner", state: "not_found", refusal: null, busy: false },
  })
})

test("a stale expected opening leaves the current editor alone", async () => {
  const t = await open()
  await t.run(openCode("winner"))
  const before = await t.runtime.runPromise(t.store.code.get(t.store.codeId))
  await t.run(openCode("loser", t.store.codeEpoch.current - 1))
  expect(await t.runtime.runPromise(t.store.code.get(t.store.codeId))).toEqual(before)
})


test("a late draft save and a refused deletion leave the next draft's refusal alone", async () => {
  const t = await open()
  const draftId = crypto.randomUUID()
  const written = await t.api.fetch(`${t.api.origin}/api/flow-drafts/${draftId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      scope: "person", round: 0, name: "unfinished", request: "Draft this flow", status: "drafting",
      summary: null, files: [], checks: [], questions: [], failure: null, flowId: null,
    }),
  })
  expect(written.status).toBe(200)
  await t.runtime.runPromise(t.store.drafts.awaitRow((row) => row.id === draftId, "30 seconds"))
  await t.run(openDraft(draftId))
  const held = await gate()
  const delayed = FlowDispatch.of({ dispatch: (name, payload, options) =>
    t.dispatch.dispatch(name, payload, options).pipe(Effect.onExit(() => held.wait)),
  })
  const saving = t.run(save, t.store, delayed)
  const nextId = crypto.randomUUID()
  try {
    await held.entered()
    await t.run(openDraft(nextId))
  } finally { await held.release() }
  await saving
  const refused = FlowDispatch.of({ dispatch: () => Effect.fail(new DispatchFailed({
    flow: "flow/draft/delete", reason: "refused",
  })) })
  await t.run(deleteDraft(draftId), t.store, refused)
  const navigated = [...t.host.navigated]
  await t.run(deleteDraft(draftId))
  await vi.waitFor(async () => expect(await t.runtime.runPromise(t.store.drafts.get(draftId))).toMatchObject({ _tag: "None" }), { timeout: 30_000 })
  expect(t.host.navigated).toEqual(navigated)
  expect(await t.runtime.runPromise(t.store.shown.get(SHOWN))).toMatchObject({
    value: { draftId: nextId, refusal: null, busy: false },
  })
})
