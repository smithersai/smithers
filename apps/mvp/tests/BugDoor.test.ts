import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { vi } from "vitest"
import { ChatProvider } from "../src/AppContext"
import { Chat } from "../src/features/chat/chat"
import { Auth } from "../src/features/auth/auth"
import { AuthStore } from "../src/features/auth/store"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import { PluginsUi } from "../src/plugins/ui"
import { PluginsProvider } from "../src/plugins/components/PluginsContext"
import { PluginScreen } from "../src/screens/plugin/PluginScreen"
import { openTestApp } from "../src/test/chatApi"
import { isRedirect } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { router } from "../src/router"

test("client navigation through /bug redirects to the in-app form", () => {
  const route = router.routesById["/bug"]
  expect(route).toBeDefined()
  try {
    // The alias has no data dependencies; exercise the production route's hook.
    const beforeLoad = route.options.beforeLoad as () => unknown
    beforeLoad()
    throw new Error("Expected a redirect")
  } catch (error) {
    expect(isRedirect(error)).toBe(true)
    expect((error as { options: { href: string } }).options.href).toBe("/app/bugs/report")
  }
})


test("signed-out plugin visitors have a sign-in path while report submission stays gated", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const auth = await app.runPromise(Effect.service(Auth))
    const store = await app.runPromise(Effect.service(AuthStore))
    const plugins = await app.runPromise(Effect.service(PluginsUi))
    await app.runPromise(store.session.update("session", row => { row.status = "signed_out"; row.available = true }))
    const chat = await app.runPromise(Effect.service(Chat))
    for (const query of [auth.queries.session, auth.queries.confirmed, chat.queries.connection, chat.queries.place, chat.queries.of(null).queued]) query.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/app/$plugin/$", component: PluginScreen })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/bugs/report"] }) })
    await router.load()
    await vi.waitFor(() => {
      const html = renderToStaticMarkup(createElement(ChatProvider, { value: chat }, createElement(AuthProvider, { value: auth },
        createElement(PluginsProvider, { value: plugins }, createElement(RouterProvider, { router })))))
      expect(html).toContain("Sign in with GitHub")
      expect(html).toContain('href="/api/auth/sign-in?return=%2Fapp%2Fbugs%2Freport"')
      expect(html).not.toContain('type="submit"')
    })
    const view = plugins.actions.viewAt("bugs", "report")!
    expect(plugins.actions.allows(view.minimum, { signedIn: false, role: null })).toBe(false)
  } finally { await app.dispose() }
})
