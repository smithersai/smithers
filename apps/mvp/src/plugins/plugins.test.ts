// The plugin host on a tab, driven as React and the window drive it: the built-in queue loaded through the public
// loader, its tab built from `PluginHost` alone, the host's action strip and keys answering the agent's real waits. Each
// device runs the browser's own layer (`appLayer`) on a Node device (src/test/chatApi.ts) whose engine leads, against
// ChatApi's real handler over the compose Postgres and Electric; only the model is scripted. Proves decision 0017 slice
// 1's host contract and its trust boundaries at run time (docs/features/plugins.md).
import { Host } from "@smthrs/plugin"
import { Cause, Effect, Exit, Fiber, Metric, Stream } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import queue from "../../plugins/queue/plugin.json" with { type: "json" }
import type { QueueTab } from "../../plugins/queue/src/tab"
import { Chat } from "../features/chat/chat"
import { StatusStore } from "../features/status/store"
import { dispatches } from "../flows/dispatch"
import { nodeDevice, openTab, openTestApp, TestChatApi } from "../test/chatApi"
import { read as readTelemetry } from "../test/otlp"
import type { BuiltIn } from "./builtin"
import { pluginKeys } from "./keymap"
import { hostFor, loads, pathOf, Plugins, presses, settledOf, viewAt, viewById } from "./plugins"
import { draftKey } from "./schema"
import { PluginsUi } from "./ui"

const ENGINE_WITHIN = 90_000
const VIEW = "queue/queue"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 60_000) =>
  vi.waitFor(assertion, { timeout, interval: 20 })

const openApi = async () => {
  const runtime = openTestApp({ answers: false })
  runtimes.push(runtime)
  return runtime.runPromise(Effect.service(TestChatApi))
}

/** A window for the keymap, and a field inside it: a key pressed in the field reaches the window from it. */
class Window extends EventTarget {}
class Field {
  closest() {
    return this
  }
}

/** A key event as a browser makes one. */
const keydown = (key: string, modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}) =>
  Object.assign(new Event("keydown", { cancelable: true }), { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers })

const openDevice = async (api: TestChatApi["Service"]) => {
  const runtime = openTab(api, { host: nodeDevice({ agent: api }) })
  runtimes.push(runtime)
  const chat = await runtime.runPromise(Effect.service(Chat))
  const store = await runtime.runPromise(Effect.service(StatusStore))
  const plugins = await runtime.runPromise(Effect.service(PluginsUi))
  store.waits.tanstack.startSyncImmediate()
  plugins.queries.views.startSyncImmediate()
  plugins.queries.notes.startSyncImmediate()
  const window = new Window()
  const keys = runtime.runFork(Effect.scoped(Effect.andThen(pluginKeys(window, true), Effect.never)))
  runtimes.push({ dispose: () => runtime.runPromise(Fiber.interrupt(keys)).then(() => undefined) })
  const ask = async (text: string, need: string) => {
    const asked = (await chat.actions.ask(text))
    if (!asked.asked) throw new Error(`refused: ${asked.reason}`)
    const reply = await Effect.runPromise(api.answerTo(text))
    reply.cell(`const heard = await ctx.call("app/agent/ask", ${need})\nconsole.log(JSON.stringify(heard))`)
    await until(() => expect(store.waits.tanstack.toArray.some((row) => row.runId === asked.answerId)).toBe(true))
    return asked.answerId
  }
  return {
    runtime,
    store,
    plugins,
    window,
    ask,
    press: (key: string, modifiers?: Parameters<typeof keydown>[1], from?: Field) => {
      const event = keydown(key, modifiers)
      if (from !== undefined) Object.defineProperty(event, "target", { value: from })
      window.dispatchEvent(event)
      return event.defaultPrevented
    },
    state: () => plugins.queries.views.toArray.find((row) => row.id === VIEW),
    /** The strip's note for the item it selected, if it holds one. */
    note: () => {
      const item = plugins.queries.views.toArray.find((row) => row.id === VIEW)?.item
      return plugins.queries.notes.toArray.find((row) => item != null && row.id === draftKey(VIEW, item))?.text
    },
    run: (id: string) => store.runs.tanstack.toArray.find((row) => row.id === id),
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>) => runtime.runSync(Metric.value(metric)).count,
  }
}

const question = (word: string) => `{ kind: "question", prompt: "Deploy which branch for ${word}?", options: ["main", "docs-v2"] }`

