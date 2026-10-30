// The factory's For you on a device (plugins/factory, docs/features/factory.md#answering): a collector's decisions reach
// the factory's tab through `core/feed-items`, the host's strip under For you answers the selected one through the
// person-only `feed/answer` by button and by key, and the collector reads each answer once. Each device runs the
// browser's own layer on a Node device (src/test/chatApi.ts) whose engine leads, against ChatApi's real handler over the
// compose Postgres and Electric, signed in as a Maintainer of the repository.
import { Effect, Fiber, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { FactoryTab } from "../../plugins/factory/src/tab"
import { feedAnswersRoute, feedsRoute } from "../features/feeds/contract"
import { member, nodeDevice, openTab, openTestApp, TEST_FEED_KEY, TestChatApi } from "../test/chatApi"
import { pluginKeys } from "./keymap"
import { presses, viewById } from "./plugins"
import { PluginsUi } from "./ui"

const WITHIN = 90_000
const VIEW = "factory/for-you"
const REPO = { owner: "octo", name: "hello" } as const

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 60_000, interval: 20 })

/** A window for the keymap. */
class Window extends EventTarget {}

/** A key event as a browser makes one. */
const keydown = (key: string, modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey">> = {}) =>
  Object.assign(new Event("keydown", { cancelable: true }), { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers })

/** ChatApi signed in as a Maintainer of its repository, the collector with its key, and a device whose engine leads. */
const open = async () => {
  const root = openTestApp({ answers: false }, { actor: { ...member, role: "maintainer", login: "maya" } })
  runtimes.push(root)
  const api = await root.runPromise(Effect.service(TestChatApi))
  const runtime = openTab(api, { host: nodeDevice({ agent: api }) })
  runtimes.push(runtime)
  const plugins = await runtime.runPromise(Effect.service(PluginsUi))
  plugins.queries.views.startSyncImmediate()
  plugins.queries.notes.startSyncImmediate()
  const window = new Window()
  const keys = runtime.runFork(Effect.scoped(Effect.andThen(pluginKeys(window, true), Effect.never)))
  runtimes.push({ dispose: () => runtime.runPromise(Fiber.interrupt(keys)).then(() => undefined) })
  const collector = (path: string, init: RequestInit = {}) =>
    api.fetch(`${api.origin}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TEST_FEED_KEY}`, "content-type": "application/json" },
    })
  const push = async (set: Record<string, unknown>) => {
    const written = await collector(feedsRoute(REPO.owner, REPO.name), { method: "POST", body: JSON.stringify({ set }) })
    expect(written.status).toBe(200)
  }
  const answers = async () => {
    const read = await collector(`${feedAnswersRoute(REPO.owner, REPO.name)}?after=0`)
    expect(read.status).toBe(200)
    return ((await read.json()) as { answers: Array<Record<string, unknown>> }).answers
  }
  return {
    plugins,
    push,
    answers,
    key: (key: string, modifiers?: Parameters<typeof keydown>[1]) => {
      const event = keydown(key, modifiers)
      window.dispatchEvent(event)
      return event.defaultPrevented
    },
    state: () => plugins.queries.views.toArray.find((row) => row.id === VIEW),
    count: (event: string, door: string, outcome: string) =>
      runtime.runSync(Metric.value(Metric.withAttributes(presses, { plugin: "factory", event, door, outcome }))).count,
  }
}

describe("the factory's For you", { timeout: WITHIN * 2 }, () => {
  test("the strip answers the selected decision by option and note, once however often it is pressed, then the next by key", async () => {
    const a = await open()
    await a.push({
      for_will: {
        visibility: "maintainers",
        body: [
          { id: "old", kind: "decide", title: "Settled", decided: "Decided by the agent" },
          { id: "catch", kind: "decide", title: "Is the handler always a function?", options: ["2A", "2B"] },
          { id: "list", kind: "review", title: "Is this the list?" },
        ],
      },
    })
    const tab = (await a.plugins.actions.tab("factory")) as FactoryTab
    const asks = tab.queries.asks(REPO)
    // Only what waits: the decided one is past.
    await until(() => expect(asks.current().map((row) => row.item)).toEqual(["catch", "list"]))
    const [catchAsk] = asks.current()
    await until(() => expect(a.state()).toMatchObject({ query: "core/feed-items", item: catchAsk!.key }))
    expect(tab.queries.selected.current()).toBe(catchAsk!.key)

    // A decision with options: a button per option, keyed 1 and 2, and the note.
    const view = viewById(a.plugins.contributions, VIEW)!
    const row = (key: string) =>
      a.plugins.actions.core("core/feed-items", { repo: "octo/hello", name: "for_will" })!.live.current().find((item) => item.key === key)!
    const drawn = row(catchAsk!.key)
    const strip = a.plugins.actions.strip(view, drawn)
    expect(strip).toEqual({
      note: true,
      buttons: [
        { event: "option", fields: { index: 0 }, label: "2A", key: "1" },
        { event: "option", fields: { index: 1 }, label: "2B", key: "2" },
      ],
    })
    const [, second] = strip.buttons

    // A note longer than an answer may be never leaves the strip: it says Not sent.
    a.plugins.actions.setDraft(VIEW, "x".repeat(8_001))
    a.plugins.actions.press(VIEW, second!, drawn)
    expect(a.state()).toMatchObject({ sending: false, failed: true })
    expect(a.count("option", "button", "invalid")).toBe(1)

    // An option with the note; a second press while the first is on its way does nothing.
    a.plugins.actions.setDraft(VIEW, "ship it")
    a.plugins.actions.press(VIEW, second!, drawn)
    expect(a.state()?.sending).toBe(true)
    a.plugins.actions.press(VIEW, second!, drawn)
    await until(() => expect(a.count("option", "button", "done")).toBe(1))
    expect(a.state()).toMatchObject({ sending: false, failed: false })
    // Pressed again before the collector reports it answered, it is the same answer: the item's answer id.
    a.plugins.actions.press(VIEW, second!, drawn)
    await until(() => expect(a.count("option", "button", "done")).toBe(2))
    expect(await a.answers()).toEqual([
      expect.objectContaining({ id: catchAsk!.answer, item: "catch", choice: "2B", text: "ship it", login: "maya" }),
    ])

    // The collector reports it answered: it leaves, and the strip moves to the next, which has no options.
    await a.push({ answered: { visibility: "maintainers", body: { catch: { choice: "2B", text: "ship it", at: 1 } } } })
    await until(() => expect(asks.current().map((item) => item.item)).toEqual(["list"]))
    const [listAsk] = asks.current()
    await until(() => expect(a.state()).toMatchObject({ item: listAsk!.key }))
    // Without options, the old factory's two answers: Accept and Change, on `a` and `c`.
    expect(a.plugins.actions.strip(view, row(listAsk!.key)).buttons).toEqual([
      { event: "accept", fields: {}, label: "Accept", key: "a" },
      { event: "change", fields: {}, label: "Change", key: "c" },
    ])

    // By key, on the view shown: a digit picks nothing here; `c` sends Change with the note.
    a.plugins.actions.show(VIEW)
    a.plugins.actions.setDraft(VIEW, "keep the error")
    expect(a.key("1")).toBe(false)
    expect(a.key("c")).toBe(true)
    await until(() => expect(a.count("change", "key", "done")).toBe(1))
    expect((await a.answers()).map(({ item, choice, text }) => ({ item, choice, text }))).toEqual([
      { item: "catch", choice: "2B", text: "ship it" },
      { item: "list", choice: "change", text: "keep the error" },
    ])
  })
})
