import { PendingSnapshot } from "@smthrs/platform-browser"
// Your own flows and this device's runs from a tab (docs/features/flows.md#the-browser, docs/features/runs.md): the
// browser's own layer (`appLayer`) on a Node device whose engine leads, against ChatApi's real handler and the compose
// Postgres and Electric (src/test/chatApi.ts). A person drafts a flow, answers its question, saves it, runs it, watches
// its run page, stops a run and retries one, and opens, edits and saves its code. The model is the only scripted piece:
// each model call waits for the test's answer.
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { nodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { Chat } from "../chat/chat"
import { RunsNavigation } from "../runs/actions"
import { RUNS_PATH } from "../runs/contract"
import { graphOf } from "../runs/graph"
import type { Inspection } from "../runs/schema"
import { listRows, retriesFrom } from "../runs/page"
import { Runs } from "../runs/runs"
import { codeSaveable, formReady, savedRefusal, writtenRefusal } from "./actions"
import { codePath, draftFailureWords, draftPath, FLOWS_PATH, NEW_FLOW_PATH, writeRefusalWords } from "./contract"
import { type RunStatus, shownRound } from "./round"
import { FlowsUi } from "./flowsUi"
import { awaitEditorWrites, hasPendingEditorWrites } from "./editorWrites"
import { placementOf, renderSource, SOURCE_PATH } from "./source"
import { FlowsUiStore } from "./store"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long a flow may take on the device's engine, its first start included, on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 60_000) => vi.waitFor(assertion, { timeout, interval: 25 })

/** A test's budget: several flows, each with model calls, on a fresh device's engine, on a loaded machine. */
const WITHIN = 180_000

/** What a run of `hello` asks the model: its instructions, which the drafting prompt never holds. */
const RUN_TASK = "Greet the person warmly."

const drafted = (overrides: Record<string, unknown> = {}) => ({
  description: "Say hello.",
  instructions: RUN_TASK,
  flows: [],
  questions: [],
  summary: "Says hello.",
  ...overrides,
})

/** ChatApi, and a tab on a device whose engine leads, with your flows and runs started as React starts them. */
const open = async () => {
  const app = openTestApp()
  runtimes.push(app)
  const api = await app.runPromise(Effect.service(TestChatApi))
  const host = nodeDevice({ agent: api })
  const tab = openTab(api, { host })
  runtimes.push(tab)
  const flows = await tab.runPromise(Effect.service(FlowsUi))
  const runs = await tab.runPromise(Effect.service(Runs))
  for (const query of [...Object.values(flows.queries), ...Object.values(runs.queries)]) query.startSyncImmediate()
  /** The last path this tab went to that starts with `prefix`. */
  const went = (prefix: string) => host.navigated.filter((path) => path.startsWith(prefix)).at(-1)
  return {
    api,
    host,
    runtime: tab,
    flows,
    runs,
    went,
    /** Answers the `nth` model call whose task includes `task` with one cell of `source`. */
    reply: async (task: string, source: string, nth?: number) =>
      (await app.runPromise(api.answerTo(task, nth))).cell(source),
    draft: () => flows.queries.draft.toArray[0],
    page: () => runs.queries.page.toArray[0],
    inspection: () => runs.queries.page.toArray[0]?.page.inspection as Inspection | undefined,
  }
}

type Tab = Awaited<ReturnType<typeof open>>

test("a PWA reload restores an unfinished flow request and its unsent answer from device storage", async () => {
  const t = await open()
  const draftId = crypto.randomUUID()
  t.flows.queries.form.startSyncImmediate()
  t.flows.actions.setName("kept")
  await until(() => expect(t.flows.queries.form.toArray[0]?.name).toBe("kept"))
  t.flows.actions.setRequest("Keep this request")
  t.flows.actions.setAnswer(draftId, "question", "Keep this answer")
  await awaitEditorWrites()
  await until(() => expect(t.host.stored("flow-answers")).toBe(1))
  await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "kept", request: "Keep this request" }))
  expect(t.host.stored("flow-form")).toBe(1)
  expect(t.host.stored("flow-answers")).toBe(1)
  await t.runtime.dispose()

  const reloaded = openTab(t.api, { host: t.host })
  runtimes.push(reloaded)
  const flows = await reloaded.runPromise(Effect.service(FlowsUi))
  flows.queries.form.startSyncImmediate()
  flows.queries.answers.startSyncImmediate()
  await flows.actions.openNew(undefined)
  await until(() => expect(flows.queries.form.toArray[0]).toMatchObject({ name: "kept", request: "Keep this request" }))
  expect(flows.queries.answers.toArray).toContainEqual(expect.objectContaining({
    id: `${t.host.editorTabId}:${draftId}:question`, tabId: t.host.editorTabId, draftId, questionId: "question", value: "Keep this answer",
  }))
  await flows.actions.openNew("another")
  expect(flows.queries.form.toArray[0]).toMatchObject({ name: "kept", request: "Keep this request" })
  flows.actions.setRequest("")
  await awaitEditorWrites()
  await flows.actions.openNew("another")
  await until(() => expect(flows.queries.form.toArray[0]).toMatchObject({ name: "another", request: "" }))
  await flows.actions.openNew(undefined)
  flows.actions.setName("same")
  await until(() => expect(flows.queries.form.toArray[0]).toMatchObject({ name: "same", seeded: false }))
  await flows.actions.openNew("same")
  await flows.actions.openNew("same")
  await flows.actions.openNew(undefined)
  await until(() => expect(flows.queries.form.toArray[0]).toMatchObject({ name: "", seeded: false }))
}, WITHIN)

test("two tabs keep separate unfinished flow requests and answers through reload", async () => {
  const t = await open()
  const otherHost = { ...t.host, editorTabId: crypto.randomUUID() }
  const other = openTab(t.api, { host: otherHost })
  runtimes.push(other)
  const otherFlows = await other.runPromise(Effect.service(FlowsUi))
  for (const query of [t.flows.queries.form, t.flows.queries.answers, otherFlows.queries.form, otherFlows.queries.answers]) query.startSyncImmediate()
  const draftId = crypto.randomUUID()
  t.flows.actions.setName("first")
  t.flows.actions.setAnswer(draftId, "question", "first answer")
  otherFlows.actions.setName("second")
  otherFlows.actions.setAnswer(draftId, "question", "second answer")
  await until(() => expect(t.host.stored("flow-form")).toBe(2))
  await until(() => expect(t.host.stored("flow-answers")).toBe(2))
  await until(() => expect(t.flows.queries.form.toArray[0]?.name).toBe("first"))
  await until(() => expect(otherFlows.queries.form.toArray[0]?.name).toBe("second"))
  expect(t.flows.queries.answers.toArray[0]?.value).toBe("first answer")
  expect(otherFlows.queries.answers.toArray[0]?.value).toBe("second answer")
  await other.dispose()
  await t.runtime.dispose()

  const firstReload = openTab(t.api, { host: t.host })
  const secondReload = openTab(t.api, { host: otherHost })
  runtimes.push(firstReload, secondReload)
  const first = await firstReload.runPromise(Effect.service(FlowsUi))
  const second = await secondReload.runPromise(Effect.service(FlowsUi))
  for (const query of [first.queries.form, first.queries.answers, second.queries.form, second.queries.answers]) query.startSyncImmediate()
  await until(() => expect(first.queries.form.toArray[0]?.name).toBe("first"))
  await until(() => expect(second.queries.form.toArray[0]?.name).toBe("second"))
  expect(first.queries.answers.toArray[0]?.value).toBe("first answer")
  expect(second.queries.answers.toArray[0]?.value).toBe("second answer")
}, WITHIN)

