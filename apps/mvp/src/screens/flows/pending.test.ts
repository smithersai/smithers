import { expect, test } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { router } from "../../router"
import { FlowPendingScreen } from "./FlowPendingScreen"

// A flow's editor routes wait on device storage and the engine in `beforeLoad`; without a pending screen a direct
// visit painted a blank window for seconds (docs/work/ui-polish.md). Each keeps its frame while it waits.
test.each(["/app/flows/new", "/app/flows/drafts/$draftId", "/app/flows/code/$name"] as const)(
  "%s shows the flow pending screen while it opens",
  (id) => {
    expect(router.routesById[id].options.pendingComponent).toBe(FlowPendingScreen)
  },
)

test("the pending frame keeps navigation without a loading state", async () => {
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: "/app/flows", component: FlowPendingScreen })
  const pending = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/flows"] }) })
  await pending.load()
  const html = renderToStaticMarkup(createElement(RouterProvider, { router: pending }))
  expect(html).toContain('aria-label="Flows"')
  expect(html).toContain('href="/app/flows"')
  expect(html).not.toMatch(/aria-busy|progressbar|data-slot="skeleton"/)
})
