import { browser, page } from "./fixtures/docsBrowser"
import { createServer } from "node:http"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"
import { DocsClient } from "../src/features/docs/api"
import { DocsPage } from "../src/features/docs/components/DocsPage"
import { DocsProvider } from "../src/features/docs/components/DocsContext"
import { Docs } from "../src/features/docs/docs"
import { emptyCurrent } from "../src/features/docs/rows"
import { DocsStore } from "../src/features/docs/store"

test("ordinary and modified section links open their original destination; whole pages stay in the app", async () => {
  const site = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html")
    response.end('<h1 id="retry">Retry</h1>')
  })
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
  const address = site.address()
  if (address === null || typeof address === "string") throw new Error("Docs site did not listen")
  const origin = `http://127.0.0.1:${address.port}`
  page.url = origin
  const runtime = ManagedRuntime.make(Docs.layer.pipe(
    Layer.provideMerge(DocsStore.layer),
    Layer.provide(DocsClient.layer({ origin }).pipe(Layer.provide(FetchHttpClient.layer))),
  ))
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  // Observe the real DOM boundary without replacing window.open or its behavior.
  const opened = vi.spyOn(window, "open")
  try {
    const { docs, store } = await runtime.runPromise(Effect.all({ docs: Effect.service(Docs), store: Effect.service(DocsStore) }))
    const path = "/guide/retrying.md"
    const initial = `/acme/widgets/docs${path}`
    await runtime.runPromise(Effect.gen(function* () {
      yield* store.current.update(emptyCurrent.id, (row) => Object.assign(row, {
        owner: "acme", name: "widgets", repoKey: "acme/widgets", path, pageKey: `acme/widgets:${path}`,
      }))
      yield* store.indexes.insert({
        key: "acme/widgets", repoId: "github/acme/widgets", state: "ready", title: "Docs", summary: null, code: null,
        pages: [{ title: "Retrying", path }, { title: "Schedule", path: "/reference/schedule.md" }],
      })
      yield* store.pages.insert({
        key: `acme/widgets:${path}`, repoId: "github/acme/widgets", state: "text", title: "Retrying",
        url: `${origin}${path}`, code: null,
        text: "[Cross-reference](../reference/schedule.md#retry)\n\n[Same page](#retry)\n\n[Whole page](../reference/schedule.md)",
      })
    }))
    const parent = createRootRoute()
    const route = createRoute({ getParentRoute: () => parent, path: "/$owner/$repo/docs/$", component: DocsPage })
    const router = createRouter({
      isServer: false, routeTree: parent.addChildren([route]),
      history: createMemoryHistory({ initialEntries: [initial] }),
    })
    await act(async () => {
      await router.load()
      root.render(createElement(DocsProvider, { value: docs }, createElement(RouterProvider, { router })))
    })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelectorAll(".sui-md-link")).toHaveLength(3)
    })
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".sui-md-link")]
    const modifiers = [{}, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }]
    for (const [link, expected] of [
      [links[0]!, `${origin}/reference/schedule.md#retry`],
      [links[1]!, `${origin}${path}#retry`],
    ] as const) {
      expect(link.href).toBe(expected)
      for (const modifier of modifiers) {
        const count = opened.mock.calls.length
        await act(async () => {
          link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }))
        })
        expect(opened).toHaveBeenCalledTimes(count + 1)
        expect(opened).toHaveBeenLastCalledWith(expected, "_blank", "noopener,noreferrer")
        expect(router.state.location.pathname).toBe(initial)
      }
    }
    // Modified whole-page links retain the app URL; an ordinary click uses the router.
    await act(async () => {
      links[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }))
    })
    expect(opened).toHaveBeenLastCalledWith("/acme/widgets/docs/reference/schedule.md", "_blank", "noopener,noreferrer")
    const count = opened.mock.calls.length
    await act(async () => {
      links[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    })
    expect(opened).toHaveBeenCalledTimes(count)
    expect(router.state.location.pathname).toBe("/acme/widgets/docs/reference/schedule.md")
    await browser.waitUntilComplete()
    const destinations = browser.defaultContext.pages.slice(1).map((page) => page.mainFrame.url)
    expect(destinations).toEqual([
      ...Array<string>(4).fill(`${origin}/reference/schedule.md#retry`),
      ...Array<string>(4).fill(`${origin}${path}#retry`),
      `${origin}/acme/widgets/docs/reference/schedule.md`,
    ])
    for (const popup of browser.defaultContext.pages.slice(1)) {
      expect(popup.mainFrame.document.getElementById("retry")?.textContent).toBe("Retry")
    }
  } finally {
    opened.mockRestore()
    await act(async () => root.unmount())
    container.remove()
    await runtime.dispose()
    await browser.close()
    site.closeAllConnections()
    await new Promise<void>((resolve, reject) => site.close((error) => error ? reject(error) : resolve()))
  }
})
