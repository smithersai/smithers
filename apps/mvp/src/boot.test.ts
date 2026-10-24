import { Effect, Fiber, Layer, ManagedRuntime, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, expect, test, vi } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { boot, logPageErrors, realServices, start } from "./boot"
import { Auth } from "./features/auth/auth"
import { AuthStore, SESSION } from "./features/auth/store"
import { Chat, type ChatView } from "./features/chat/chat"
import { storagePersisted } from "./features/chat/metrics"
import { ChatStore } from "./features/chat/store"
import { repoId, SIGN_IN_TO_CLONE } from "./features/repo/contract"
import { Repo } from "./features/repo/repo"
import { headerOf } from "./features/repo/view"
import { Theme } from "./features/theme/theme"
import { Commands } from "./features/commands/commands"
import { Views } from "./features/views/views"
import { Status } from "./features/status/status"
import { Branch } from "./features/branch/branch"
import { Terminal } from "./features/terminal/terminal"
import { Issues } from "./features/issues/issues"
import { Runs } from "./features/runs/runs"
import { FlowsUi } from "./features/flows-ui/flowsUi"
import { Home } from "./features/home/home"
import { Web } from "./features/web/web"
import { Spend } from "./features/spend/spend"
import { Attention } from "./features/attention/attention"
import { Todos } from "./features/todos/todos"
import { CodeIntel } from "./features/code-intel/codeIntel"
import { Files } from "./features/files/files"
import { Docs } from "./features/docs/docs"
import { Domains } from "./features/domains/domains"
import { PersonalModel } from "./features/personal-model/personalModel"
import { Pulls } from "./features/pulls/pulls"
import { StoragePersistence } from "@smthrs/platform-browser"
import { nodeDevice, openTab, openTestApp, TestChatApi } from "./test/chatApi"
import { inProcessWorker } from "./test/languageServer"
import { faultyServices } from "./test/faults"
import { read } from "./test/otlp"
import { PluginsUi } from "./plugins/ui"
import { Secrets } from "./features/secrets/secrets"

// The browser program and its boundary, on the app's own layer over a Node device, against ChatApi's real handler.
// Records are read back from the OTLP exports the browser sent.

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 10_000, interval: 20 })

/** How many times the boot program counted the browser's answer to keeping storage, `granted` as given. */
const persisted = (runtime: ManagedRuntime.ManagedRuntime<never, unknown>, granted: string) =>
  runtime.runSync(Metric.value(Metric.withAttributes(storagePersisted, { granted }))).count

const cmdK = () => Object.assign(new Event("keydown", { cancelable: true }), { key: "k", metaKey: true })

/** The browser app over a fresh ChatApi, its ChatApi, and its exports once every runtime has closed. */
const app = async () => {
  const runtime = openTestApp({ sessionLifecycle: false })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  const exported = async () => {
    for (const each of runtimes.splice(0).reverse()) await each.dispose()
    return read(api.telemetry)
  }
  return { runtime, api, exported }
}

const granted = StoragePersistence.make({ persist: () => Promise.resolve(true) })