describe("the plugin host", { timeout: ENGINE_WITHIN }, () => {
  test("loads the queue, whose tab and the host's strip answer the agent's question; the run goes on", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    // The built-ins, ordered by their dependencies, then id (src/plugins/builtin.ts).
    expect(a.plugins.contributions.plugins.map((plugin) => plugin.id)).toEqual(["bugs", "factory", "queue"])
    expect(a.count(Metric.withAttributes(loads, { outcome: "active", tier: "built-in", reason: "none" }))).toBe(3)

    const answerId = await a.ask("Deploy the preview", question("preview"))
    const tab = (await a.plugins.actions.tab("queue")) as QueueTab
    // Built once: the same tab on every use.
    expect(await a.plugins.actions.tab("queue")).toBe(tab)
    expect(tab.queries.current.current()).toMatchObject({ index: 0, total: 1, item: { runId: answerId, options: ["main", "docs-v2"] } })
    await until(() => expect(a.state()).toMatchObject({ query: "core/waits", item: answerId }))

    const view = viewById(a.plugins.contributions, VIEW)!
    const strip = a.plugins.actions.strip(view, tab.queries.current.current().item as never)
    const docs = strip.buttons.find((button) => button.label === "docs-v2")!
    const reply = strip.buttons.find((button) => button.event === "reply")!

    // A note longer than the event's payload allows never leaves the strip; the strip says it wasn't sent.
    a.plugins.actions.setDraft(VIEW, "x".repeat(4_001))
    a.plugins.actions.press(VIEW, reply)
    expect(a.state()).toMatchObject({ sending: false, failed: true })
    expect(a.count(Metric.withAttributes(presses, { plugin: "queue", event: "reply", door: "button", outcome: "invalid" }))).toBe(1)
    // An empty reply is no answer to a question: ChatApi refuses it, the strip says Not sent, and the question stays open.
    a.plugins.actions.setDraft(VIEW, "")
    a.plugins.actions.press(VIEW, reply)
    await until(() => expect(a.count(Metric.withAttributes(presses, { plugin: "queue", event: "reply", door: "button", outcome: "failed" }))).toBe(1))
    expect(a.state()).toMatchObject({ sending: false, failed: true })
    expect(a.run(answerId)?.answer).toBeNull()

    // The queue's place says when it changes; the components hear it through `subscribe`.
    let heard = 0
    const stop = tab.queries.current.subscribe(() => void heard++)
    // A button drawn for another version of the item does nothing: the item moved on.
    const drawn = tab.queries.current.current().item! as unknown as Readonly<Record<string, unknown>> & { readonly version: number }
    a.plugins.actions.press(VIEW, docs, { ...drawn, version: drawn.version + 1 })
    expect(a.state()?.sending).toBe(false)
    expect(a.count(Metric.withAttributes(presses, { plugin: "queue", event: "option", door: "button", outcome: "stale" }))).toBe(1)
    a.plugins.actions.press(VIEW, docs, drawn)
    expect(a.state()?.sending).toBe(true)
    // A second press while the first is on its way does nothing: one answer.
    a.plugins.actions.press(VIEW, docs)
    const second = await Effect.runPromise(api.answerTo("Deploy the preview", 1))
    second.cell(`ctx.done("Deploying docs-v2.")`)
    await until(() => expect(a.run(answerId)?.answer).toEqual({ value: "docs-v2" }))
    await until(() => expect(a.run(answerId)?.status).toBe("done"))
    await until(() => expect(tab.queries.current.current()).toEqual({ item: undefined, index: 0, total: 0 }))
    expect(heard).toBeGreaterThan(0)
    stop()
    await until(() => expect(a.state()).toMatchObject({ sending: false, failed: false }))
    // The answered item's note went with it.
    expect(a.plugins.queries.notes.toArray).toEqual([])
    // Its nav entry opens its view.
    tab.actions.open()
    await until(() => expect(a.count(Metric.withAttributes(dispatches, { flow: "app/navigate", door: "view", outcome: "done" }))).toBe(1))
    expect(a.count(Metric.withAttributes(presses, { plugin: "queue", event: "option", door: "button", outcome: "done" }))).toBe(1)
    // The press whose flow failed is a Warn by its code; the strip's own refusal of a note too long is Info. The tab's
    // exporter sends its records each second.
    await until(() => {
      const pressed = readTelemetry(api.telemetry).log("plugin.press")
      expect(pressed.filter((line) => line.attributes.outcome === "failed")).toEqual([expect.objectContaining({
        severity: "Warn",
        attributes: expect.objectContaining({ feature: "plugins", plugin: "queue", event: "reply", errorCode: expect.any(String) }),
      })])
      expect(pressed.filter((line) => line.attributes.outcome === "invalid").map((line) => line.severity)).toEqual(["Info"])
    })
  })

  test("keys: g q opens the queue, j and k stay on its one item, a digit answers, i and a send an approval's note, ⌘↵ replies from the note", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    // Complete each run before setting up the next keyboard scenario.
    const first = await a.ask("Deploy one", question("one"))
    const tab = (await a.plugins.actions.tab("queue")) as QueueTab
    await until(() => expect(tab.queries.current.current()).toMatchObject({ total: 1, item: { runId: first } }))

    // `g q`, from anywhere but a field, runs `app/navigate` with door `key`.
    expect(a.press("g")).toBe(false)
    expect(a.press("q")).toBe(true)
    const navigated = Metric.withAttributes(dispatches, { flow: "app/navigate", door: "key", outcome: "done" })
    await until(() => expect(a.count(navigated)).toBe(1))
    // `g`, then too late a `q`, is nothing.
    const at = (event: Event, timeStamp: number) => Object.defineProperty(event, "timeStamp", { value: timeStamp })
    a.window.dispatchEvent(at(keydown("g"), 0))
    expect(a.window.dispatchEvent(at(keydown("q"), 5_000))).toBe(true)

    // With no view shown, the view's keys do nothing.
    expect(a.press("j")).toBe(false)
    expect(a.press("i")).toBe(false)
    // The route shows the view; its keys act on it. With one item, j and k stay on it.
    a.plugins.actions.show(VIEW)
    expect(a.press("j")).toBe(true)
    expect(a.press("k")).toBe(true)
    await until(() => expect(tab.queries.current.current()).toMatchObject({ index: 0, item: { runId: first } }))
    // A question's keys are its digits: `a` is no key of it, and a letter in a field is typing.
    expect(a.press("a")).toBe(false)
    const field = new Field()
    expect(a.press("2", {}, field)).toBe(false)
    expect(a.press("shift")).toBe(false)
    expect(a.press("2")).toBe(true)
    expect(a.state()?.sending).toBe(true)
    ;(await Effect.runPromise(api.answerTo("Deploy one", 1))).cell(`ctx.done("Deploying docs-v2.")`)
    await until(() => expect(a.run(first)?.answer).toEqual({ value: "docs-v2" }))
    await until(() => expect(a.run(first)?.status).toBe("done"))
    expect(a.count(Metric.withAttributes(presses, { plugin: "queue", event: "option", door: "key", outcome: "done" }))).toBe(1)

    // An approval: `a` sends Approve with the note.
    const approval = await a.ask("Approve two", `{ kind: "approval", prompt: "Delete two?" }`)
    await until(() => expect(a.state()?.item).toBe(approval))
    expect(a.press("1")).toBe(false)
    a.plugins.actions.setDraft(VIEW, "ship it")
    expect(a.press("a")).toBe(true)
    ;(await Effect.runPromise(api.answerTo("Approve two", 1))).cell(`ctx.done("Approved")`)
    await until(() => expect(a.run(approval)?.answer).toEqual({ value: { approved: true, note: "ship it" } }))
    await until(() => expect(a.run(approval)?.status).toBe("done"))
    expect(a.count(Metric.withAttributes(presses, { plugin: "queue", event: "approve", door: "key", outcome: "done" }))).toBe(1)

    // A question again: ⌘↵ from the note replies with its words.
    const third = await a.ask("Deploy three", question("three"))
    await until(() => expect(a.state()?.item).toBe(third))
    a.plugins.actions.setDraft(VIEW, "release")
    expect(a.press("enter", { metaKey: true }, field)).toBe(true)
    ;(await Effect.runPromise(api.answerTo("Deploy three", 1))).cell(`ctx.done("Deploying release.")`)
    await until(() => expect(a.run(third)?.answer).toEqual({ value: "release" }))
    await until(() => expect(a.run(third)?.status).toBe("done"))
    await until(() => expect(tab.queries.current.current()).toEqual({ item: undefined, index: 0, total: 0 }))
  })

  test("PluginHost serves a plugin only what its manifest declares, and never sends a person-only event", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const answerId = await a.ask("Deploy refusals", question("refusals"))
    const refusal = <A>(effect: Effect.Effect<A, Host.PluginRefused>) =>
      a.runtime.runPromise(Effect.flip(effect)).then((refused) => refused.reason)
    await a.runtime.runPromise(
      Effect.gen(function* () {
        const host = yield* hostFor("queue")
        expect((yield* host.query("core/waits")).current()).toEqual([expect.objectContaining({ runId: answerId })])
      }),
    )
    const host = await a.runtime.runPromise(hostFor("queue"))
    expect(await refusal(host.query("core/runs"))).toBe("undeclared_query")
    // The strip's events are the person's: plugin code can't send them, compiled or not.
    expect(await refusal(host.dispatch({ view: VIEW, name: "option" }, { index: 0 }))).toBe("person_only")
    expect(await refusal(host.dispatch({ view: VIEW, name: "next" }, {}))).toBe("undeclared_event")
    expect(await refusal(host.dispatch({ view: "other/view", name: "option" }, {}))).toBe("undeclared_event")
    expect(await refusal(host.propose({ view: VIEW, name: "option" }, { index: 99 }))).toBe("invalid_fields")
    expect(await refusal(host.propose({ view: VIEW, name: "next" }, {}))).toBe("undeclared_event")
    expect(await refusal(host.select({ query: "core/waits", key: "no-such-run" }))).toBe("not_in_reads")
    expect(await refusal(host.select({ query: "core/runs", key: answerId }))).toBe("not_in_reads")

    // Selecting the row already selected changes nothing.
    await a.runtime.runPromise(host.select({ query: "core/waits", key: answerId }))
    const selected = a.state()
    await a.runtime.runPromise(host.select({ query: "core/waits", key: answerId }))
    expect(a.state()).toEqual(selected)
    // A proposal fills the strip's note and sends nothing.
    await a.runtime.runPromise(host.propose({ view: VIEW, name: "reply" }, { note: "maybe main" }))
    await a.runtime.runPromise(host.propose({ view: VIEW, name: "option" }, { index: 1 }))
    expect(a.note()).toBe("maybe main")
    expect(a.state()?.sending).toBe(false)
    expect(a.run(answerId)?.answer).toBeNull()

    // Another plugin's view gets nothing; its own opens through `app/navigate`.
    expect(await a.runtime.runPromise(Stream.runCollect(host.events("other/view")))).toEqual([])
    await a.runtime.runPromise(host.open("other/view"))
    await a.runtime.runPromise(host.open(VIEW))
    await until(() => expect(a.count(Metric.withAttributes(dispatches, { flow: "app/navigate", door: "view", outcome: "done" }))).toBe(1))
    // Each refusal is logged once at Warn by its reason, never its detail. The tab's exporter sends each second.
    await until(() => {
      const refused = readTelemetry(api.telemetry).log("plugin.request")
      expect(refused.map((line) => line.attributes.reason).sort()).toEqual([
        "invalid_fields", "not_in_reads", "not_in_reads", "person_only",
        "undeclared_event", "undeclared_event", "undeclared_event", "undeclared_query",
      ])
      for (const line of refused) {
        expect(line).toMatchObject({ severity: "Warn", attributes: { feature: "plugins", plugin: "queue", outcome: "refused" } })
      }
    })
    expect(JSON.stringify(readTelemetry(api.telemetry).log("plugin.request"))).not.toContain("no-such-run")
  })

  test("a plugin's own event whose flow isn't person-only dispatches with door view; a refused built-in never blocks the rest", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const answerId = await a.ask("Deploy probe", question("probe"))
    const probeView = {
      id: "probe/list", title: "Probe", scope: "app", path: "", sizes: ["full"], minimum: "anyone", reads: ["core/waits"],
      render: { kind: "component", export: "List" },
      events: [{ name: "go", flow: "app/navigate", args: { to: "/app/runs" } }, { name: "bad", payload: { type: "object", properties: { to: { type: "string" } } }, flow: "app/navigate", args: { to: "$event.to" } }],
    }
    // A second view reads nothing: selecting acts only on the views that read the item's query.
    const { reads: _reads, ...unread } = probeView
    const plain = { ...unread, id: "probe/plain", path: "plain", events: [] }
    const probe: BuiltIn = {
      manifest: { ...queue, id: "probe", uses: ["app/navigate"], $defs: {}, contributes: { views: [probeView, plain] } },
      tab: () => Promise.reject(new Error("never loaded")),
      components: () => Promise.reject(new Error("never loaded")),
    }
    const broken: BuiltIn = { ...probe, manifest: { id: "broken", apiVersion: 2 } }
    const nameless: BuiltIn = { ...probe, manifest: [] }
    const outcome = await a.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const plugins = yield* Plugins
          const host = yield* hostFor("probe")
          yield* host.select({ query: "core/waits", key: answerId })
          const dispatched = yield* host.dispatch({ view: "probe/list", name: "go" }, {})
          const bad = yield* Effect.flip(host.dispatch({ view: "probe/list", name: "bad" }, {}))
          const misfit = yield* Effect.flip(host.dispatch({ view: "probe/list", name: "bad" }, { to: 5 }))
          expect(misfit.reason).toBe("invalid_fields")
          // The run goes on in the host's scope, which this test closes at its end: wait for it there.
          const done = Metric.withAttributes(dispatches, { flow: "app/navigate", door: "view", outcome: "done" })
          yield* Effect.promise(() => until(() => expect(a.count(done)).toBe(1)))
          // The view hears how its run ended (`Dispatched.settled`).
          const settled = yield* dispatched.settled
          return { ids: plugins.contributions.plugins.map((plugin) => plugin.id), refused: plugins.refused, dispatched, bad, settled }
        }).pipe(Effect.provide(Plugins.layer([broken, nameless, probe]))),
      ),
    )
    expect(outcome.ids).toEqual(["probe"])
    expect(outcome.refused).toEqual(expect.arrayContaining([
      expect.objectContaining({ plugin: "broken", reason: "invalid" }),
      expect.objectContaining({ reason: "invalid" }),
    ]))
    expect(outcome.refused).toHaveLength(2)
    expect(outcome.dispatched.runId).toEqual(expect.any(String))
    expect(outcome.settled).toEqual({ _tag: "Done" })
    expect(outcome.bad.reason).toBe("invalid_fields")
    expect(a.count(Metric.withAttributes(loads, { outcome: "refused", tier: "built-in", reason: "invalid" }))).toBe(2)
  })

  test("views by path, unknown plugins' chunks and who may see what", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const view = viewAt(a.plugins.contributions, "queue", "")!
    expect(view.id).toBe(VIEW)
    expect(a.plugins.actions.viewAt("queue", "")).toBe(view)
    expect(viewAt(a.plugins.contributions, "queue", "nope")).toBeUndefined()
    expect(pathOf(view)).toBe("/app/queue")
    expect(pathOf({ ...view, path: "later" })).toBe("/app/queue/later")
    expect(viewAt(a.plugins.contributions, "queue", "", "repository")).toBeUndefined()
    expect(a.plugins.actions.pathOf(view)).toBe("/app/queue")
    expect(Exit.isFailure(await a.runtime.runPromiseExit(Effect.promise(() => a.plugins.actions.tab("nope"))))).toBe(true)
    await expect(a.plugins.actions.components("nope")).rejects.toThrow("no active plugin nope")
    expect(Object.keys(await a.plugins.actions.components("queue")).sort()).toEqual(["NavCount", "Queue"])
    // One promise per chunk, so React's `use` settles.
    expect(a.plugins.actions.components("queue")).toBe(a.plugins.actions.components("queue"))
    expect(a.plugins.actions.allows("member", { signedIn: true, role: "member" })).toBe(true)
    expect(a.plugins.actions.allows("member", { signedIn: true, role: "guest" })).toBe(false)
    expect(a.plugins.actions.allows("anyone", { signedIn: false, role: null })).toBe(true)
    expect(a.plugins.actions.core("core/waits")?.key).toBe("runId")
    // With nothing selected there is no note to keep.
    a.plugins.actions.setDraft(VIEW, "lost")
    expect(a.plugins.queries.notes.toArray).toEqual([])
    // A press the strip never draws does nothing: no view, no event, a local event.
    a.plugins.actions.press("nope/view", { event: "option", fields: {}, label: "" })
    a.plugins.actions.press(VIEW, { event: "nope", fields: {}, label: "" })
    a.plugins.actions.press(VIEW, { event: "next", fields: {}, label: "" })
    expect(a.state()).toBeUndefined()
    expect(a.plugins.actions.core("core/runs")).toBeUndefined()
    // A contribution its Boundary caught is recorded once at Error, by the error's name, never its message.
    a.plugins.actions.failed("queue", new TypeError("a component's private words"))
    // The tab's exporter sends its records each second.
    await until(() =>
      expect(readTelemetry(api.telemetry).log("plugin.failed")).toEqual([expect.objectContaining({
        severity: "Error",
        attributes: expect.objectContaining({ feature: "plugins", plugin: "queue", outcome: "failed", errorCode: "TypeError" }),
      })])
    )
    expect(JSON.stringify(readTelemetry(api.telemetry).log("plugin.failed"))).not.toContain("private words")
  })
})

