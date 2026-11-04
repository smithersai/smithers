import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router"
import { act, createElement, type ReactNode } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { dom } from "../../../tests/fixtures/dom"

Object.assign(globalThis, { self: dom, customElements: dom.customElements })
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