test("a late code keystroke cannot replace a pending editor stash or leave the returned editor blank", async () => {
  const t = await open()
  const isolated = ManagedRuntime.make(FlowsUiStore.layer({
    origin: t.api.origin, editorTabId: t.host.editorTabId, editorTabPersistent: t.host.editorTabPersistent,
  }).pipe(Layer.provideMerge(Layer.succeedContext(await t.runtime.context()))))
  runtimes.push(isolated)
  const store = await isolated.runPromise(Effect.service(FlowsUiStore))
  // The editor's rows restore in the background; its row exists once it is ready.
  expect(await isolated.runPromise(store.editorReady)).toBe(true)
  await isolated.runPromise(store.code.update(store.codeId, (row) => {
    row.name = "first"
    row.state = "read"
    row.source = "current source"
    row.text = "retained edit"
  }))
  const release = await isolated.runPromise(Deferred.make<void>())
  let holdFirstReceipt = true
  let updates = 0
  const delayedCode = new Proxy(store.code, { get(target, key) {
    if (key !== "update") return Reflect.get(target, key)
    return (...args: Parameters<typeof target.update>) => {
      updates += 1
      return target.update(...args).pipe(Effect.map((write) => {
        if (!holdFirstReceipt) return write
        holdFirstReceipt = false
        return { ...write, persisted: Deferred.await(release).pipe(Effect.andThen(write.persisted)) }
      }))
    }
  } })
  const delayedStore = FlowsUiStore.of({ ...store, code: delayedCode })
  const ui = ManagedRuntime.make(FlowsUi.layer.pipe(
    Layer.provide(Layer.succeed(FlowsUiStore, delayedStore)),
    Layer.provideMerge(Layer.succeedContext(await t.runtime.context())),
    Layer.provide(Layer.succeed(RunsNavigation, RunsNavigation.of({ navigate: t.host.navigate }))),
  ))
  runtimes.push(ui)
  const flows = await ui.runPromise(Effect.service(FlowsUi))
  const switching = flows.actions.openCode("second")
  await until(async () => expect(await isolated.runPromise(store.code.get(store.codeId))).toMatchObject({
    value: { name: "first", state: "loading", text: "retained edit" },
  }))
  flows.actions.editCode("first", "late input")
  await until(() => expect(updates).toBe(2))
  expect(await isolated.runPromise(store.code.get(store.codeId))).toMatchObject({
    value: { name: "first", text: "retained edit" },
  })
  const returning = flows.actions.openCode("first")
  await isolated.runPromise(Deferred.succeed(release, undefined))
  await Promise.all([switching, returning])
  expect(await isolated.runPromise(store.code.get(store.codeId))).toMatchObject({
    value: { name: "first", state: "read", text: "retained edit" },
  })
}, WITHIN)

test("leaving an editor replaces a stash retained by an interrupted earlier departure", async () => {
  const t = await open()
  const runtime = ManagedRuntime.make(FlowsUiStore.layer({
    origin: t.api.origin, editorTabId: t.host.editorTabId, editorTabPersistent: t.host.editorTabPersistent,
  }).pipe(Layer.provideMerge(Layer.succeedContext(await t.runtime.context()))))
  runtimes.push(runtime)
  const store = await runtime.runPromise(Effect.service(FlowsUiStore))
  expect(await runtime.runPromise(store.editorReady)).toBe(true)
  const stashId = `${store.codeId}:draft:first`
  // A recovered editor can have both its active row and an older departure's persisted stash.
  await runtime.runPromise(Effect.gen(function* () {
    yield* (yield* store.code.update(store.codeId, (row) => Object.assign(row, {
      name: "first", state: "read" as const, source: "source", text: "latest edit",
    }))).persisted
    yield* (yield* store.code.insert({
      id: stashId, name: "first", state: "read", revision: 0, source: "source", text: "older edit", busy: false, refusal: null,
    })).persisted
  }))
  const ui = ManagedRuntime.make(FlowsUi.layer.pipe(
    Layer.provide(Layer.succeed(FlowsUiStore, store)),
    Layer.provideMerge(Layer.succeedContext(await t.runtime.context())),
    Layer.provide(Layer.succeed(RunsNavigation, RunsNavigation.of({ navigate: t.host.navigate }))),
  ))
  runtimes.push(ui)
  const flows = await ui.runPromise(Effect.service(FlowsUi))
  await flows.actions.openCode("second")
  expect(t.host.storedRows("flow-code")).toContainEqual(expect.objectContaining({ id: stashId, text: "latest edit" }))
  await flows.actions.openCode("first")
  expect(await runtime.runPromise(store.code.get(store.codeId))).toMatchObject({ value: { name: "first", text: "latest edit" } })
  expect(t.host.storedRows("flow-code")).not.toContainEqual(expect.objectContaining({ id: stashId }))
}, WITHIN)

test("a pending form snapshot survives reload before its device receipt", async () => {
  const t = await open()
  t.flows.queries.form.startSyncImmediate()
  await t.flows.actions.openNew(undefined)
  const values = new Map<string, string>()
  const snapshot = PendingSnapshot.make({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }, "pending-form")
  const row = t.flows.queries.form.toArray[0]!
  snapshot.stage({ ...row, request: "Last input before reload" })
  await t.runtime.dispose()
  const reloaded = openTab(t.api, { host: { ...t.host, formSnapshot: snapshot } })
  runtimes.push(reloaded)
  const flows = await reloaded.runPromise(Effect.service(FlowsUi))
  flows.queries.form.startSyncImmediate()
  await flows.actions.openNew(undefined)
  await until(() => expect(flows.queries.form.toArray[0]?.request).toBe("Last input before reload"))
  expect(snapshot.read()).toBeUndefined()
  flows.actions.setRequest("Next input")
  // Staging happens synchronously at the input boundary, before awaiting its Effect.
  expect(snapshot.read()?.value).toMatchObject({ request: "Next input" })
  await awaitEditorWrites()
  await until(() => expect(snapshot.read()).toBeUndefined())
}, WITHIN)

