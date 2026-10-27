import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { ChatProvider } from "../src/AppContext"
import { Auth } from "../src/features/auth/auth"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import { Chat } from "../src/features/chat/chat"
import { PluginsProvider } from "../src/plugins/components/PluginsContext"
import { PluginsUi } from "../src/plugins/ui"
import { PluginScreen } from "../src/screens/plugin/PluginScreen"
import { nodeDevice, openTestApp } from "../src/test/chatApi"

test("a full-size plugin qualifies its cached contents with the shared offline status", async () => {
  const app = openTestApp({ host: nodeDevice({ isOnline: () => false }) })
  try {
    const { auth, chat, plugins } = await app.runPromise(Effect.all({ auth: Effect.service(Auth), chat: Effect.service(Chat), plugins: Effect.service(PluginsUi) }))
    for (const query of [auth.queries.session, auth.queries.confirmed, chat.queries.connection, chat.queries.place, chat.queries.of(null).queued]) query.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/app/$plugin", component: PluginScreen })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/queue"] }) })
    await router.load()
    const render = () => renderToStaticMarkup(createElement(ChatProvider, { value: chat }, createElement(AuthProvider, { value: auth }, createElement(PluginsProvider, { value: plugins }, createElement(RouterProvider, { router })))))
    await vi.waitFor(() => {
      expect(render()).toContain('aria-label="Connection"')
      expect(render()).toContain("Offline")
    })
  } finally { await app.dispose() }
}, 60_000)
