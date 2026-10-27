import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { Auth } from "../src/features/auth/auth"
import { Attention } from "../src/features/attention/attention"
import { AttentionStore } from "../src/features/attention/store"
import { NotificationsPanel } from "../src/features/attention/components/NotificationsPanel"
import { Spend } from "../src/features/spend/spend"
import { Chat } from "../src/features/chat/chat"
import { FlowsUi } from "../src/features/flows-ui/flowsUi"
import { Home } from "../src/features/home/home"
import { Issues } from "../src/features/issues/issues"
import { Pulls } from "../src/features/pulls/pulls"
import { Repo } from "../src/features/repo/repo"
import { Runs } from "../src/features/runs/runs"
import { Secrets } from "../src/features/secrets/secrets"
import { Todos } from "../src/features/todos/todos"
import { Views } from "../src/features/views/views"
import { openTestApp } from "../src/test/chatApi"
import { renderRepositoryPages } from "./fixtures/repository-pages"

test("an empty notification panel says No notifications", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const services = await app.runPromise(Effect.all({
      auth: Effect.service(Auth), attention: Effect.service(Attention), spend: Effect.service(Spend),
      chat: Effect.service(Chat), flows: Effect.service(FlowsUi), home: Effect.service(Home),
      issues: Effect.service(Issues), pulls: Effect.service(Pulls), repo: Effect.service(Repo),
      runs: Effect.service(Runs), secrets: Effect.service(Secrets), todos: Effect.service(Todos), views: Effect.service(Views),
    }))
    const store = await app.runPromise(Effect.service(AttentionStore))
    await app.runPromise(store.panel.update("panel", row => { row.open = true }))
    for (const query of [services.attention.queries.panel, services.attention.queries.feed, services.attention.queries.detail, services.spend.queries.open]) query.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/", component: NotificationsPanel })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) })
    await router.load()
    await vi.waitFor(() => expect(renderRepositoryPages(router, services)).toContain("No notifications"))
  } finally { await app.dispose() }
})
