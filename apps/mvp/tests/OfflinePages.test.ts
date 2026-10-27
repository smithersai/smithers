import { dom } from "./fixtures/dom"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { ChatProvider } from "../src/AppContext"
import { Branch } from "../src/features/branch/branch"
import { BranchProvider } from "../src/features/branch/components/BranchContext"
import { Chat } from "../src/features/chat/chat"
import { wentOffline, retry } from "../src/features/chat/actions"
import { BranchPendingScreen } from "../src/screens/branch/BranchPendingScreen"
import { RepoPendingScreen } from "../src/screens/repo/RepoPendingScreen"
import { openTestApp } from "../src/test/chatApi"

Object.assign(globalThis, { self: dom, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver })
afterAll(() => dom.happyDOM.close())

test.each(["file", "issue"] as const)("uncached %s: pending and offline pages retain navigation, then recover", async (kind) => {
  const app = openTestApp({ sessionLifecycle: false })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    const { chat, branch } = await app.runPromise(Effect.all({ chat: Effect.service(Chat), branch: Effect.service(Branch) }))
    const rootRoute = createRootRoute()
    const path = kind === "file" ? "/$owner/$repo/blob/$ref/$" : "/$owner/$repo/issues/$number"
    const pending = createRoute({ getParentRoute: () => rootRoute, path, component: kind === "file" ? BranchPendingScreen : RepoPendingScreen })
    const home = createRoute({ getParentRoute: () => rootRoute, path: "/app", component: () => createElement("h1", null, "Chat") })
    const url = kind === "file" ? "/octocat/Spoon-Knife/blob/main/never-opened.ts" : "/octocat/Spoon-Knife/issues/123"
    const router = createRouter({ isServer: false, routeTree: rootRoute.addChildren([pending, home]), history: createMemoryHistory({ initialEntries: [url] }) })
    await act(async () => {
      await router.load()
      root.render(createElement(ChatProvider, { value: chat }, createElement(BranchProvider, { value: branch }, createElement(RouterProvider, { router }))))
    })
    const until = (assertion: () => void) => vi.waitFor(() => act(async () => assertion()), { timeout: 10_000 })
    await until(() => expect(container.querySelector('a[href="/app"]')?.textContent).toContain("Back to chat"))
    expect(container.querySelector("h1")?.textContent).toContain("octocat / Spoon-Knife")
    await act(async () => { await app.runPromise(wentOffline) })
    await until(() => expect(container.textContent).toContain("Offline"))
    expect(container.querySelector(".sui-empty-state")?.textContent ?? container.textContent).toContain("Back to chat")
    await act(async () => { await app.runPromise(retry("online")) })
    await until(() => expect(container.textContent).not.toContain("Offline"))
    await act(async () => {
      container.querySelector('a[href="/app"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
    })
    await until(() => expect(container.querySelector("h1")?.textContent).toBe("Chat"))
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await app.dispose()
  }
})
