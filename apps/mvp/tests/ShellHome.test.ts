import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { Auth } from "../src/features/auth/auth"
import { AuthStore } from "../src/features/auth/store"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import { Landing } from "../src/screens/landing/Landing"
import { openTestApp } from "../src/test/chatApi"

test("home names the app for a signed-in person and offers a visitor a start", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const auth = await app.runPromise(Effect.service(Auth))
    const store = await app.runPromise(Effect.service(AuthStore))
    auth.queries.session.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/", component: Landing })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) })
    await router.load()
    for (const [status, label] of [["signed_out", "Get started for free"], ["signed_in", "Open Smithers"]] as const) {
      await app.runPromise(store.session.update("session", row => { row.status = status; row.login = status === "signed_in" ? "member" : null }))
      await vi.waitFor(() => {
        const html = renderToStaticMarkup(createElement(AuthProvider, { value: auth }, createElement(RouterProvider, { router })))
        expect(html).toContain(`>${label}</a>`)
        if (status === "signed_in") expect(html).not.toContain("Get started for free")
        expect(html).toContain('href="/app"')
      })
    }
  } finally { await app.dispose() }
})
