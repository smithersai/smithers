import { Spend } from "../../features/spend/spend"
import { renderConnection } from "./connection-render"
// The repository header on the branch page, rendered with the real app layers over the compose Postgres/Electric.
// The host reports offline, as navigator.onLine does; the collections, queries and components remain real.
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Effect } from "effect"
import { afterEach, expect, test } from "vitest"
import * as Conversations from "../../../worker/branch/Conversations.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { Attention } from "../../features/attention/attention"
import { Auth } from "../../features/auth/auth"
import { Chat } from "../../features/chat/chat"
import { ChatStore } from "../../features/chat/store"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { Repo } from "../../features/repo/repo"
import { Views } from "../../features/views/views"
import { nodeDevice, openTestApp, TestChatApi } from "../../test/chatApi"

const disposables: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) await dispose()
})

test("a branch page announces Offline and the queued count, then clears on reconnection", async () => {
  const runtime = openTestApp({ host: nodeDevice({ isOnline: () => false }) })
  disposables.push(() => runtime.dispose())
  const [chat, store, repo, attention, api, auth, spend, views] = await runtime.runPromise(
    Effect.all([Effect.service(Chat), Effect.service(ChatStore), Effect.service(Repo), Effect.service(Attention), Effect.service(TestChatApi), Effect.service(Auth), Effect.service(Spend), Effect.service(Views)]),
  )
  repo.actions.openRoute("tree", { owner: "octo", repo: "hello", ref: "main" }, {})
  for (const query of [repo.queries.view, chat.queries.connection, chat.queries.queued, chat.queries.place,
    attention.queries.unread, attention.queries.needs, attention.queries.panel]) query.startSyncImmediate()

  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo/tree/$ref", component: RepoHeader })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/octo/hello/tree/main"] }) })
  await router.load()
  const render = () => renderConnection(router, { chat, repo, attention, auth, spend, views })
  const connection = () => render().match(/<div[^>]*aria-label="Connection"[^>]*>(.*?)<\/div>/s)?.[1]

  expect(connection()).toContain("Offline")
  await runtime.runPromise(store.asking.insert({ v: 2, id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "queued", queuedAt: 1 }))
  expect(connection()).toContain("Offline · 1")
  const tracked = await runtime.runPromise(api.branches.run(Conversations.track("github/octo/hello", "main", "open", shaOf("main"))))
  const conversationId = tracked.branch.conversationId
  await chat.actions.show(conversationId)
  chat.queries.of(conversationId).queued.startSyncImmediate()
  expect(connection()).toContain("Offline")
  expect(connection()).not.toContain("·")
  await runtime.runPromise(store.asking.insert({ v: 2, id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "branch queued", queuedAt: 2, conversationId }))
  expect(connection()).toContain("Offline · 1")
  await runtime.runPromise(store.connection.update("connection", (row) => { row.status = "up" }))
  expect(connection()).toBe("")
}, 90_000)
