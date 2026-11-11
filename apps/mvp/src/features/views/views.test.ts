// The conversation's views and a person's `/web` (docs/features/web-pages.md): the browser's own layer (`appLayer`) over
// Node devices against ChatApi's real handler and the compose Postgres and Electric (src/test/chatApi.ts). A view row
// syncs to every tab and sits among the messages by position; the full-screen route shows a `webpage`; a person's
// `/web` runs through the slash commands, and their own `tab` opens straight from the keypress when the browser allows
// it. A person's click or key never reaches Node, so a device's `openTab` answers for the browser.
import { Effect, type ManagedRuntime, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.vibe"
import { framable, markdown, refusing } from "../../../worker/test/pages.ts"
import { CHATAPI_ORIGIN, member, nodeDevice, openTab, openTestApp, type TabOptions, TestChatApi } from "../../test/chatApi"
import { FlowDispatch } from "../../flows/dispatch"
import { AuthStore, SESSION } from "../auth/store"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"
import { Commands } from "../commands/commands"
import { openWebPage } from "../web/actions"
import { CANT_OPEN } from "../web/contract"
import { pagesOpened } from "../web/metrics"
import { Web } from "../web/web"
import { viewPath } from "./contract"
import { TIC_TAC_TOE, TIC_TAC_TOE_STATE } from "./renderer"
import { pageOf } from "./rows"
import { ViewsStore } from "./store"
import { Views } from "./views"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long a flow may take on the device's engine, its first start included, on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: two flows on a fresh device's engine, each with its first start, on a loaded machine. */
const WITHIN = 90_000

type App = ManagedRuntime.ManagedRuntime<
  Commands | Chat | ChatStore | ViewsStore | Views | Web | AuthStore | TestChatApi | FlowDispatch,
  unknown
>

/** The outside web these tests open: example.com's pages allow framing, refuses.example refuses it (worker/test/pages.ts). */
const PAGES = {
  "https://example.com/": framable("Example"),
  "https://example.com/docs": framable("Example docs"),
  "https://refuses.example/": refusing("Refuses"),
  // A repository's docs (docs/features/docs.md): its curated home names this index.
  "https://docs.example/llms.txt": markdown("# Example\n- [Retrying](/guide/retrying.md): Retry a failing effect."),
  "https://docs.example/guide/retrying.md": markdown("# Retrying\n\nUse `retry`.\n"),
}

/** Smithers' curated home for `acme/widgets`, naming its docs. */
const HOMES = [{
  repository: "acme/widgets",
  defaultBranch: "main",
  home: { docs: "https://docs.example/llms.txt", blocks: [{ type: "text", text: "Widgets" }] },
}]

/** The page of the view `id` in the home conversation, as its row says: what the conversation renders it from. */
const pageIn = (
  views: Views["Service"],
  id: string,
): { readonly url?: string; readonly title?: string; readonly description?: string; readonly icon?: string } => {
  const row = views.queries.rowsIn(undefined).toArray.find((view) => view.id === id)
  return row === undefined ? {} : pageOf(row)
}

/**
 * The app as `actor` (a Member unless `null`), with its conversation and full-screen view started as React starts them,
 * and the session row set as sign-in's `load` sets it, so the composer offers `/web`.
 */
const open = async (options: TabOptions = {}, actor: Actor | null = member) => {
  const runtime: App = openTestApp(options, { actor, pages: PAGES, homes: HOMES })
  runtimes.push(runtime)
  const chat = await runtime.runPromise(Effect.service(Chat))
  const views = await runtime.runPromise(Effect.service(Views))
  const commands = await runtime.runPromise(Effect.service(Commands))
  const chatStore = await runtime.runPromise(Effect.service(ChatStore))
  for (const query of [chat.queries.conversation, views.queries.shown, views.queries.rowsIn(undefined), commands.queries.menu, chatStore.composerState.tanstack]) {
    query.startSyncImmediate()
  }
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(
    session.update(SESSION, (row) =>
      void Object.assign(
        row,
        actor === null
          ? { status: "signed_out", login: null, role: null }
          : { status: "signed_in", login: actor.subject.id, role: actor.role },
      )),
  )
  return {
    runtime,
    api: await runtime.runPromise(Effect.service(TestChatApi)),
    commands,
    web: await runtime.runPromise(Effect.service(Web)),
    views,
    /** The conversation as the screen shows it: each row's role, and a view's template and page. */
    conversation: () =>
      chat.queries.conversation.toArray.map((row) =>
        row.role === "view" ? `view ${row.template} ${pageIn(views, row.id).url}` : row.role
      ),
    viewIds: () => chat.queries.conversation.toArray.flatMap((row) => (row.role === "view" ? [row.id] : [])),
    /** Each view's preview, as its card or frame shows it. */
    preview: () =>
      chat.queries.conversation.toArray.flatMap((row) => {
        if (row.role !== "view") return []
        const { title, description, icon } = pageIn(views, row.id)
        return [{ title, description, icon }]
      }),
    draft: () => chatStore.composerState.tanstack.toArray[0]?.draft,
    count: (attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(pagesOpened, attributes))).count,
  }
}