test("renders the chat, sign-in, theme, repository, slash-command, views, web-page and pull-request layers, binds the keys, asks to keep the device's storage, records boot time once the device's conversation is restored, and unbinds when stopped", async () => {
  const { runtime, exported } = await app()
  const target = new EventTarget()
  const views: Array<ReadonlyArray<unknown>> = []
  const rendered: Array<ChatView> = []
  const fiber = runtime.runFork(
    boot({
      target,
      startedAt: Date.now() - 1_000,
      render: (...view) => {
        views.push(view)
        rendered.push(view[0])
      },
      storage: granted,
    }),
  )
  const store = await runtime.runPromise(Effect.service(ChatStore))
  await until(() => expect(store.history.tanstack.get("history")?.opened).toBe(true))
  await until(() => expect(rendered).toHaveLength(1))
  const layers = await runtime.runPromise(
    Effect.all([
      Effect.service(Chat),
      Effect.service(Auth),
      Effect.service(Theme),
      Effect.service(Repo),
      Effect.service(Commands),
      Effect.service(Views),
      Effect.service(Web),
      Effect.service(Status),
      Effect.service(Branch),
      Effect.service(Terminal),
      Effect.service(Issues),
      Effect.service(Runs),
      Effect.service(FlowsUi),
      Effect.service(Home),
      Effect.service(Spend),
      Effect.service(Attention),
      Effect.service(Todos),
      Effect.service(CodeIntel),
      Effect.service(Pulls),
      Effect.service(PluginsUi),
      Effect.service(Files),
      Effect.service(Secrets),
      Effect.service(Docs),
      Effect.service(Domains),
      Effect.service(PersonalModel),
    ]),
  )
  expect(views[0]).toHaveLength(layers.length)
  layers.forEach((layer, index) => expect(views[0]![index]).toBe(layer))
  await runtime.runPromise(store.composerState.preload)
  target.dispatchEvent(cmdK())
  expect(rendered[0]!.queries.composer.toArray[0]?.open).toBe(true)
  await until(() => expect(persisted(runtime, "true")).toBe(1))
  await runtime.runPromise(Fiber.interrupt(fiber))
  target.dispatchEvent(cmdK())
  expect(rendered[0]!.queries.composer.toArray[0]?.open).toBe(true)

  const records = await exported()
  expect(records.log("chat ready")).toEqual([
    expect.objectContaining({ severity: "Info", attributes: { feature: "app" } }),
  ])
  expect(records.point("smithers_web_boot_ms")?.count).toBe(1)
  expect(records.log("persistent storage requested")).toEqual([
    expect.objectContaining({ attributes: { granted: "true", feature: "app" } }),
  ])
  expect(records.points.find(({ metric }) => metric === "smithers_web_storage_persisted")?.attributes).toEqual({
    granted: "true",
  })
})

