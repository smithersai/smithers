import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import type { ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { HomeProvider } from "../../features/home/components/HomeContext"
import { HomeTabs } from "../../features/home/components/HomeTabs"

// The repository's tabs as each page shows them (src/router.tsx): Home on `/$owner/$repo`, Code on a directory or a
// file, Docs on the docs, rendered at `path` over the home layer `home`, for tabs.test.ts.
export const renderTabsAt = async (path: string, home: ComponentProps<typeof HomeProvider>["value"]) => {
  const root = createRootRoute()
  const page = (route: string, active: "home" | "code" | "docs") =>
    createRoute({ getParentRoute: () => root, path: route, component: () => <HomeTabs active={active} /> })
  const router = createRouter({
    routeTree: root.addChildren([
      page("/$owner/$repo", "home"),
      page("/$owner/$repo/tree/$ref/$", "code"),
      page("/$owner/$repo/blob/$ref/$", "code"),
      page("/$owner/$repo/docs", "docs"),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  return renderToStaticMarkup(
    <HomeProvider value={home}>
      <RouterProvider router={router} />
    </HomeProvider>,
  )
}