describe("a repository's plugin views (decision 0126 §8)", () => {
  test("a repository view shows on its repository's page, opens there, and has no page without one", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const home = {
      id: "probe/home", title: "Probe", scope: "repository", path: "", sizes: ["full"], minimum: "anyone",
      render: { kind: "component", export: "Home" },
    }
    const probe: BuiltIn = {
      manifest: {
        ...queue, id: "probe", uses: ["app/navigate"], $defs: {},
        contributes: {
          views: [home, { ...home, id: "probe/lanes", path: "lanes" }],
          slots: [{ slot: "repo.tabs", id: "probe/tab", minimum: "anyone", render: { kind: "component", export: "Tab" } }],
        },
      },
      tab: () => Promise.reject(new Error("never loaded")),
      components: () => Promise.reject(new Error("never loaded")),
    }
    const repository = { owner: "smithersai", name: "vibelang" }
    const navigated = Metric.withAttributes(dispatches, { flow: "app/navigate", door: "view", outcome: "done" })
    const outcome = await a.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const plugins = yield* Plugins
          const host = yield* hostFor("probe")
          // Without its repository, a repository view has no page to open: nothing runs.
          yield* host.open("probe/lanes")
          yield* host.open("probe/lanes", repository)
          yield* Effect.promise(() => until(() => expect(a.count(navigated)).toBe(1)))
          return plugins
        }).pipe(Effect.provide(Plugins.layer([probe]))),
      ),
    )
    expect(outcome.refused).toEqual([])
    expect(outcome.contributions.slots.map((slot) => slot.slot)).toEqual(["repo.tabs"])
    const lanes = viewAt(outcome.contributions, "probe", "lanes", "repository")!
    expect(lanes.id).toBe("probe/lanes")
    // A repository view is never an app page.
    expect(viewAt(outcome.contributions, "probe", "lanes")).toBeUndefined()
    expect(pathOf(lanes, repository)).toBe("/smithersai/vibelang/-/probe/lanes")
    expect(pathOf(lanes)).toBeUndefined()
    expect(a.count(navigated)).toBe(1)
  })
})