test.each(["new-tab", "invalid", "foreign-tab"] as const)("pending form snapshot: %s", async (kind) => {
  const t = await open()
  await t.flows.actions.openNew(undefined)
  t.flows.queries.form.startSyncImmediate()
  const row = t.flows.queries.form.toArray[0]!
  const id = crypto.randomUUID()
  const values = new Map<string, string>()
  const snapshot = PendingSnapshot.make({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }, "pending-form")
  snapshot.stage(kind === "invalid" ? { request: 12 } : {
    ...row, id: kind === "foreign-tab" ? row.id : row.id.replace(t.host.editorTabId, id), request: "Recovered input",
  })
  const isolated = openTab(t.api, { host: { ...t.host, editorTabId: id, formSnapshot: snapshot } })
  runtimes.push(isolated)
  const flows = await isolated.runPromise(Effect.service(FlowsUi))
  flows.queries.form.startSyncImmediate()
  await flows.actions.openNew(undefined)
  await until(() => expect(flows.queries.form.toArray[0]?.request).toBe(kind === "new-tab" ? "Recovered input" : ""))
  expect(snapshot.read() === undefined).toBe(kind === "new-tab")
}, WITHIN)

test("an unretained tab identity allows session edits without blocking chat", async () => {
  const t = await open()
  const unretained = openTab(t.api, {
    host: { ...t.host, editorTabId: crypto.randomUUID(), editorTabPersistent: false, editorTabRefusal: "lock_held" },
  })
  runtimes.push(unretained)
  const flows = await unretained.runPromise(Effect.service(FlowsUi))
  flows.queries.editor.startSyncImmediate()
  flows.queries.form.startSyncImmediate()
  await flows.actions.openNew(undefined)
  await until(() => expect(flows.queries.editor.toArray[0]?.state).toBe("session"))
  flows.actions.setRequest("Session edit")
  await awaitEditorWrites()
  await until(() => expect(flows.queries.form.toArray[0]?.request).toBe("Session edit"))
  expect(t.host.storedRows("flow-form")).not.toContainEqual(expect.objectContaining({ request: "Session edit" }))
  expect(await unretained.runPromise(Effect.service(Chat))).toBeDefined()
  const unexplained = openTab(t.api, { host: { ...t.host, editorTabId: crypto.randomUUID(), editorTabPersistent: false } })
  runtimes.push(unexplained)
  const other = await unexplained.runPromise(Effect.service(FlowsUi))
  other.queries.editor.startSyncImmediate()
  await other.actions.openNew(undefined)
  await until(() => expect(other.queries.editor.toArray[0]?.state).toBe("session"))
}, WITHIN)

test("a database open failure allows session edits and leaves stored text intact", async () => {
  const t = await open()
  t.flows.queries.form.startSyncImmediate()
  t.flows.actions.setRequest("Retained on device")
  await until(() => expect(t.host.storedRows("flow-form")).toContainEqual(expect.objectContaining({ request: "Retained on device" })))
  await t.runtime.dispose()
  const failedHost = { ...t.host, persistence: { ...t.host.persistence,
    open: async () => { throw new Error("database unavailable") },
  } }
  const failed = openTab(t.api, { host: failedHost })
  runtimes.push(failed)
  const flows = await failed.runPromise(Effect.service(FlowsUi))
  flows.queries.editor.startSyncImmediate()
  flows.queries.form.startSyncImmediate()
  await flows.actions.openNew(undefined)
  await until(() => expect(flows.queries.editor.toArray[0]?.state).toBe("session"))
  flows.actions.setRequest("Memory-only edit")
  await awaitEditorWrites()
  await until(() => expect(flows.queries.form.toArray[0]?.request).toBe("Memory-only edit"))
  expect(t.host.storedRows("flow-form")).not.toContainEqual(expect.objectContaining({ request: "Memory-only edit" }))
  expect(await failed.runPromise(Effect.service(Chat))).toBeDefined()
  await failed.dispose()
  const recovered = openTab(t.api, { host: t.host })
  runtimes.push(recovered)
  const restored = await recovered.runPromise(Effect.service(FlowsUi))
  restored.queries.form.startSyncImmediate()
  restored.queries.editor.startSyncImmediate()
  await until(() => expect(restored.queries.editor.toArray[0]?.state).toBe("available"))
  await until(() => expect(restored.queries.form.toArray[0]?.request).toBe("Retained on device"))
}, WITHIN)

test("the app is up before the editors' rows are restored, and an edit made meanwhile lands once they are", async () => {
  const t = await open()
  await t.runtime.dispose()
  // The form's rows come back from the device only when the test says so.
  let release!: () => void
  const held = new Promise<void>((resolve) => void (release = resolve))
  const originalMake = t.host.persistence.make
  const heldHost = { ...t.host, persistence: { ...t.host.persistence,
    make: (database: Parameters<typeof originalMake>[0], coordinator: Parameters<typeof originalMake>[1]) => {
      const normal = originalMake(database, coordinator)
      return { ...normal, resolvePersistenceForCollection: (selection: { collectionId: string; mode: "sync-absent" | "sync-present"; schemaVersion?: number }) => {
        const resolved = normal.resolvePersistenceForCollection?.(selection) ?? normal
        const waiting = (adapter: object): object => new Proxy(adapter, { get: (target, property) => {
          const value = Reflect.get(target, property)
          if ((property === "loadResumeSnapshot" || property === "loadSubset") && typeof value === "function") {
            return (...args: Array<unknown>) => held.then(() => value.apply(target, args))
          }
          if (property === "runInHydrationScope" && typeof value === "function") {
            return (task: (scoped: object) => Promise<unknown>) => value.call(target, (scoped: object) => task(waiting(scoped)))
          }
          return typeof value === "function" ? value.bind(target) : value
        } })
        return selection.collectionId === "flow-form"
          ? { ...resolved, adapter: waiting(resolved.adapter) as typeof resolved.adapter }
          : resolved
      } }
    },
  } }
  const tab = openTab(t.api, { host: heldHost })
  runtimes.push(tab)
  const flows = await tab.runPromise(Effect.service(FlowsUi))
  expect(await tab.runPromise(Effect.service(Chat))).toBeDefined()
  await flows.queries.editor.preload()
  expect(flows.queries.editor.toArray[0]?.state).toBe("restoring")
  flows.actions.setRequest("Typed while restoring")
  // The edit holds the update's reload until it is stored, through the restore it waits for.
  await until(() => expect(hasPendingEditorWrites()).toBe(true))
  release()
  await until(() => expect(flows.queries.editor.toArray[0]?.state).toBe("available"))
  await until(() => expect(t.host.storedRows("flow-form")).toContainEqual(expect.objectContaining({ request: "Typed while restoring" })))
  await awaitEditorWrites()
  expect(hasPendingEditorWrites()).toBe(false)
}, WITHIN)

