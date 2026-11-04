import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router"
import { act, createElement, type ReactNode } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect } from "effect"
import { Searched } from "./schema"
import { dom } from "../../../tests/fixtures/dom"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom) })
const { createRoot } = await import("react-dom/client")
const { IssueSearchBox } = await import("./components/IssueSearchBox")
const { IssuesProvider } = await import("./components/IssuesContext")

const host = dom.document.createElement("div")
dom.document.body.appendChild(host)
const root = createRoot(host as never)
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/acme/widgets/issues"] }) })
const issues = { actions: { search: vi.fn() } } as never

const show = (box: ReactNode) =>
  act(() => root.render(createElement(IssuesProvider, { value: issues }, createElement(RouterContextProvider, { router, children: box }))))
const box = (repo: string, pending: boolean) => createElement(IssueSearchBox, { key: pending ? "pending" : "list", owner: "acme", repo, q: "#12", ask: true, pending })
const input = () => dom.document.querySelector("input") as unknown as HTMLInputElement
const typedIn = async (repo: string) => {
  await show(box(repo, true))
  input().focus()
  input().setSelectionRange(1, 3)
}

afterEach(async () => {
  await show(null)
  ;(dom.document.activeElement as unknown as HTMLElement | null)?.blur()
})

test("the list's search box takes the pending screen's focus and caret as it replaces it", async () => {
  await typedIn("widgets")
  await show(box("widgets", false))
  expect(dom.document.activeElement).toBe(input())
  expect([input().selectionStart, input().selectionEnd]).toEqual([1, 3])
})

// Review of the first version (2026-11-04): any box that went focused left its caret for the next list, whenever.
test("a list's own box that goes focused, an abandoned pending screen and another repository's list carry nothing", async () => {
  await show(box("widgets", false))
  input().focus()
  await show(null)
  await show(box("widgets", false))
  expect(dom.document.activeElement).not.toBe(input())
  await show(null)
  await typedIn("widgets")
  await show(null)
  await Promise.resolve()
  await show(box("widgets", false))
  expect(dom.document.activeElement).not.toBe(input())
  await show(null)
  await typedIn("widgets")
  await show(box("gadgets", false))
  expect(dom.document.activeElement).not.toBe(input())
})

// The deploy smoke on c78d0c83 (2026-11-04): the first version's pending screen carried aria-busy, and a cold list
// painted a loading state (e2e/fixtures.ts `watchForSpinners`). It shows the search box and the painted rows' slot only.
test("the list's pending screen is no loading state: no aria-busy, progress bar or skeleton", async () => {
  const { createRoute, RouterProvider } = await import("@tanstack/react-router")
  const { IssuesPendingScreen } = await import("../../screens/issues/IssuesPendingScreen")
  const top = createRootRoute()
  const list = createRoute({ getParentRoute: () => top, path: "/$owner/$repo/issues", component: IssuesPendingScreen })
  const pending = createRouter({ routeTree: top.addChildren([list]), history: createMemoryHistory({ initialEntries: ["/acme/widgets/issues"] }) })
  await pending.load()
  await act(() => root.render(createElement(IssuesProvider, { value: issues }, createElement(RouterProvider, { router: pending }))))
  expect(dom.document.querySelector('input[aria-label="Search issues"]')).not.toBeNull()
  expect(dom.document.querySelector("[data-first-paint-slot]")).not.toBeNull()
  expect(dom.document.querySelector('[aria-busy="true"], [role="progressbar"], [data-slot="skeleton"]')).toBeNull()
})

test("a cold issue waiting for its route and shapes paints no loading state", async () => {
  const { createRoute, RouterProvider } = await import("@tanstack/react-router")
  const { IssuePendingScreen } = await import("../../screens/issues/IssuePendingScreen")
  const { router } = await import("../../router")
  expect(router.routesById["/$owner/$repo/issues/$number"].options.pendingComponent).toBe(IssuePendingScreen)
  const top = createRootRoute()
  const issue = createRoute({ getParentRoute: () => top, path: "/$owner/$repo/issues/$number", component: IssuePendingScreen })
  const pending = createRouter({ routeTree: top.addChildren([issue]), history: createMemoryHistory({ initialEntries: ["/acme/widgets/issues/7"] }) })
  await pending.load()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const searched = yield* Collection.local<Searched, string>({ id: "cold-issue-searched", schema: Searched, getKey: (row) => row.id })
    yield* Effect.promise(async () => { await act(() => root.render(createElement(IssuesProvider, { value: { queries: { searched: searched.tanstack } } as never }, createElement(RouterProvider, { router: pending })))) })
    expect(dom.document.querySelector(".issue-unread-heading")?.textContent).toBe("Issue #7")
    expect(dom.document.querySelector("[data-first-paint-slot]")).not.toBeNull()
    expect(dom.document.querySelector('[aria-busy="true"], [role="progressbar"], [data-slot="skeleton"]')).toBeNull()
    yield* Effect.promise(async () => { await show(null) })
  })))
})