describe("how a plugin's run ended (Dispatched.settled)", () => {
  test("done, a declared failure's code or kind, dispatch's refusal or reason, interrupted, and never a message", () => {
    expect(settledOf(Exit.succeed({ _tag: "Done" }))).toEqual({ _tag: "Done" })
    // `BugRefused` carries ChatApi's code; a failure without one is known by its kind.
    expect(settledOf(Exit.succeed({ _tag: "Failed", error: { _tag: "@smthrs/mvp/bugs/BugRefused", status: 401, code: "authentication" } })))
      .toEqual({ _tag: "Failed", code: "authentication" })
    expect(settledOf(Exit.succeed({ _tag: "Failed", error: { _tag: "@smthrs/mvp/bugs/BugUnsent", message: "a secret" } })))
      .toEqual({ _tag: "Failed", code: "BugUnsent" })
    expect(settledOf(Exit.succeed({ _tag: "Failed", error: "no tag" }))).toEqual({ _tag: "Failed", code: "failed" })
    expect(settledOf(Exit.fail({ reason: "refused", refusal: "person_only" }))).toEqual({ _tag: "Failed", code: "person_only" })
    expect(settledOf(Exit.fail({ reason: "unavailable" }))).toEqual({ _tag: "Failed", code: "unavailable" })
    expect(settledOf(Exit.failCause(Cause.interrupt()))).toEqual({ _tag: "Failed", code: "interrupted" })
    expect(settledOf(Exit.die(new Error("a secret")))).toEqual({ _tag: "Failed", code: "defect" })
  })
})