/** Types `text` in the composer and sends it, as Enter does: a slash command runs. */
const send = (tab: Awaited<ReturnType<typeof open>>, text: string) => {
  tab.commands.actions.type(text)
  tab.commands.actions.submit(text)
}

describe("/web <url>", () => {
  test("embeds the page: a view that sits after the messages before it, on every tab of the conversation", async () => {
    const tab = await open({ answers: true })
    await tab.runtime.runPromise(tab.api.askElsewhere("What is example.com?"))
    await until(() => expect(tab.conversation()).toEqual(["user", "assistant"]))

    send(tab, "/web https://example.com/")

    await until(() => expect(tab.conversation()).toEqual(["user", "assistant", "view webpage https://example.com/"]))
    // Counted once the flow answers the dispatch, which can come after Electric delivers the row.
    await until(() =>
      expect(tab.count({ web_mode: "embed", door: "slash", outcome: "embedded", web_framing: "allowed" })).toBe(1)
    )
    expect(tab.preview()).toEqual([
      { title: "Example", description: "A page that lets others frame it.", icon: "https://example.com/icon.png" },
    ])
    // Another device of the same conversation shows it from its own synced row.
    const other = openTab(tab.api)
    runtimes.push(other)
    const chat = await other.runPromise(Effect.service(Chat))
    const otherViews = await other.runPromise(Effect.service(Views))
    chat.queries.conversation.startSyncImmediate()
    otherViews.queries.rowsIn(undefined).startSyncImmediate()
    await until(() =>
      expect(chat.queries.conversation.toArray.flatMap((row) => (row.role === "view" ? [pageIn(otherViews, row.id).url] : [])))
        .toEqual(["https://example.com/"])
    )
  }, WITHIN)

  test("tab: a card when the browser won't open it from the keypress, and the tab itself when it does", async () => {
    const card = await open({ answers: true })
    send(card, "/web https://example.com/ tab")
    await until(() => expect(card.conversation()).toEqual(["view link https://example.com/"]))
    await until(() =>
      expect(card.count({ web_mode: "tab", door: "slash", outcome: "card", web_framing: "allowed" })).toBe(1)
    )

    const opened: Array<string> = []
    const direct = await open({
      host: nodeDevice({
        web: { policy: { localHttp: false, appOrigin: CHATAPI_ORIGIN }, openTab: (href) => opened.push(href) > 0 },
      }),
    })
    send(direct, "/web https://example.com/docs tab")
    expect(opened).toEqual(["https://example.com/docs"])
    expect(direct.count({ web_mode: "tab", door: "slash", outcome: "opened" })).toBe(1)
    // No flow ran: the person sees the tab they opened, and nothing claims one more.
    expect(direct.count({ web_mode: "tab", door: "slash", outcome: "card", web_framing: "allowed" })).toBe(0)
  }, WITHIN)

  test("a page that refuses framing is a card with its title, description and icon, never a blank frame", async () => {
    const tab = await open({ answers: true })

    send(tab, "/web https://refuses.example/")

    await until(() => expect(tab.conversation()).toEqual(["view link https://refuses.example/"]))
    expect(tab.preview()).toEqual([
      {
        title: "Refuses",
        description: "A page that never shows in a frame.",
        icon: "https://refuses.example/favicon.ico",
      },
    ])
    await until(() =>
      expect(tab.count({ web_mode: "embed", door: "slash", outcome: "card", web_framing: "refused" })).toBe(1)
    )
  }, WITHIN)

  test("a refused page stays in the composer saying why, adds nothing, and the tab counts it by its door", async () => {
    const tab = await open({ answers: true })

    send(tab, "/web javascript:alert(document.cookie)")
    expect(tab.commands.queries.menu.toArray[0]?.refusal).toBe(CANT_OPEN.scheme)
    expect(tab.draft()).toBe("/web javascript:alert(document.cookie)")
    send(tab, `/web ${CHATAPI_ORIGIN}/app tab`)
    expect(tab.commands.queries.menu.toArray[0]?.refusal).toBe(CANT_OPEN.insecure)
    expect(tab.count({ web_mode: "embed", door: "slash", outcome: "refused" })).toBe(1)
    expect(tab.count({ web_mode: "tab", door: "slash", outcome: "refused" })).toBe(1)
    // A URL longer than the flow takes never runs it.
    const { scope } = await tab.runtime.runPromise(Effect.service(ChatStore))
    await tab.runtime.runPromise(openWebPage({ url: `https://example.com/${"x".repeat(2_048)}` }, "button", scope))
    await until(() => expect(tab.count({ web_mode: "embed", door: "button", outcome: "refused" })).toBe(1))

    expect(tab.conversation()).toEqual([])
  }, WITHIN)

  test("a person who may not add to the conversation is forbidden, and nothing is added", async () => {
    const tab = await open({ answers: true }, null)
    const { scope } = await tab.runtime.runPromise(Effect.service(ChatStore))

    await tab.runtime.runPromise(openWebPage({ url: "https://example.com/" }, "button", scope))

    await until(() => expect(tab.count({ web_mode: "embed", door: "button", outcome: "forbidden" })).toBe(1))
    expect(tab.conversation()).toEqual([])
  }, WITHIN)
})

