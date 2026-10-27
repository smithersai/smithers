import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { afterAll, expect, test } from "vitest"
import { dom } from "../../../tests/fixtures/dom"
import { navigateTo } from "./router"

Object.assign(globalThis, { self: dom, scrollTo: dom.scrollTo.bind(dom) })
afterAll(() => dom.happyDOM.close())

test("navigation refuses unknown paths without leaving the current page", async () => {
  const root = createRootRoute()
  const app = createRoute({ getParentRoute: () => root, path: "/app" })
  const router = createRouter({ isServer: false, routeTree: root.addChildren([app]), history: createMemoryHistory({ initialEntries: ["/app"] }) })
  await router.load()
  const navigate = navigateTo(router, "http://localhost")
  await expect(navigate("/nope-page")).rejects.toThrow("Page not found")
  expect(router.state.location.pathname).toBe("/app")
  await navigate("/app?ok=1#top")
  expect(router.state.location.pathname).toBe("/app")
  expect(router.state.location.search).toEqual({ ok: 1 })
  expect(router.state.location.hash).toBe("top")
})
