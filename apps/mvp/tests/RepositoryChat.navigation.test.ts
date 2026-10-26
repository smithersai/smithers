import { dom } from "./fixtures/dom"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Deferred, Effect, Layer } from "effect"
import { ShapeSource } from "@smthrs/effect-electric"
import { SqlClient } from "effect/sql"
import { act, createElement, StrictMode, Fragment } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { AuthStore, SESSION } from "../src/features/auth/store"
import { Commands } from "../src/features/commands/commands"
import { Repo } from "../src/features/repo/repo"
import { RepoProvider } from "../src/features/repo/components/RepoContext"
import { Views } from "../src/features/views/views"
import { ViewsProvider } from "../src/features/views/components/ViewsContext"
import { ViewsStore } from "../src/features/views/store"
import { OPENED } from "../src/features/views/schema"
import { Web } from "../src/features/web/web"
import { WebProvider } from "../src/features/web/components/WebContext"
import { ChatProvider } from "../src/AppContext"
import { Status } from "../src/features/status/status"
import { StatusProvider } from "../src/features/status/components/StatusContext"
import { Todos } from "../src/features/todos/todos"
import { TodosProvider } from "../src/features/todos/components/TodosContext"
import { Chat } from "../src/features/chat/chat"
import * as Conversations from "../worker/branch/Conversations"
import { shaOf } from "../worker/test/codeStorage"
import { openTab, openTestApp, TestChatApi } from "../src/test/chatApi"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver })
afterAll(() => dom.happyDOM.close())

test.each([false, true])("branch=%s: cold sync keeps the existing view and the new repository view once through Full screen and Back to chat", async (branch) => {
  const { Conversation } = await import("../src/features/chat/components/Conversation")
  const { BackToChat } = await import("../src/features/views/components/BackToChat")
  const server = openTestApp()
  const api = await server.runPromise(Effect.service(TestChatApi))
  const source = await server.runPromise(Effect.service(ShapeSource.ShapeSource))
  const gate = Effect.runSync(Deferred.make<void>())
  const requested = Effect.runSync(Deferred.make<void>())
  const app = openTab(api, { replace: Layer.succeed(ShapeSource.ShapeSource, { ...source,
    request: (url, init) => Effect.gen(function* () {
      if (new URL(url).pathname === "/api/shapes/views") {
        yield* Deferred.succeed(requested, undefined)
        yield* Deferred.await(gate)
      }
      return yield* source.request(url, init)
    }),
  }) })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    const { commands, repo, views, web, store, auth, chatState, status, todos } = await app.runPromise(Effect.all({
      commands: Effect.service(Commands), repo: Effect.service(Repo), views: Effect.service(Views),
      web: Effect.service(Web), store: Effect.service(ViewsStore), auth: Effect.service(AuthStore), chatState: Effect.service(Chat), status: Effect.service(Status), todos: Effect.service(Todos),
    }))
    await vi.waitFor(() => expect(auth.session.tanstack.get(SESSION)?.status).toBe("signed_in"), { timeout: 40_000 })
    const about = { name: "octocat/Spoon-Knife", description: null, homepage: null, topics: [], stars: 0, forks: 0, watchers: 0, license: null, defaultBranch: "main", archived: false, languages: [], release: null, releases: null, contributors: [], contributorCount: null, commits: null, branches: null, tags: null, head: null, root: [], readme: { path: "README.md", text: "# Spoon-Knife" }, installUrl: null }
    await app.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO repo_about (repo_id, about, via, read_at, fresh_until) VALUES ('github/octocat/spoon-knife', ${JSON.stringify(about)}, 'anonymous', now(), now() + interval '1 hour')`)))
    const conversationId = branch ? (await app.runPromise(api.branches.run(Conversations.track("github/octocat/spoon-knife", "feature", "open", shaOf("feature"))))).branch.conversationId : undefined
    await chatState.actions.show(conversationId ?? null)
    const destinationId = (await app.runPromise(api.branches.run(Conversations.track("github/octocat/spoon-knife", "main", "open", shaOf("main"))))).branch.conversationId
    const oldId = crypto.randomUUID()
    const seeded = await api.fetch(`${api.origin}/api/views`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: oldId, template: "repo", props: { repo: "octocat/Spoon-Knife" }, ...(conversationId === undefined ? {} : { conversationId }) }) })
    expect(seeded.status).toBe(202)
    const origin = branch ? "/octocat/Spoon-Knife/tree/feature" : "/app"
    const rows = views.queries.rowsIn(conversationId)
    rows.startSyncImmediate()
    repo.queries.embeds.startSyncImmediate()
    const parent = createRootRoute()
    const chat = createRoute({ getParentRoute: () => parent, path: "/app", beforeLoad: () => chatState.actions.show(null), component: Conversation })
    const page = createRoute({ getParentRoute: () => parent, path: "/$owner/$repo/tree/$ref", beforeLoad: ({ params }) => chatState.actions.show(params.ref === "feature" ? conversationId! : destinationId), component: () => createElement(Fragment, null, createElement(BackToChat, { target: { template: "repo", props: { repo: "octocat/Spoon-Knife" } } }), createElement(Conversation)) })
    const router = createRouter({ isServer: false, routeTree: parent.addChildren([chat, page]), history: createMemoryHistory({ initialEntries: [origin] }) })
    await act(async () => {
      await router.load()
      root.render(createElement(StrictMode, null,
        createElement(ChatProvider, { value: chatState },
        createElement(StatusProvider, { value: status },
        createElement(TodosProvider, { value: todos },
        createElement(ViewsProvider, { value: views },
        createElement(WebProvider, { value: web },
        createElement(RepoProvider, { value: repo }, createElement(RouterProvider, { router })))))))))
    })
    const until = (assertion: () => void) => vi.waitFor(async () => { await act(async () => {}); assertion() }, { timeout: 40_000, interval: 20 })
    await app.runPromise(Deferred.await(requested))
    // The old e2e read this zero as its baseline, then mistook the old synced view
    // for the command's new one. No navigation or duplicate write is needed.
    expect(container.querySelectorAll(".conversation-view")).toHaveLength(0)
    await act(async () => {
      commands.actions.type("/repo octocat/Spoon-Knife")
      commands.actions.submit("/repo octocat/Spoon-Knife")
      await app.runPromise(Deferred.succeed(gate, undefined))
    })
    await until(() => expect(rows.toArray).toHaveLength(2))
    await until(() => expect(container.querySelectorAll('.conversation-view a[href="/octocat/Spoon-Knife/tree/main"]')).toHaveLength(2))
    const original = rows.toArray.map(row => row.id).sort()
    const addedId = original.find(id => id !== oldId)!
    expect(addedId).toBeDefined()
    const click = async (selector: string) => act(async () => {
      container.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
    })
    await click(`.conversation-view[data-view="${addedId}"] a[href="/octocat/Spoon-Knife/tree/main"]`)
    await until(() => expect(router.state.location.pathname).toBe("/octocat/Spoon-Knife/tree/main"))
    expect(app.runSync(store.opened.get(OPENED))).toMatchObject({ value: { viewId: addedId, returnTo: origin } })
    await click('a.back-to-chat')
    await until(() => expect(router.state.location.pathname).toBe(origin))
    await until(() => expect(container.querySelectorAll(".conversation-view")).toHaveLength(2))
    expect(rows.toArray.map(row => row.id).sort()).toEqual(original)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await app.dispose()
    await server.dispose()
  }
}, 90_000)