describe("a view's sizes", () => {
  test.each([false, true])("the full-screen route shows a webpage view, never a card (page first: %s)", async (pageFirst) => {
    const tab = await open({ answers: true })
    // Prove both receipt orders; independent commands need not finish in the order they were pressed.
    const cardCommand = "/web https://example.com/ tab"
    const pageCommand = "/web https://example.com/docs"
    send(tab, pageFirst ? pageCommand : cardCommand)
    await until(() => expect(tab.viewIds()).toHaveLength(1))
    send(tab, pageFirst ? cardCommand : pageCommand)
    await until(() => expect(tab.viewIds()).toHaveLength(2))
    await until(() => expect(tab.viewIds().map(id => pageIn(tab.views, id).url).sort()).toEqual([
      "https://example.com/", "https://example.com/docs",
    ]))
    const card = tab.viewIds().find(id => pageIn(tab.views, id).url === "https://example.com/")!
    const page = tab.viewIds().find(id => pageIn(tab.views, id).url === "https://example.com/docs")!
    expect(viewPath(page)).toBe(`/app/views/${page}`)

    tab.views.actions.show(page)
    await until(() =>
      expect(tab.views.queries.shown.toArray).toEqual([expect.objectContaining({ id: page, props: expect.objectContaining({ url: "https://example.com/docs" }) })]),
      5_000,
    )
    tab.views.actions.show(card)
    await until(() => expect(tab.views.queries.shown.toArray).toEqual([]))
  }, WITHIN)

  test("/docs shows a page of a repository's docs inline, with its Markdown, and at full size", async () => {
    const tab = await open({ answers: true })

    send(tab, "/docs acme/widgets retry")

    await until(() => expect(tab.conversation()).toEqual(["view docs https://docs.example/guide/retrying.md"]))
    const [page] = tab.viewIds() as [string]
    tab.views.actions.show(page)
    await until(() =>
      expect(tab.views.queries.shown.toArray).toEqual([
        expect.objectContaining({ id: page, template: "docs", props: expect.objectContaining({ title: "Retrying", text: "# Retrying\n\nUse `retry`.\n" }) }),
      ])
    )
  }, WITHIN)

  test("a card's Open is the person's own click, counted by the view's door", async () => {
    const tab = await open()

    tab.web.actions.cardOpened()

    expect(tab.count({ web_mode: "tab", door: "view", outcome: "opened" })).toBe(1)
  }, WITHIN)
})

describe("a generated view", () => {
  test("a person's move goes through view/set-state, and the board every tab reads changes once ChatApi made it", async () => {
    const tab = await open()
    const id = crypto.randomUUID()
    const added = await tab.api.fetch(`${CHATAPI_ORIGIN}/api/views`, {
      method: "POST",
      body: JSON.stringify({
        id,
        template: "generated",
        title: "Tic-tac-toe",
        size: "inline",
        code: TIC_TAC_TOE,
        props: {},
        state: TIC_TAC_TOE_STATE,
      }),
    })
    expect(added.status).toBe(202)
    const rows = tab.views.queries.rowsIn(undefined)
    await until(() => expect(rows.toArray.find((row) => row.id === id)?.revision).toBe(0))
    // The full-screen route shows a generated view too.
    tab.views.actions.show(id)
    await until(() => expect(tab.views.queries.shown.toArray).toEqual([expect.objectContaining({ id, template: "generated" })]))

    await tab.views.actions.move(id, 0, { name: "cell", arg: "4" })

    await until(() => expect(rows.toArray.find((row) => row.id === id)).toMatchObject({ revision: 1, state: { turn: "O" } }))
  }, WITHIN)
})
