import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { expect, test, vi } from "vitest"
import { AppProviders } from "../src/AppProviders"
import { PluginScreen } from "../src/screens/plugin/PluginScreen"
import { appViews } from "../src/test/appViews"
import { nodeDevice, openTestApp } from "../src/test/chatApi"

test("a full-size plugin qualifies its cached contents with the shared offline status", async () => {
  const app = openTestApp({ host: nodeDevice({ isOnline: () => false }) })
  try {
    const views = await app.runPromise(appViews)
    const { auth, chat } = views
    for (const query of [auth.queries.session, auth.queries.confirmed, chat.queries.connection, chat.queries.place, chat.queries.of(null).queued]) query.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/app/$plugin", component: PluginScreen })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/queue"] }) })
    await router.load()
    const render = () => renderToStaticMarkup(createElement(AppProviders, { views }, createElement(RouterProvider, { router })))
    await vi.waitFor(() => {
      expect(render()).toContain('aria-label="Connection"')
      expect(render()).toContain("Offline")
    })
  } finally { await app.dispose() }
}, 60_000)
