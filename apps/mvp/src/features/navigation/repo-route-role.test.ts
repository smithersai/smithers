import { expect, test, vi } from "vitest"
import { dom } from "../../../tests/fixtures/dom"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom) })
const { router } = await import("../../router")

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
    issues: { actions: { warm: async () => undefined, open: async () => undefined } },
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
