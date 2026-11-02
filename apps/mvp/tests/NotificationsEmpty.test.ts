import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { AttentionStore } from "../src/features/attention/store"
import { NotificationsPanel } from "../src/features/attention/components/NotificationsPanel"
import { appViews } from "../src/test/appViews"
import { openTestApp } from "../src/test/chatApi"
import { renderRepositoryPages } from "./fixtures/repository-pages"

test("an empty notification panel says No notifications", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const services = await app.runPromise(appViews)
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
