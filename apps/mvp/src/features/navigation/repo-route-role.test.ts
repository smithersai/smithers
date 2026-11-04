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
    ...load(false),
    location: { pathname: "/acme/widgets/issues", searchStr: "", hash: "" },
  })
  await vi.waitFor(() => expect(canonicalName).toHaveBeenCalledWith("acme", "widgets"))
  warmed()
  release()
  await entering
})
