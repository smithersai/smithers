import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { Auth } from "../src/features/auth/auth"
import { AuthStore, SESSION } from "../src/features/auth/store"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import { FlowsUi } from "../src/features/flows-ui/flowsUi"
import { FlowsUiProvider } from "../src/features/flows-ui/components/FlowsUiContext"
import { FlowsScreen } from "../src/screens/flows/FlowsScreen"
import { openTestApp } from "../src/test/chatApi"

test("a visitor gets sign-in instead of an unusable New flow action", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const { auth, flows, store } = await app.runPromise(Effect.all({
      auth: Effect.service(Auth), flows: Effect.service(FlowsUi), store: Effect.service(AuthStore),
    }))
    auth.queries.session.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/app/flows", component: FlowsScreen })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/flows"] }) })
    await router.load()
    const render = () => renderToStaticMarkup(createElement(AuthProvider, { value: auth },
      createElement(FlowsUiProvider, { value: flows }, createElement(RouterProvider, { router }))))
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
