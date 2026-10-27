import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { Auth } from "../src/features/auth/auth"
import { AuthStore } from "../src/features/auth/store"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import { SettingsScreen } from "../src/screens/settings/SettingsScreen"
import { openTestApp } from "../src/test/chatApi"

test("a visitor can sign in from personal settings and return there", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const auth = await app.runPromise(Effect.service(Auth))
    const store = await app.runPromise(Effect.service(AuthStore))
    await app.runPromise(store.session.update("session", row => { row.status = "signed_out"; row.available = true }))
    auth.queries.session.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/app/settings", component: SettingsScreen })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/settings"] }) })
    await router.load()
    await vi.waitFor(() => {
      const html = renderToStaticMarkup(createElement(AuthProvider, { value: auth }, createElement(RouterProvider, { router })))
      expect(html).toContain("Sign in with GitHub")
      expect(html).toContain('href="/api/auth/sign-in?return=%2Fapp%2Fsettings"')
      expect(html).toContain('href="/app"')
    })
  } finally { await app.dispose() }
})
