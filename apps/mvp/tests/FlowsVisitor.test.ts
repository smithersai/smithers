import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { AppProviders } from "../src/AppProviders"
import { AuthStore, SESSION } from "../src/features/auth/store"
import { FlowsScreen } from "../src/screens/flows/FlowsScreen"
import { appViews } from "../src/test/appViews"
import { openTestApp } from "../src/test/chatApi"

test("a visitor gets sign-in instead of an unusable New flow action", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const views = await app.runPromise(appViews)
    const store = await app.runPromise(Effect.service(AuthStore))
    views.auth.queries.session.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/app/flows", component: FlowsScreen })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/flows"] }) })
    await router.load()
    const render = () => renderToStaticMarkup(createElement(AppProviders, { views }, createElement(RouterProvider, { router })))
    await app.runPromise(store.session.update(SESSION, (row) => { row.status = "signed_out"; row.available = true }))
    await vi.waitFor(() => {
      expect(render()).toContain("Sign in with GitHub")
      expect(render()).toContain("return=%2Fapp%2Fflows")
      expect(render()).not.toContain("New flow")
    })
    await app.runPromise(store.session.update(SESSION, (row) => { row.status = "signed_in"; row.role = "member" }))
    await vi.waitFor(() => expect(render()).toContain("New flow"))
  } finally { await app.dispose() }
}, 60_000)
