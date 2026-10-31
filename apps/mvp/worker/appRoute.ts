import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { ROUTE_PATHS } from "../src/routePaths"
import { isRepository } from "../src/features/repo/contract"
import { issueNumberOf } from "../src/features/issues/contract"
import { PULL_TABS } from "../src/features/pulls/contract"
import { todoNumberOf } from "../src/features/todos/contract"
import { BUILTIN_MANIFESTS } from "../src/plugins/manifests"

// No loaders or I/O: the same TanStack path grammar as the view, at the document boundary.
const root = createRootRoute()
const routes = Object.values(ROUTE_PATHS).filter((path) => !path.includes("$plugin")).map((path) => createRoute({ getParentRoute: () => root, path }))
// A plugin's view: `/app/<plugin>/<path>`, or a repository's page `/$owner/$repo/-/<plugin>/<path>` (decision 0128 §8).
const plugins = BUILTIN_MANIFESTS.flatMap((plugin) => (plugin.contributes.views as ReadonlyArray<{ readonly scope: string; readonly path: string }>).map((view) =>
  createRoute({
    getParentRoute: () => root,
    path: `${view.scope === "repository" ? "/$owner/$repo/-" : "/app"}/${plugin.id}${view.path === "" ? "" : `/${view.path}`}`,
  })))
const router = createRouter({ routeTree: root.addChildren([...routes, ...plugins]), history: createMemoryHistory(), isServer: true })

/** Whether this URL names an app route; resource existence is still decided by its own read. */
export const isAppRoute = (pathname: string): boolean => {
  const [, params, route] = router.getMatchedRoutes(pathname)
  if (route === undefined || params["**"] !== undefined) return false
  if (params.owner !== undefined && !isRepository(params.owner, params.repo!)) return false
  if (params.number !== undefined && (pathname.split("/")[3] === "stack" ? todoNumberOf(params.number) : issueNumberOf(params.number)) === undefined) return false
  return params.tab === undefined || (PULL_TABS as ReadonlyArray<string>).includes(params.tab) && params.tab !== "conversation"
}