test("the repository layer: its routes open over the app's RepoApi and Electric, sign-in's row decides Clone, and Copy permalink runs repo/copy, which writes the host's clipboard", async () => {
  const server = ManagedRuntime.make(TestChatApi.layer.pipe(Layer.provideMerge(TestDatabase.layer("test_boot"))))
  runtimes.push(server)
  const api = await server.runPromise(Effect.service(TestChatApi))
  // A device whose engine leads, as a browser's does: `repo/copy` runs there and asks this tab to write its clipboard.
  const host = nodeDevice({ agent: api })
  const runtime = openTab(api, { host })
  runtimes.push(runtime)
  const [repo, signIn] = await runtime.runPromise(Effect.all([Effect.service(Repo), Effect.service(AuthStore)]))
  // What React's live query starts on first render.
  await repo.queries.view.preload()
  const view = () => repo.queries.view.toArray[0]!
  const header = () => headerOf(view().repository, view().clone, view().view.signedIn)

  // A repository nobody cloned offers Clone until sign-in's own row, the one the account shows, says nobody is in.
  repo.actions.openRoute("tree", { owner: "octocat", repo: "Hello-World" }, {})
  await until(() => expect(signIn.session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await until(() => expect(header()).toEqual({ kind: "clone" }))
  await runtime.runPromise(signIn.session.update(SESSION, (row) => void (row.status = "signed_out")))
  await until(() => expect(header()).toEqual({ kind: "sign_in", text: SIGN_IN_TO_CLONE }))

  // A ready repository reaches the tab through the app's `repositories` shape: RepoApi's proxy over Electric.
  const sha = "a".repeat(40)
  await server.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO repositories (id, owner, name, status, default_branch, head_sha)
      VALUES (${repoId("octocat", "Spoon-Knife")}, 'octocat', 'Spoon-Knife', 'ready', 'main', ${sha})`))
  repo.actions.openRoute("blob", { owner: "octocat", repo: "Spoon-Knife", ref: "main", _splat: "README.md" }, { L: 3 })
  await until(() => expect(header()).toEqual({ kind: "ready" }))
  await until(() => expect(view().view.sha).toBe(sha))
  await repo.actions.copy("permalink")
  expect(host.copied).toEqual([`${api.origin}/octocat/Spoon-Knife/blob/${sha}/README.md?L=3`])
})

/** A ChatApi of its own, with no browser on it. */
const chatApi = async () => {
  const host = ManagedRuntime.make(TestChatApi.layer.pipe(Layer.provideMerge(TestDatabase.layer("test_boot"))))
  runtimes.push(host)
  return host.runPromise(Effect.service(TestChatApi))
}

test("when the device's conversation can't be restored, it logs that, records no boot time, and keeps running", async () => {
  const api = await chatApi()
  const device = nodeDevice()
  // A database that opens, then fails every statement: the restore fails.
  const broken = {
    ...device,
    persistence: {
      ...device.persistence,
      open: () => ({ execute: () => Promise.reject(new Error("disk")), close: () => undefined }),
    },
  }
  const runtime = openTab(api, { host: broken, sessionLifecycle: false })
  runtimes.push(runtime)
  const fiber = runtime.runFork(boot({ target: new EventTarget(), startedAt: Date.now(), render: () => {}, storage: granted }))
  const store = await runtime.runPromise(Effect.service(ChatStore))
  await until(() => expect(store.messages.tanstack.status).toBe("error"))
  await until(() => expect(read(api.telemetry).log("chat couldn't restore")).toHaveLength(1))
  expect(fiber.pollUnsafe()).toBeUndefined()
  await runtime.runPromise(Fiber.interrupt(fiber))
  await runtimes.pop()!.dispose()

  const records = read(api.telemetry)
  expect(records.log("chat couldn't restore")).toEqual([
    expect.objectContaining({ severity: "Error", attributes: { feature: "app" } }),
  ])
  expect(records.log("chat ready")).toEqual([])
  expect(records.points.some(({ metric }) => metric === "smithers_web_boot_ms")).toBe(false)
})

test("a browser that won't keep the storage is counted as not granted", async () => {
  const { runtime, exported } = await app()
  const refused = StoragePersistence.make({ persist: () => Promise.resolve(false) })
  const fiber = runtime.runFork(boot({ target: new EventTarget(), startedAt: Date.now(), render: () => {}, storage: refused }))
  const store = await runtime.runPromise(Effect.service(ChatStore))
  await until(() => expect(store.history.tanstack.get("history")?.opened).toBe(true))
  await until(() => expect(persisted(runtime, "false")).toBe(1))
  await runtime.runPromise(Fiber.interrupt(fiber))
  const records = await exported()
  expect(records.points.find(({ metric }) => metric === "smithers_web_storage_persisted")?.attributes).toEqual({
    granted: "false",
  })
})

test("logs an uncaught error by name and place, and an unhandled rejection by name, never their messages", async () => {
  const { runtime, exported } = await app()
  const target = new EventTarget()
  const secret = `sentinel-${crypto.randomUUID()}`
  await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* logPageErrors(target)
    target.dispatchEvent(
      Object.assign(new Event("error"), { error: new TypeError(secret), filename: "app.js", lineno: 3, colno: 7 }),
    )
    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error(secret) }))
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new RangeError(secret) }))
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: secret }))
  })))
  target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("after the scope") }))

  const records = await exported()
  expect(records.log("page error").map(({ severity, attributes }) => ({ severity, attributes }))).toEqual([
    { severity: "Error", attributes: { name: "TypeError", source: "app.js:3:7", feature: "app" } },
    { severity: "Error", attributes: { name: "Error", feature: "app" } },
  ])
  expect(records.log("unhandled rejection").map(({ attributes }) => attributes)).toEqual([
    { name: "RangeError", feature: "app" },
    { name: "string", feature: "app" },
  ])
  expect(JSON.stringify(records.logs)).not.toContain(secret)
})

test("reload counts and logs the reload, then asks the page to reload", async () => {
  const { runtime, api, exported } = await app()
  const { actions } = await runtime.runPromise(Effect.service(Chat))
  actions.reload()
  expect(api.reloads()).toBe(1)
  const records = await exported()
  expect(records.log("page reloaded")).toEqual([
    expect.objectContaining({ severity: "Info", attributes: { feature: "app" } }),
  ])
  expect(records.point("smithers_web_page_reloads")?.value).toBe(1)
})

test("start is the boundary: it builds the one runtime, renders the chat layer once, and stops everything", async () => {
  const api = await chatApi()
  const unbound: Array<string> = []
  const bound: Array<string> = []
  const target = new (class extends EventTarget {
    override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
      bound.push(args[0])
      super.addEventListener(...args)
    }
    override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
      unbound.push(args[0])
      super.removeEventListener(...args)
    }
  })()
  const rendered: Array<ChatView> = []
  const page = { origin: api.origin, fetch: api.fetch, reload: api.reload, host: nodeDevice({ codeIntelWorker: inProcessWorker, pathname: () => "/" }) }
  const { stop } = start(
    { ...page, target, startedAt: Date.now(), render: (chat) => {
      // Auth's subscriber is attached before the page becomes interactive; chat's subscriber follows rendering.
      expect(bound.filter((event) => event === "online")).toHaveLength(1)
      rendered.push(chat)
    } },
    realServices(page),
  )
  await until(() => expect(rendered).toHaveLength(1))
  const [chat] = rendered
  // What React's live queries start on first render.
  await Promise.all([chat!.queries.connection.preload(), chat!.queries.composer.preload()])
  expect(chat!.queries.connection.toArray[0]?.status).toBe("up")
  target.dispatchEvent(cmdK())
  expect(chat!.queries.composer.toArray[0]?.open).toBe(true)
  // A Stream subscription starts its callback on a child fiber; wait for the real binding before asserting cleanup.
  await until(() => expect(bound.filter((event) => event === "online")).toHaveLength(2))
  target.dispatchEvent(new Event("offline"))
  await until(() => expect(chat!.queries.connection.toArray[0]?.status).toBe("offline"))
  target.dispatchEvent(new Event("online"))
  await until(() => expect(chat!.queries.connection.toArray[0]?.status).toBe("up"))
  await chat!.queries.history.preload()
  const history = chat!.queries.history.toArray[0]
  chat!.actions.loadEarlier()
  expect(chat!.queries.history.toArray[0]).toEqual(history)
  await stop()
  // The key bindings (the plugins' keymap among them), chat connectivity and scoped auth refresh on reconnect are all removed.
  expect(unbound.sort()).toEqual([
    "error",
    "focus",
    "focusin",
    "keydown",
    "keydown",
    "keydown",
    "keydown",
    "offline",
    "online",
    "online",
    "pageshow",
    "smithers-device-adopted",
    "unhandledrejection",
  ])
  expect(chat!.queries.conversation.status).toBe("cleaned-up")
})

test("start takes faulty services in place of the real ones, as the end-to-end entry gives them", async () => {
  const api = await chatApi()
  const page = { origin: api.origin, fetch: api.fetch, reload: api.reload, host: nodeDevice() }
  const rendered: Array<ChatView> = []
  const { stop } = start(
    { ...page, mac: false, target: new EventTarget(), startedAt: Date.now(), render: (chat) => rendered.push(chat) },
    faultyServices(page, (shapes) => shapes.refuse(400)),
  )
  await until(() => expect(rendered).toHaveLength(1))
  await rendered[0]!.queries.connection.preload()
  await until(() => expect(rendered[0]!.queries.connection.toArray[0]).toMatchObject({ status: "failed", retry: true }))
  await stop()
})
