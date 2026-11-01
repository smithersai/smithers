import { expect, test, vi } from "vitest"
import { dom } from "../../../tests/fixtures/dom"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom) })
const { router } = await import("../../router")

type Enter = (load: unknown) => Promise<void>

// A TODO's page shows the repository's header, whose row only exists once the repository's route opened: a direct visit
// to /$owner/$repo/stack/$number once rendered no header, and with it no bell.
test("a direct visit to a TODO opens its repository, so the page has the repository's header", async () => {
  const openRoute = vi.fn()
  const open = vi.fn()
  const pathname = "/acme/widgets/stack/9"
  await (router.routesById["/$owner/$repo/stack/$number"].options.beforeLoad as unknown as Enter)({
    context: {
      repo: {
        actions: {
          warmRoute: () => undefined,
          openRoute,
          canonicalName: async (owner: string, repo: string) => `${owner}/${repo}`,
          role: () => undefined,
        },
      },
      home: { actions: { warm: () => undefined, open: () => undefined } },
      todos: { actions: { warm: () => undefined, open } },
    },
    params: { owner: "acme", repo: "widgets", number: 9 },
    location: { pathname, searchStr: "", hash: "" },
    preload: false,
    abortController: new AbortController(),
  })
  expect(openRoute).toHaveBeenCalledWith("tree", expect.objectContaining({ owner: "acme", repo: "widgets" }), {})
  expect(open).toHaveBeenCalledWith("acme", "widgets", 9)
})
