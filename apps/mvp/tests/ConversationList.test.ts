import { dom } from "./fixtures/dom"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { AppProviders } from "../src/AppProviders"
import { AuthStore, SESSION } from "../src/features/auth/store"
import { Commands } from "../src/features/commands/commands"
import { ConversationsStore } from "../src/features/conversations/store"
import { ConversationsScreen } from "../src/screens/conversations/ConversationsScreen"
import { appViews } from "../src/test/appViews"
import { nodeDevice, openTab, openTestApp, TestChatApi } from "../src/test/chatApi"
import { shaOf } from "../worker/test/branch"

Object.assign(globalThis, { self: dom, scrollTo: dom.scrollTo.bind(dom) })
afterAll(() => dom.happyDOM.close())

// Real Postgres, Electric, device collections, durable flows and React binding.
// Mount after branch tracking, as page navigation does, without prestarting the list query.
test("Conversations renders tracked and Smithers-only branches and archives through its real button", async () => {
  const server = openTestApp({ answers: false }, { forge: "code-storage" })
  const api = await server.runPromise(Effect.service(TestChatApi))
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main", branches: { main: shaOf("main"), "feature/one": shaOf("one") },
  })
  const host = nodeDevice({ agent: api })
  const device = openTab(api, { host })
  const container = document.createElement("div")
  document.body.append(container)
  const view = createRoot(container)
  try {
    const views = await device.runPromise(appViews)
    const { branch } = views
    await branch.actions.open("octo", "hello", "feature/one")
    const commands = await device.runPromise(Effect.service(Commands))
    const { session } = await device.runPromise(Effect.service(AuthStore))
    await vi.waitFor(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"), { timeout: 40_000 })
    await device.runPromise(session.update(SESSION, row => { Object.assign(row, { status: "signed_in", login: "member", role: "member" }) }))
    commands.actions.type("/new octo/hello topic-two")
    commands.actions.submit("/new octo/hello topic-two")
    await vi.waitFor(() => expect(api.branches.forge.ephemeral.repository("octo", "hello")?.branches["topic-two"]).toBe(shaOf("main")), { timeout: 40_000 })
    await vi.waitFor(() => expect(host.navigated).toEqual(["/octo/hello/tree/topic-two"]), { timeout: 5_000 })
    // PostgreSQL omits the decimal point at whole seconds. Locale collation orders that value after its fractions.
    const whole = Date.UTC(2026, 0, 1)
    const changed = await server.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, sql => sql`
      UPDATE conversation_people SET opened_at = CASE WHEN branch = 'topic-two'
        THEN ${new Date(whole + 267)}::timestamptz ELSE ${new Date(whole)}::timestamptz END
      WHERE person_id = 'person-member' AND owner = 'octo' AND repo = 'hello'
        AND branch IN ('feature/one', 'topic-two') RETURNING conversation_id`)))
    expect(changed).toHaveLength(2)
    const store = await device.runPromise(Effect.service(ConversationsStore))
    await vi.waitFor(async () => {
      const rows = await device.runPromise(store.mine.toArray)
      expect(rows.find(row => row.branch === "feature/one")?.openedAt).toBe("2026-01-01 00:00:00+00")
      expect(rows.find(row => row.branch === "topic-two")?.openedAt).toBe("2026-01-01 00:00:00.267+00")
    }, { timeout: 5_000 })
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/app/conversations", component: ConversationsScreen })
    const router = createRouter({ isServer: false, routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/conversations"] }) })
    await act(async () => {
      await router.load()
      view.render(createElement(AppProviders, { views }, createElement(RouterProvider, { router })))
    })
    const list = () => container.querySelector('ul[aria-label="Conversations"]')
    await vi.waitFor(async () => {
      await act(async () => {})
      expect([...list()!.querySelectorAll("li > a")].map(link => link.textContent)).toEqual(["topic-two octo/hello", "feature/one octo/hello"])
    }, { timeout: 5_000 })
    await act(async () => { await branch.conversations.actions.search("missing-bb2") })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.textContent).toContain("No matches")
      expect(container.textContent).not.toContain("No conversations")
    })
    await act(async () => { await branch.conversations.actions.search("") })
    await vi.waitFor(async () => { await act(async () => {}); expect(list()).not.toBeNull() })
    expect([...list()!.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["/octo/hello/tree/topic-two", "/octo/hello/tree/feature/one"])
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Archive topic-two · octo/hello"]')!.click() })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect([...list()!.querySelectorAll("li > a")].map(link => link.textContent)).toEqual(["feature/one octo/hello"])
    }, { timeout: 40_000 })
    await act(async () => { await branch.conversations.actions.showArchived(true) })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector('button[aria-label="Restore topic-two · octo/hello"]')).not.toBeNull()
    }, { timeout: 40_000 })
  } finally {
    await act(async () => view.unmount())
    container.remove()
    await device.dispose()
    await server.dispose()
  }
}, 120_000)