test.each(["flow-form", "flow-answers", "flow-code"])("a %s restore failure keeps retained text and leaves chat usable", async (failedCollection) => {
  const t = await open()
  const draftId = await draftHello(t)
  await until(() => expect(t.draft()?.draft.status).toBe("ready"))
  t.flows.actions.save()
  await until(() => expect(t.flows.queries.flows.toArray).toMatchObject([{ name: "hello", revision: 1 }]))
  await t.flows.actions.openCode("hello")
  const source = t.flows.queries.code.toArray[0]!.source
  const edited = `${source}\n// Retained code edit`
  t.flows.actions.editCode("hello", edited)
  t.flows.actions.setAnswer(draftId, "question", "Retained answer")
  t.flows.actions.setRequest("Retained request")
  await awaitEditorWrites()
  await until(() => expect(t.flows.queries.form.toArray[0]?.request).toBe("Retained request"))
  await until(() => expect(t.host.storedRows("flow-form")).toContainEqual(expect.objectContaining({ request: "Retained request" })))
  const retained = Object.fromEntries(["flow-form", "flow-answers", "flow-code"].map((id) => [id, t.host.storedRows(id)]))
  expect(retained["flow-answers"]).toContainEqual(expect.objectContaining({ value: "Retained answer" }))
  expect(retained["flow-code"]).toContainEqual(expect.objectContaining({ text: edited }))
  await t.runtime.dispose()

  const originalMake = t.host.persistence.make
  const selected: string[] = []
  const brokenHost = { ...t.host, persistence: { ...t.host.persistence,
    make: (database: Parameters<typeof originalMake>[0], coordinator: Parameters<typeof originalMake>[1]) => {
      const normal = originalMake(database, coordinator)
      return { ...normal, resolvePersistenceForCollection: (selection: { collectionId: string; mode: "sync-absent" | "sync-present"; schemaVersion?: number }) => {
        selected.push(selection.collectionId)
        const resolved = normal.resolvePersistenceForCollection?.(selection) ?? normal
        const blocked = (adapter: object): object => new Proxy(adapter, { get: (target, property) => {
          if (property === "loadResumeSnapshot" || property === "loadSubset") return () => Promise.reject(new Error("disk"))
          const value = Reflect.get(target, property)
          if (property === "runInHydrationScope" && typeof value === "function") {
            return (task: (scoped: object) => Promise<unknown>) => value.call(target, (scoped: object) => task(blocked(scoped)))
          }
          return typeof value === "function" ? value.bind(target) : value
        } })
        return selection.collectionId === failedCollection
          ? { ...resolved, adapter: blocked(resolved.adapter) as typeof resolved.adapter }
          : resolved
      } }
    },
  } }
  const broken = openTab(t.api, { host: brokenHost })
  runtimes.push(broken)
  const flows = await broken.runPromise(Effect.service(FlowsUi))
  // The editors' rows restore after the app is up, and a failed one leaves the editors unavailable.
  flows.queries.editor.startSyncImmediate()
  await until(() => expect(selected).toContain(failedCollection))
  await until(() => expect(flows.queries.editor.toArray[0]?.state).toBe("unavailable"))
  expect(await broken.runPromise(Effect.service(Chat))).toBeDefined()
  flows.actions.setRequest("Must not replace retained request")
  flows.actions.setAnswer(draftId, "question", "Must not replace retained answer")
  flows.actions.editCode("hello", "Must not replace retained code")
  await awaitEditorWrites()
  await broken.dispose()
  for (const [id, rows] of Object.entries(retained)) expect(t.host.storedRows(id)).toEqual(rows)

  const recovered = openTab(t.api, { host: t.host })
  runtimes.push(recovered)
  const restored = await recovered.runPromise(Effect.service(FlowsUi))
  for (const query of [restored.queries.form, restored.queries.answers, restored.queries.code, restored.queries.editor]) query.startSyncImmediate()
  await until(() => expect(restored.queries.editor.toArray[0]?.state).toBe("available"))
  await until(() => expect(restored.queries.form.toArray[0]?.request).toBe("Retained request"))
  expect(restored.queries.answers.toArray).toContainEqual(expect.objectContaining({ draftId, questionId: "question", value: "Retained answer" }))
  await restored.actions.openCode("hello")
  expect(restored.queries.code.toArray[0]).toMatchObject({ name: "hello", source, text: edited, state: "read", refusal: null })
}, WITHIN)

test("two tabs keep separate unsaved code edits through a PWA reload and revision check", async () => {
  const t = await open()
  await draftHello(t)
  await until(() => expect(t.draft()?.draft.status).toBe("ready"))
  t.flows.actions.save()
  await until(() => expect(t.flows.queries.flows.toArray).toMatchObject([{ name: "hello", revision: 1 }]))
  await t.flows.actions.openCode("hello")
  const source = t.flows.queries.code.toArray[0]!.source
  const edited = source.replace("Say hello.", "Say hello again.")
  expect(edited).not.toBe(source)
  t.flows.actions.editCode("hello", edited)
  await until(() => expect(t.flows.queries.code.toArray[0]?.text).toBe(edited))
  await t.flows.actions.openCode("nothing")
  await until(() => expect(t.flows.queries.code.toArray[0]?.name).toBe("nothing"))
  await t.flows.actions.openCode("hello")
  await until(() => expect(t.flows.queries.code.toArray[0]).toMatchObject({ name: "hello", text: edited }))
  // A PWA update waits for both tabs' editor writes before it reloads them.
  await awaitEditorWrites()
  const otherHost = { ...t.host, editorTabId: crypto.randomUUID() }
  const other = openTab(t.api, { host: otherHost })
  runtimes.push(other)
  const otherFlows = await other.runPromise(Effect.service(FlowsUi))
  otherFlows.queries.code.startSyncImmediate()
  await otherFlows.actions.openCode("hello")
  const otherEdited = source.replace("Say hello.", "Say hello from another tab.")
  otherFlows.actions.editCode("hello", otherEdited)
  await until(() => expect(otherFlows.queries.code.toArray[0]?.text).toBe(otherEdited))
  await awaitEditorWrites()
  await until(() => expect(t.host.stored("flow-code")).toBe(2))
  await other.dispose()
  await t.runtime.dispose()

  const reloaded = openTab(t.api, { host: t.host })
  runtimes.push(reloaded)
  const flows = await reloaded.runPromise(Effect.service(FlowsUi))
  flows.queries.flows.startSyncImmediate()
  flows.queries.code.startSyncImmediate()
  await flows.actions.openCode("hello")
  await until(() => expect(flows.queries.code.toArray[0]).toMatchObject({
    name: "hello", state: "read", revision: 1, source, text: edited, refusal: null,
  }))
  const otherReload = openTab(t.api, { host: otherHost })
  runtimes.push(otherReload)
  const otherRestored = await otherReload.runPromise(Effect.service(FlowsUi))
  otherRestored.queries.flows.startSyncImmediate()
  otherRestored.queries.code.startSyncImmediate()
  await otherRestored.actions.openCode("hello")
  await until(() => expect(otherRestored.queries.code.toArray[0]).toMatchObject({
    name: "hello", state: "read", revision: 1, source, text: otherEdited, refusal: null,
  }))
  await otherRestored.actions.saveCode()
  await until(() => expect(otherRestored.queries.flows.toArray[0]?.revision).toBe(2))
  await flows.actions.saveCode()
  await until(() => expect(flows.queries.code.toArray[0]).toMatchObject({
    revision: 2, source: otherEdited, text: edited, refusal: "stale",
  }))
  await flows.actions.openCode("hello")
  expect(flows.queries.code.toArray[0]?.refusal).toBe("stale")
  await flows.actions.saveCode()
  expect(flows.queries.flows.toArray[0]?.revision).toBe(2)
  expect(flows.queries.code.toArray[0]?.refusal).toBe("stale")
  await flows.actions.saveCode(true)
  await until(() => expect(flows.queries.flows.toArray[0]?.revision).toBe(3))
  expect(flows.queries.code.toArray[0]).toMatchObject({ revision: 3, source: edited, text: edited, refusal: null })
}, WITHIN)

