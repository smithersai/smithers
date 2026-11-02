import { expect, test } from "vitest"
import { type EnterContext, enterSynced, type Load } from "./routeEnter"

// A cold issue page on production, 2026-11-02: the route waited for the repository's About (1.4 s for a private
// repository) and a second role read before it opened the page, whose shapes were asked for 2.6 s late. A synced page
// opens on its own rows; the About, the home and the canonical name run beside it.

const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => (resolve = done))
  return { promise, resolve }
}

const harness = (location = "/Acme/Widgets/issues/7") => {
  const calls: Array<string> = []
  const about = deferred<unknown>()
  const canonical = deferred<string | undefined>()
  const context: EnterContext = {
    shownPath: undefined,
    replace: (href) => calls.push(`replace ${href}`),
    repo: {
      actions: {
        warmRoute: () => (calls.push("about"), about.promise),
        openRoute: () => calls.push("openRoute"),
        role: () => calls.push("role"),
        canonicalName: () => (calls.push("canonical"), canonical.promise),
      },
    },
    home: { actions: { warm: async () => calls.push("home"), open: () => calls.push("homeOpen") } },
  }
  const load = (preload = false): Load => ({
    location: { pathname: location, searchStr: "?q=1", hash: "" },
    preload,
    abortController: new AbortController(),
  })
  return { calls, about, canonical, context, load }
}

test("a synced page opens on its own rows while the About and the canonical name are still being read", async () => {
  const { calls, about, canonical, context, load } = harness()
  await enterSynced(context, { owner: "Acme", repo: "Widgets" }, load(), async () => calls.push("warm"), async () => calls.push("open"))
  // The page opened with the About still in flight: nothing it shows waited for it.
  expect(calls).toEqual(["about", "home", "warm", "openRoute", "homeOpen", "role", "open"])
  about.resolve(undefined)
  await new Promise((done) => setTimeout(done, 0))
  expect(calls.at(-1)).toBe("canonical")
  canonical.resolve("acme/widgets")
  await new Promise((done) => setTimeout(done, 0))
  // The canonical name replaces the location once known, keeping the rest of it.
  expect(calls.at(-1)).toBe("replace /acme/widgets/issues/7?q=1")
})

test("a canonical name needs no replacement; a preload only warms; a navigation taken over opens nothing", async () => {
  const same = harness("/acme/widgets/issues")
  await enterSynced(same.context, { owner: "acme", repo: "widgets" }, same.load(), async () => undefined, async () => same.calls.push("open"))
  same.about.resolve(undefined)
  same.canonical.resolve("acme/widgets")
  await new Promise((done) => setTimeout(done, 0))
  expect(same.calls.some((call) => call.startsWith("replace"))).toBe(false)

  const preload = harness()
  await enterSynced(preload.context, { owner: "Acme", repo: "Widgets" }, preload.load(true), async () => preload.calls.push("warm"), async () => preload.calls.push("open"))
  expect(preload.calls).toEqual(["about", "home", "warm"])

  const taken = harness()
  const load = taken.load()
  const opened = enterSynced(taken.context, { owner: "Acme", repo: "Widgets" }, load, async () => {
    load.abortController.abort()
  }, async () => taken.calls.push("open"))
  await opened
  taken.about.resolve(undefined)
  taken.canonical.resolve("acme/widgets")
  await new Promise((done) => setTimeout(done, 0))
  expect(taken.calls).toEqual(["about", "home"])
})
