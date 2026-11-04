import { expect, test, vi } from "vitest"
import { dom } from "../../../tests/fixtures/dom"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom) })
const { createAppRouter, FIRST_LOAD_PENDING_MIN_MS, FIRST_LOAD_PENDING_MS, PENDING_MIN_MS, PENDING_MS, router } = await import("../../router")
const { createMemoryHistory } = await import("@tanstack/react-router")

type Enter = (load: unknown) => Promise<void>

/** An issue route's context, with the repository's About held until `release`. */
const contextOf = () => {
  let release!: () => void
  const about = new Promise<void>((resolve) => (release = resolve))
  const role = vi.fn()
  const context = {
    repo: {
      actions: {
        warmRoute: () => undefined,
        openRoute: () => undefined,
        canonicalName: async (owner: string, repo: string) => {
          await about
          return `${owner}/${repo}`
        },
        role,
      },
    },
    home: { actions: { warm: () => undefined, open: () => undefined } },
    todos: { actions: { warm: () => undefined, open: () => undefined } },
    issues: { actions: { warm: async () => undefined, open: async () => undefined, readIssue: vi.fn(), restoreSearch: vi.fn() } },
  }
  return { context, role, release }
}

const load = (preload: boolean) => ({
  location: { pathname: "/acme/widgets/issues/7", searchStr: "", hash: "" },
  preload,
  abortController: new AbortController(),
})

// The cold issue page's waterfall (e2e/issue-waterfall.spec.ts) read the role twice: once as the issues warmed and
// again once the route opened, after the repository's About. A navigation asks once, as it starts.
test("a navigation to a repository page asks the person's role once, before the route's checks answer", async () => {
  const { context, role, release } = contextOf()
  const entering = (router.routesById["/$owner/$repo/issues/$number"].options.beforeLoad as unknown as Enter)({
    context,
    params: { owner: "acme", repo: "widgets", number: 7 },
    ...load(false),
  })
  await vi.waitFor(() => expect(role).toHaveBeenCalledWith("acme", "widgets", false))
  expect(context.issues.actions.readIssue).toHaveBeenCalledExactlyOnceWith("acme", "widgets", 7)
  release()
  await entering
  expect(role).toHaveBeenCalledTimes(1)
})

test("a link's preload asks no role", async () => {
  const { context, role, release } = contextOf()
  release()
  await (router.routesById["/$owner/$repo/issues/$number"].options.beforeLoad as unknown as Enter)({
    context,
    params: { owner: "acme", repo: "widgets", number: 7 },
    ...load(true),
  })
  expect(role).not.toHaveBeenCalled()
})

// Proof (a) on production, 2026-11-04: a cold issues list showed its search box 2.8-3.8 s after its first rows, as the
// route's warm (up to `pageWait`) and then GitHub's spelling of the name (up to `pageWait` again) ran one after the other.
test("the issues list asks GitHub's spelling of the repository's name while its warm is still loading", async () => {
  const { context, release } = contextOf()
  let warmed!: () => void
  const warming = new Promise<void>((resolve) => (warmed = resolve))
  const canonicalName = vi.fn(context.repo.actions.canonicalName)
  const entering = (router.routesById["/$owner/$repo/issues"].options.beforeLoad as unknown as Enter)({
    context: { ...context, repo: { actions: { ...context.repo.actions, warmRoute: () => warming, canonicalName } } },
    params: { owner: "acme", repo: "widgets" },
    search: {},
    ...load(false),
    location: { pathname: "/acme/widgets/issues", searchStr: "", hash: "" },
  })
  await vi.waitFor(() => expect(canonicalName).toHaveBeenCalledWith("acme", "widgets"))
  expect(context.issues.actions.restoreSearch).toHaveBeenCalledExactlyOnceWith("acme", "widgets", undefined)
  warmed()
  release()
  await entering
})

// Proof (a) on production, 2026-11-04: the first paint showed a cold issues list's rows at about 0.8 s, but its search box
// came with the list itself, once the route resolved, 2.3-3.8 s later. Its pending screen, with the box, now shows as soon
// as the app renders; later navigations keep the previous page as long as before (decision 0020).
test("a cold page's first load shows the issues list's pending screen at once, then navigations wait as before", async () => {
  const { context, release } = contextOf()
  const cold = createAppRouter({ history: createMemoryHistory({ initialEntries: ["/acme/widgets/issues"] }), context: context as never })
  const loading = cold.load()
  await vi.waitFor(() => {
    const match = cold.state.matches.find((match) => match.routeId === "/$owner/$repo/issues")
    expect(match?.status).toBe("pending")
  }, { timeout: 500 })
  // Shown at once, and gone at once when the page loaded: a fast first load waits no minimum (review, 2026-11-04).
  expect([cold.options.defaultPendingMs, cold.options.defaultPendingMinMs]).toEqual([FIRST_LOAD_PENDING_MS, FIRST_LOAD_PENDING_MIN_MS])
  expect(router.routesById["/$owner/$repo/issues"].options.pendingComponent?.name).toBe("IssuesPendingScreen")
  // Pending screens that are a loading state keep the usual wait on the first load too: a cold path paints none.
  for (const route of Object.values(router.routesById) as Array<{ id: string; options: { pendingComponent?: { name: string }; pendingMs?: number; pendingMinMs?: number } }>) {
    if (route.options.pendingComponent === undefined || ["IssuesPendingScreen", "IssuePendingScreen"].includes(route.options.pendingComponent.name)) continue
    expect([route.id, route.options.pendingMs, route.options.pendingMinMs]).toEqual([route.id, PENDING_MS, PENDING_MIN_MS])
  }
  release()
  await loading
  expect(cold.state.matches.find((match) => match.routeId === "/$owner/$repo/issues")?.status).toBe("success")
  await vi.waitFor(() => expect([cold.options.defaultPendingMs, cold.options.defaultPendingMinMs]).toEqual([PENDING_MS, PENDING_MIN_MS]))
})