test("a fresh persisted device opens a ready draft written through the API before navigation", async () => {
  const t = await open()
  const draftId = crypto.randomUUID()
  const name = `mobile-${draftId}`
  const source = renderSource({ name, description: "Mobile layout", instructions: "Answer ready.", flows: [] })
  const saved = await t.api.fetch(`${t.api.origin}/api/flow-drafts/${draftId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      scope: "person", round: 0, request: "Answer ready.", name, status: "ready", summary: "Mobile layout",
      files: [{ path: SOURCE_PATH, text: source }], checks: [{ check: "parses", ok: true }], questions: [], failure: null, flowId: null,
    }),
  })
  expect(saved.status).toBe(200)
  const runtime = openTab(t.api, { host: nodeDevice({ agent: t.api }) })
  runtimes.push(runtime)
  const flows = await runtime.runPromise(Effect.service(FlowsUi))
  flows.queries.draft.startSyncImmediate()
  await flows.actions.openDraft(draftId)
  await until(() => expect(flows.queries.draft.toArray[0]?.draft).toMatchObject({
    id: draftId, status: "ready", name, files: [{ path: SOURCE_PATH, text: source }], checks: [{ check: "parses", ok: true }],
  }))
}, WITHIN)

test("Runs warms the real device's engine without opening its page, then opens the warmed list", async () => {
  const t = await open()
  await t.runs.actions.warmList()
  expect(t.runs.queries.view.toArray[0]).toMatchObject({ listOpen: false, listReady: true })
  await t.runs.actions.openList()
  expect(t.runs.queries.view.toArray[0]).toMatchObject({ listOpen: true, listReady: true })
  expect(t.runs.queries.runs.toArray).toEqual([])
}, WITHIN)

/** Drafts `hello` from the form to ready: the draft's id. */
const draftHello = async (t: Tab, draft = drafted(), nth?: number) => {
  t.flows.actions.setName("hello")
  t.flows.actions.setRequest("Say hello")
  await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello", request: "Say hello" }))
  const before = t.went("/app/flows/drafts/")
  t.flows.actions.startDraft()
  await until(() => expect(t.went("/app/flows/drafts/")).not.toBe(before))
  const draftId = t.went("/app/flows/drafts/")!.split("/").at(-1)!
  await t.reply("The flow's name: hello", `ctx.done(${JSON.stringify(draft)})`, nth)
  await t.flows.actions.openDraft(draftId)
  return draftId
}

describe("the form", () => {
  test("Draft needs a name a flow of yours may take and something it should do", () => {
    expect(formReady({ name: "hello", request: "Say hello" })).toBe(true)
    expect(formReady({ name: "hello", request: "  " })).toBe(false)
    expect(formReady({ name: "Hello", request: "Say hello" })).toBe(false)
    expect(formReady({ name: "theme", request: "Say hello" })).toBe(false)
    expect(formReady({ name: "hello", request: "x".repeat(4097) })).toBe(false)
  })

  test("a code page saves only read, changed, non-empty code with no write in flight; refusals read by their code", () => {
    const read = { state: "read" as const, busy: false, source: "a", text: "b" }
    expect(codeSaveable(read)).toBe(true)
    expect(codeSaveable({ ...read, text: "a" })).toBe(false)
    expect(codeSaveable({ ...read, text: "  " })).toBe(false)
    expect(codeSaveable({ ...read, busy: true })).toBe(false)
    expect(codeSaveable({ ...read, state: "loading" })).toBe(false)
    expect(writtenRefusal({ _tag: "@smthrs/mvp/flows/FlowInvalid", check: "name" })).toBe("check:name")
    expect(writtenRefusal({ _tag: "@smthrs/mvp/flows/FlowsRefused", code: "stale" })).toBe("stale")
    expect(writtenRefusal({ _tag: "@smthrs/mvp/flows/FlowNotFound" })).toBe("not_found")
    expect(writtenRefusal({ _tag: "@smthrs/mvp/flows/FlowsUnavailable" })).toBe("unavailable")
    expect(writeRefusalWords("check:name")).toBe("Check failed: name")
    expect(writeRefusalWords("stale")).toBe("Changed since you opened it")
    expect(writeRefusalWords("teapot")).toBe("teapot")
    expect(codePath("release-notes")).toBe("/app/flows/code/release-notes")
  })

  test("a card shows its row, unless this device's run of its round ended without writing it", () => {
    const draft = { id: "d", round: 1, status: "drafting" as const, failure: null }
    const run = (status: RunStatus, runId = "d:1") => ({ runId, status })
    const drafting = { status: "drafting", failure: null, retry: false }
    expect(shownRound(draft, undefined)).toEqual(drafting)
    for (const status of ["pending", "running", "suspended", "completed", "absent"] as const) {
      expect([status, shownRound(draft, run(status))]).toEqual([status, drafting])
    }
    expect(shownRound(draft, run("cancelled"))).toEqual({ status: "failed", failure: "stopped", retry: true })
    expect(shownRound(draft, run("failed"))).toEqual({ status: "failed", failure: "ended", retry: true })
    // Another round's run, or none read yet, says nothing about this one.
    expect(shownRound(draft, run("cancelled", "d:0"))).toEqual(drafting)
    expect(shownRound(draft, { runId: null, status: "absent" })).toEqual(drafting)
    // A row past drafting is what it says; only a failed one offers Draft again.
    expect(shownRound({ ...draft, status: "ready" as const }, run("failed"))).toEqual({ status: "ready", failure: null, retry: false })
    expect(shownRound({ ...draft, status: "failed" as const, failure: "quota" }, run("completed")))
      .toEqual({ status: "failed", failure: "quota", retry: true })
  })

  test("a failed round reads by its code; one it doesn't know reads as itself", () => {
    expect(draftFailureWords("rate_limited")).toBe("Model busy. Try again.")
    expect(draftFailureWords("stopped")).toBe("Stopped")
    expect(draftFailureWords("draft")).toBe("Couldn't draft")
    expect(draftFailureWords("toString")).toBe("toString")
    expect(draftFailureWords("teapot")).toBe("teapot")
  })

  test("a refused Save reads by its code", () => {
    expect(savedRefusal({ _tag: "@smthrs/mvp/flows/NameTaken" })).toBe("name_taken")
    expect(savedRefusal({ _tag: "@smthrs/mvp/flows/DraftNotReady", code: "checks" })).toBe("checks")
    expect(savedRefusal({ _tag: "@smthrs/mvp/flows/FlowsUnavailable" })).toBe("unavailable")
  })
})

describe("a flow of your own, from a tab", () => {
  test("Draft, Save, Run: the run page follows the run to its answer, and Retry opens a new run", async () => {
    const t = await open()
    // An empty form drafts nothing.
    t.flows.actions.startDraft()
    const draftId = await draftHello(t)
    await until(() => expect(t.draft()?.draft).toMatchObject({ id: draftId, status: "ready", name: "hello" }))
    expect(host(t).navigated.filter((path) => path.startsWith("/app/flows/drafts/"))).toHaveLength(1)

    t.flows.actions.save()
    await until(() => expect(t.went(FLOWS_PATH)).toBe(FLOWS_PATH))
    await until(() => expect(t.flows.queries.flows.toArray.map((flow) => flow.name)).toEqual(["hello"]))
    // A saved draft leaves the drafts list.
    await until(() => expect(t.flows.queries.drafts.toArray).toEqual([]))
    const flow = t.flows.queries.flows.toArray[0]!

    t.flows.actions.run(flow.name, flow.revision)
    await until(() => expect(t.went(`${RUNS_PATH}/`)).toBeDefined())
    const runId = decodeURIComponent(t.went(`${RUNS_PATH}/`)!.slice(RUNS_PATH.length + 1))
    await t.runs.actions.openRun(runId)
    await t.reply(RUN_TASK, 'ctx.done("Hello.")')
    await until(() => expect(t.inspection()?.run).toMatchObject({ status: "completed", result: { text: '"Hello."' } }))

    // The steps tab, a step, the timeline, and the journal with More.
    t.runs.actions.showTab("journal")
    await until(() => expect(t.page()?.view.tab).toBe("journal"))
    t.runs.actions.more()
    const step = t.inspection()!.steps.find((each) => each.action === "flow/run/load")!
    t.runs.actions.select(`step:${step.nodeId}`)
    await until(() => expect(t.page()?.view.selected).toBe(`step:${step.nodeId}`))

    // Replay and inspector controls affect only this tab, and returning live reads the current run.
    t.runs.actions.scrub(0)
    await until(() => expect(t.page()?.view.at).toBe(0))
    t.runs.actions.inspectStep(`step:${step.nodeId}`)
    await until(() => expect(t.page()?.view).toMatchObject({ selected: `step:${step.nodeId}`, inspectorOpen: true }))
    t.runs.actions.showInspector(false)
    await until(() => expect(t.page()?.view.inspectorOpen).toBe(false))
    t.runs.actions.scrub(null)
    await until(() => expect(t.page()?.view.at).toBeNull())

    t.runs.actions.retry("pinned")
    await until(() => expect(t.went(`${RUNS_PATH}/retry%3A`)).toBeDefined())
    await t.reply(RUN_TASK, 'ctx.done("Hello again.")', 1)
    const retried = decodeURIComponent(t.went(`${RUNS_PATH}/retry%3A`)!.slice(RUNS_PATH.length + 1))
    expect(retried).toBe(`retry:${runId}:1/run`)
    await t.runs.actions.openRun(retried)
    await until(() => expect(t.inspection()?.run).toMatchObject({ status: "completed", result: { text: '"Hello again."' } }))
    // Retry the first run again: the second retry, a run of its own.
    await t.runs.actions.openRun(runId)
    await until(() => expect(t.inspection()?.run.runId).toBe(runId))
    t.runs.actions.retry("current")
    await until(() => expect(t.went(`${RUNS_PATH}/retry%3A${encodeURIComponent(runId)}%3A2`)).toBeDefined())
    await t.reply(RUN_TASK, 'ctx.done("Hello a third time.")', 2)
    // Retry from here on the first run's code: its load replays, its code runs again, as the third retry.
    await t.runs.actions.openRun(runId)
    await until(() => expect(t.inspection()?.run.runId).toBe(runId))
    const code = t.inspection()!.steps.find((each) => each.action === "flow/run/code")!
    expect([...retriesFrom(t.inspection()!)]).toEqual([code.nodeId])
    t.runs.actions.retryFrom(code.nodeId)
    await until(() => expect(t.went(`${RUNS_PATH}/retry%3A${encodeURIComponent(runId)}%3A3`)).toBeDefined())
    await t.reply(RUN_TASK, 'ctx.done("Hello from here.")', 3)
    await t.runs.actions.openRun(`retry:${runId}:3/run`)
    await until(() => expect(t.inspection()?.run).toMatchObject({ status: "completed", result: { text: '"Hello from here."' } }))

    // The list: both runs of hello, newest first, and no act on a run.
    await t.runs.actions.openList()
    await until(() => expect(listRows(t.runs.queries.runs.toArray).map((row) => row.id)).toEqual(expect.arrayContaining([runId, retried])))
    expect(listRows(t.runs.queries.runs.toArray).some((row) => row.flow.startsWith("run/"))).toBe(false)

    // Edit opens a new draft of it; Delete removes it.
    t.flows.actions.edit("hello")
    await until(() => expect(t.went(NEW_FLOW_PATH)).toBe(`${NEW_FLOW_PATH}?name=hello`))
    await t.flows.actions.openNew("hello")
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello", request: "" }))
    await t.flows.actions.openNew(undefined)
    // New flow clears an untouched name seeded by Edit; a typed form is kept instead.
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "", request: "" }))
    t.flows.actions.remove(flow.id)
    await until(() => expect(t.flows.queries.flows.toArray).toEqual([]))
  }, WITHIN)

  test("Needs you: Answer with the blocking question's shown default drafts round 1 with it", async () => {
    const t = await open()
    await draftHello(t, drafted({
      questions: [
        { text: "Which greeting?", assumed: "Hello", blocking: true },
        { text: "Say it twice?", assumed: "no", blocking: false },
      ],
    }))
    await until(() => expect(t.draft()?.draft.status).toBe("needs_you"))
    // The person changed nothing: Answer takes the default without deleting any stored answer rows.
    expect(t.flows.queries.answers.toArray).toEqual([])
    expect(t.host.stored("flow-answers")).toBe(0)
    t.flows.actions.answer()
    // Round 1 drafts with that answer: its model request is the one that says so.
    await t.reply("The person answered:\n- Which greeting? Hello", `ctx.done(${JSON.stringify(drafted())})`)
    await until(() => expect(t.draft()?.draft).toMatchObject({ status: "ready", round: 1 }))
    expect(t.api.modelRequests("- Say it twice?")).toBe(0)
    await awaitEditorWrites()
    expect(t.host.stored("flow-answers")).toBe(0)
  }, WITHIN)

  test("a question the draft asked: the person's answer starts the next round", async () => {
    const t = await open()
    const draftId = await draftHello(t, drafted({
      questions: [{ text: "Which greeting?", assumed: "Hello", blocking: true }],
    }))
    await until(() => expect(t.draft()?.draft.status).toBe("needs_you"))
    t.flows.actions.setAnswer(draftId, "r0q1", "Hi")
    t.flows.actions.setAnswer(draftId, "r0q1", "Howdy")
    await until(() =>
      expect(t.flows.queries.answers.toArray.map(({ id, questionId, value }) => ({ id, questionId, value }))).toEqual([
        { id: `${t.host.editorTabId}:${draftId}:r0q1`, questionId: "r0q1", value: "Howdy" },
      ])
    )
    t.flows.actions.answer()
    await t.reply("The flow's name: hello", `ctx.done(${JSON.stringify(drafted())})`, 1)
    await until(() => expect(t.draft()?.draft).toMatchObject({ status: "ready", round: 1 }))
    await until(() => expect(t.flows.queries.answers.toArray).toEqual([]))
  }, WITHIN)

  test("two Draft presses before the first is admitted make one draft, drafted once", async () => {
    const t = await open()
    t.flows.actions.setName("hello")
    t.flows.actions.setRequest("Say hello")
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello", request: "Say hello" }))
    t.flows.actions.startDraft()
    t.flows.actions.startDraft()
    await until(() => expect(t.went("/app/flows/drafts/")).toBeDefined())
    const draftId = t.went("/app/flows/drafts/")!.split("/").at(-1)!
    await t.reply("The flow's name: hello", `ctx.done(${JSON.stringify(drafted())})`)
    await until(() => expect(t.flows.queries.drafts.toArray.map((draft) => [draft.id, draft.status])).toEqual([[draftId, "ready"]]))
    expect(t.api.modelRequests("The flow's name: hello")).toBe(1)
    expect(new Set(host(t).navigated.filter((path) => path.startsWith("/app/flows/drafts/")))).toEqual(new Set([draftPath(draftId)]))
    // The form took a new draft id for the next one.
    expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "", request: "" })
    expect(t.flows.queries.form.toArray[0]!.draftId).not.toBe(draftId)
  }, WITHIN)

  test("Stop the round's run: the card reads Failed, Stopped; Draft again drafts the next round to Ready", async () => {
    const t = await open()
    t.flows.actions.setName("hello")
    t.flows.actions.setRequest("Say hello")
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello" }))
    t.flows.actions.startDraft()
    await until(() => expect(t.went("/app/flows/drafts/")).toBeDefined())
    const draftId = t.went("/app/flows/drafts/")!.split("/").at(-1)!
    await t.flows.actions.openDraft(draftId)
    // The drafting model call is in flight and never answered; the round's row says drafting.
    await until(() => expect(t.api.modelRequests("The flow's name: hello")).toBe(1))
    await until(() => expect(t.draft()?.draft).toMatchObject({ id: draftId, status: "drafting", round: 0 }))
    // Nothing settled yet: the card reads Drafting, with no Draft again.
    await until(() => expect(t.flows.queries.round.toArray[0]).toMatchObject({ runId: `${draftId}:0`, status: "running" }))
    expect(shownRound(t.draft()!.draft, t.flows.queries.round.toArray[0])).toEqual({ status: "drafting", failure: null, retry: false })
    // Stop the round from its run page: its run ends cancelled before it wrote the draft.
    await t.runs.actions.openRun(`${draftId}:0`)
    await until(() => expect(t.inspection()?.run.status).toBe("running"))
    t.runs.actions.stop()
    await until(() => expect(t.flows.queries.round.toArray[0]).toMatchObject({ runId: `${draftId}:0`, status: "cancelled" }))
    expect(t.draft()?.draft.status).toBe("drafting")
    expect(shownRound(t.draft()!.draft, t.flows.queries.round.toArray[0])).toEqual({ status: "failed", failure: "stopped", retry: true })
    expect(draftFailureWords("stopped")).toBe("Stopped")

    t.flows.actions.draftAgain()
    await t.reply("The flow's name: hello", `ctx.done(${JSON.stringify(drafted())})`, 1)
    await until(() => expect(t.draft()?.draft).toMatchObject({ id: draftId, status: "ready", round: 1 }))
    await until(() => expect(t.flows.queries.round.toArray[0]).toMatchObject({ runId: `${draftId}:1`, status: "completed" }))
    expect(shownRound(t.draft()!.draft, t.flows.queries.round.toArray[0])).toEqual({ status: "ready", failure: null, retry: false })
  }, WITHIN)

  test("Delete a draft whose round still drafts: its round stops and it leaves the drafts list", async () => {
    const t = await open()
    t.flows.actions.setName("hello")
    t.flows.actions.setRequest("Say hello")
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello" }))
    t.flows.actions.startDraft()
    await until(() => expect(t.went("/app/flows/drafts/")).toBeDefined())
    const draftId = t.went("/app/flows/drafts/")!.split("/").at(-1)!
    await t.flows.actions.openDraft(draftId)
    await until(() => expect(t.api.modelRequests("The flow's name: hello")).toBe(1))
    await until(() => expect(t.flows.queries.drafts.toArray.map((draft) => draft.id)).toEqual([draftId]))
    const before = host(t).navigated.length
    t.flows.actions.deleteDraft(draftId)
    await until(() => expect(host(t).navigated.length).toBeGreaterThan(before))
    expect(t.went(FLOWS_PATH)).toBe(FLOWS_PATH)
    await until(() => expect(t.flows.queries.drafts.toArray).toEqual([]))
    await t.runs.actions.openRun(`${draftId}:0`)
    await until(() => expect(t.inspection()?.run.status).toBe("cancelled"))
    // Its page now shows no draft, and no round.
    await t.flows.actions.openDraft(draftId)
    expect(t.flows.queries.round.toArray[0]).toMatchObject({ runId: null, status: "absent" })
  }, WITHIN)

  test("Save refuses a name another of your flows took meanwhile", async () => {
    const t = await open()
    const first = await draftHello(t)
    await until(() => expect(t.draft()?.draft).toMatchObject({ id: first, status: "ready" }))
    const second = await draftHello(t, drafted(), 1)
    await until(() => expect(t.draft()?.draft).toMatchObject({ id: second, status: "ready" }))
    await t.flows.actions.openDraft(first)
    t.flows.actions.save()
    await until(() => expect(t.flows.queries.flows.toArray).toHaveLength(1))
    await t.flows.actions.openDraft(second)
    t.flows.actions.save()
    await until(() => expect(t.draft()?.shown).toMatchObject({ refusal: "name_taken", busy: false }))
  }, WITHIN)

  test("Stop on a live run: it ends cancelled, and Resume on it is refused, settled", async () => {
    const t = await open()
    // No run open: the acts and More do nothing.
    t.runs.actions.stop()
    t.runs.actions.more()
    await draftHello(t)
    await until(() => expect(t.draft()?.draft.status).toBe("ready"))
    t.flows.actions.save()
    await until(() => expect(t.flows.queries.flows.toArray).toHaveLength(1))
    const flow = t.flows.queries.flows.toArray[0]!
    t.flows.actions.run(flow.name, flow.revision)
    await until(() => expect(t.went(`${RUNS_PATH}/`)).toBeDefined())
    const runId = decodeURIComponent(t.went(`${RUNS_PATH}/`)!.slice(RUNS_PATH.length + 1))
    await t.runs.actions.openRun(runId)
    // The model call is in flight and never answered: the run is live.
    await until(() => expect(t.api.modelRequests(RUN_TASK)).toBe(1))
    await until(() => expect(t.inspection()?.run.status).toBe("running"))
    // A live run has nothing to retry yet.
    t.runs.actions.retry("pinned")
    await until(() => expect(t.page()?.view).toMatchObject({ acting: null, refusal: "not_settled" }))
    t.runs.actions.stop()
    await until(() => expect(t.inspection()?.run.status).toBe("cancelled"))
    // The engine's events can show the run cancelled before Stop's own flow has answered; then the act clears.
    await until(() => expect(t.page()?.view).toMatchObject({ acting: null, refusal: null }))
    t.runs.actions.resume()
    await until(() => expect(t.page()?.view.refusal).toBe("settled"))
    // A run this device's engine never held reads as on another device.
    await t.runs.actions.openRun("nothing-here")
    await until(() => expect(t.page()?.page.state).toBe("not_found"))
    // Nothing read of it: no act on it.
    t.runs.actions.stop()
    expect(t.page()?.view).toMatchObject({ acting: null, refusal: null })
  }, WITHIN)
})

describe("a flow's code, from a tab", () => {
  test("Code reads it, an edited step label saves and runs in the realm; code that needs a machine fails before the model", async () => {
    const t = await open()
    await draftHello(t)
    await until(() => expect(t.draft()?.draft.status).toBe("ready"))
    t.flows.actions.save()
    await until(() => expect(t.flows.queries.flows.toArray).toMatchObject([{ name: "hello", placement: "client" }]))

    await t.flows.actions.openCode("hello")
    const drafted = renderSource({ name: "hello", description: "Say hello.", flows: [], instructions: RUN_TASK })
    expect(t.flows.queries.code.toArray[0]).toMatchObject({ name: "hello", state: "read", revision: 1, source: drafted, text: drafted })
    // Unchanged code doesn't save.
    await t.flows.actions.saveCode()

    // A check that fails stays on the page, by its code.
    t.flows.actions.editCode("hello", drafted.replace(`Flow.make("hello"`, `Flow.make("goodbye"`))
    await until(() => expect(t.flows.queries.code.toArray[0]?.text).toContain(`Flow.make("goodbye"`))
    await t.flows.actions.saveCode()
    await until(() => expect(t.flows.queries.code.toArray[0]).toMatchObject({ busy: false, refusal: "check:name" }))

    /** Saves `source` as the open flow's next revision, back on the Flows page, where it reads `placement`. */
    const saved = async (source: string, revision: number, placement: string) => {
      t.flows.actions.editCode("hello", source)
      await until(() => expect(t.flows.queries.code.toArray[0]?.text).toBe(source))
      const before = host(t).navigated.length
      await t.flows.actions.saveCode()
      await until(() => expect(host(t).navigated.length).toBeGreaterThan(before))
      expect(t.went(FLOWS_PATH)).toBe(FLOWS_PATH)
      await until(() => expect(t.flows.queries.flows.toArray).toMatchObject([{ revision, placement }]))
      expect(t.flows.queries.code.toArray[0]).toMatchObject({ busy: false, refusal: null, revision, source })
    }
    /** Runs revision `revision` and opens its run page: the run's id. */
    const ran = async (revision: number) => {
      const before = t.went(`${RUNS_PATH}/`)
      t.flows.actions.run("hello", revision)
      await until(() => expect(t.went(`${RUNS_PATH}/`)).not.toBe(before))
      const runId = decodeURIComponent(t.went(`${RUNS_PATH}/`)!.slice(RUNS_PATH.length + 1))
      await t.runs.actions.openRun(runId)
      return runId
    }

    // A relabelled step is the person's code: it runs in the realm, and the agent gets the prompt its code rendered.
    const relabelled = drafted.replace(`"hello/agent"`, `"hello/greet"`)
    expect(placementOf(relabelled)).toBe("client")
    await saved(relabelled, 2, "client")
    await ran(2)
    await t.reply(RUN_TASK, 'ctx.done("Hi.")')
    await until(() => expect(t.inspection()?.run).toMatchObject({ status: "completed", result: { text: '"Hi."' } }))
    // Its run page shows the realm's steps under the run: the code, its evaluations, its host call and the agent's step.
    await until(() =>
      expect(graphOf(t.page()!.page as never, null, Date.now()).steps.map((step) => step.row.label)).toEqual(
        expect.arrayContaining(["hello/load", "hello/code", "hello/evaluate", "hello/call", "hello/agent"]),
      )
    )

    // Code that needs a machine: its run fails before any model call.
    const machine = `import { readFile } from "node:fs/promises"\n${relabelled}`
    expect(placementOf(machine)).toBe("sandbox")
    await t.flows.actions.openCode("hello")
    await saved(machine, 3, "sandbox")
    await ran(3)
    await until(() => expect(t.inspection()?.run.status).toBe("failed"))
    expect(JSON.stringify(t.inspection()!.run.result)).toContain("FlowNeedsSandbox")
    expect(t.api.modelRequests(RUN_TASK)).toBe(1)
  }, WITHIN)

  test("a flow you don't have reads not found; a read that ends after the tab moved on changes nothing", async () => {
    const t = await open()
    await t.flows.actions.openCode("nothing")
    expect(t.flows.queries.code.toArray[0]).toMatchObject({ name: "nothing", state: "not_found" })
    await Promise.all([t.flows.actions.openCode("first"), t.flows.actions.openCode("second")])
    expect(t.flows.queries.code.toArray[0]).toMatchObject({ name: "second", state: "not_found" })
  }, WITHIN)
})

/** The tab's device. */
const host = (t: Tab) => t.host
