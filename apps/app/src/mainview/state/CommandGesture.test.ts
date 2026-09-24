import { afterEach,expect,test } from "bun:test"
import type { AppController,AppServices } from "./AppController"
import { createAppStore,type AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

const restorations: Array<() => void> = []
const controllers: AppController[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) await Promise.resolve(controller.dispose()).catch(() => {})
  for (const restore of restorations.splice(0).reverse()) restore()
})
const replaceGlobal = (key: string, value: unknown) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  restorations.push(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key) })
}
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { resolve, promise }
}
const fixture = async (services: AppServices = {}, reject = false) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() }, { seedWiki: false })
  if (services.bootstrap?.host === "local" || services.bootstrap?.authFlow === "native-handoff") await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  const held = gate()
  const observed: AppStore = { ...store, dispatch: transition => {
    const transaction = store.dispatch(transition)
    if (transition.type !== "command.intent.accepted") return transaction
    return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise).then(() => { if (reject) throw new Error("receipt failed") }) }
      : Reflect.get(target, key, receiver) })
  } }
  const controller = createAppController(observed, silentAgent, services)
  controllers.push(controller)
  return { controller, held }
}
const bootstrap = (host: "cloud" | "local") => ({ apiVersion: 1 as const, host, version: "test", buildSha: "test", capabilities: ["identity" as const], authFlow: "none" as const, sandbox: { platform: "darwin" as const, mode: "enforced" as const } })
const popupFixture = () => {
  const opened: string[] = []
  const popup = { opener: {} as unknown, closed: false, location: { href: "about:blank" }, close: () => { popup.closed = true } }
  replaceGlobal("window", { open: (url: string) => { opened.push(url); return popup }, location: { origin: "http://local.test" } })
  return { popup, opened }
}

for (const outcome of ["accepted", "rejected", "dismissed"] as const) test(`Chat accepts typing before its receipt; ${outcome} controls later microphone capture`, async () => {
  let starts = 0
  replaceGlobal("SpeechRecognition", class {
    start() { starts++ }
    abort() {}
  })
  const { controller, held } = await fixture({}, outcome === "rejected")
  await controller.store.dispatch({ type: "input.mode.changed", actor: "user", mode: "dictation" }).isPersisted.promise
  const pending = controller.commands.run("chat.open")
  expect(controller.store.session().paletteOpen).toBe(true)
  controller.store.dispatch({ type: "composer.changed", actor: "user", draft: "/account.show" })
  expect(starts).toBe(0)
  if (outcome === "dismissed") controller.closePalette()
  held.resolve()
  expect((await pending).status).toBe(outcome === "rejected" ? "failed" : "executed")
  expect(starts).toBe(outcome === "accepted" ? 1 : 0)
  expect(controller.store.session().draft).toBe("/account.show")
  expect(controller.store.session().paletteOpen).toBe(outcome !== "dismissed")
})

test("the actual download door reserves its window synchronously and navigates only after acceptance", async () => {
  const { controller, held } = await fixture({ bootstrap: bootstrap("cloud"), downloadUrl: "https://downloads.test/app" })
  const { popup, opened } = popupFixture()
  const pending = controller.commands.run("app.download")
  expect(opened).toEqual(["about:blank"])
  expect(popup.location.href).toBe("about:blank")
  expect(popup.opener).toBeNull()
  held.resolve()
  expect((await pending).status).toBe("executed")
  expect(popup.location.href).toBe("https://downloads.test/app")
  expect(popup.closed).toBe(false)
})

test("a rejected download intent closes its empty reservation and never navigates", async () => {
  const { controller, held } = await fixture({ bootstrap: bootstrap("cloud"), downloadUrl: "https://downloads.test/app" }, true)
  const { popup, opened } = popupFixture()
  const pending = controller.commands.run("app.download")
  expect(opened).toEqual(["about:blank"])
  held.resolve()
  expect(await pending).toMatchObject({ status: "failed", persistenceFailed: true })
  expect(popup.location.href).toBe("about:blank")
  expect(popup.closed).toBe(true)
})

for (const host of ["local", "cloud"] as const) test(`the ${host} OAuth handoff reserves before commit and starts only afterward`, async () => {
  const requests: string[] = []
  const { controller, held } = await fixture({ bootstrap: { ...bootstrap(host), authFlow: "native-handoff" }, handoffPollMs: 1,
    fetchImpl: async input => {
      const url = String(input); requests.push(url)
      return url.includes("/native/start") ? Response.json({ handoffId: "test-handoff", pollSecret: "private-poll-secret" }) : Response.json({}, { status: 404 })
    } })
  const { popup, opened } = popupFixture()
  const pending = controller.commands.run("auth.sign-in")
  expect(opened).toEqual(["about:blank"])
  expect(requests).toEqual([])
  held.resolve()
  expect((await pending).status).toBe("executed")
  expect(requests.some(url => url.includes("/native/start"))).toBe(true)
  expect(popup.location.href).toContain("handoff=test-handoff")
  expect(popup.closed).toBe(false)
})

for (const rejected of [false, true]) test(`clipboard bytes ${rejected ? "never change on failed" : "wait for successful"} acceptance`, async () => {
  const { controller, held } = await fixture({}, rejected)
  let clipboard = "original"
  let writes = 0
  class DeferredClipboardItem { constructor(readonly values: Record<string, Promise<Blob>>) {} }
  replaceGlobal("ClipboardItem", DeferredClipboardItem)
  replaceGlobal("navigator", { clipboard: {
    write: async (items: DeferredClipboardItem[]) => { writes++; const blob = await items[0]!.values["text/plain"]!; clipboard = await blob.text() },
    writeText: async () => { throw new Error("activation was not reserved") }
  } })
  const pending = controller.commands.run("chat.copy-message", "new copied text")
  expect(writes).toBe(1)
  expect(clipboard).toBe("original")
  held.resolve()
  expect((await pending).status).toBe(rejected ? "failed" : "executed")
  await Promise.resolve()
  expect(clipboard).toBe(rejected ? "original" : "new copied text")
})

test("a copy form reserves activation at Submit and passes it through the nested named door", async () => {
  const { controller, held } = await fixture()
  controller.renderFlowForm({ name: "chat.copy-message", args: undefined, via: "user" })
  await controller.setFormField("form-chat.copy-message", "text", "form copied text")
  let clipboard = "original"
  let writes = 0
  class DeferredClipboardItem { constructor(readonly values: Record<string, Promise<Blob>>) {} }
  replaceGlobal("ClipboardItem", DeferredClipboardItem)
  replaceGlobal("navigator", { clipboard: {
    write: async (items: DeferredClipboardItem[]) => { writes++; clipboard = await (await items[0]!.values["text/plain"]!).text() },
    writeText: async () => { throw new Error("nested submission lost activation") }
  } })
  const pending = controller.commands.run("form.submit", "form-chat.copy-message")
  expect(writes).toBe(1)
  expect(clipboard).toBe("original")
  held.resolve()
  expect((await pending).status).toBe("executed")
  expect(writes).toBe(1)
  expect(clipboard).toBe("form copied text")
})
