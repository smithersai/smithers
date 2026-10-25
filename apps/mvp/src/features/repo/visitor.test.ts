import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { testFile } from "../../../worker/test/harness"
import { type RepoHarness, repoHarness, resetRepos } from "../../../worker/test/repos"
import { type DeviceOptions, openTab, type Tab } from "../../test/repoDevice"
import { RepoClient, RepoRefused } from "./api"
import { NOT_CLONED, NOT_FOUND } from "./contract"
import { headLoadMs, locateMs } from "./metrics"
import { pageOf } from "./view"

// A visitor's file page (docs/features/repo.md#the-browser): a device with no repository rows yet opens a file by its
// URL, as a link from anywhere does. Only the repositories' shape would tell the device the clone is ready, and a cold
// shape can take many seconds; RepoApi's refs read the same row in Postgres, so the file must not wait for the shape.
// The shape is held (`shapes: "stalled"`, the faulty shape source; test.faults-by-injection) and RepoApi's real handler
// answers the refs, the file list and the file over the compose Postgres, with Code Storage the scripted provider.

const server = testFile("repo_visitor")
beforeEach(() => resetRepos(server))

const waitFor = <A>(check: () => A, timeout = 10_000) => vi.waitFor(check, { timeout })

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

const open = async (h: RepoHarness, options: Omit<DeviceOptions, "origin"> = {}) => {
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, pageWait: "5 seconds", shapes: "stalled", ...options })
  tabs.push(tab)
  return tab
}

/** Spoon-Knife, public on GitHub, cloned to the end: its id and head commit. */
const seedPublic = (h: RepoHarness) => {
  h.github.publish("octocat", "Spoon-Knife")
  return h.seed("octocat", "Spoon-Knife")
}

/** A navigation to `path` at `ref` in Spoon-Knife, as the router runs it: the route's warm, then its open. */
const navigate = async (tab: Tab, kind: "tree" | "blob", ref: string, path: string) => {
  const params = { owner: "octocat", repo: "Spoon-Knife", ref, _splat: path }
  await tab.repo.actions.warmRoute(kind, params, {})
  tab.repo.actions.openRoute(kind, params, {})
}

/** RepoApi's real client over the harness, whose refs answer as `refs` says, given the real ones. */
const withRefs = (h: RepoHarness, refs: (real: RepoClient["Service"]) => RepoClient["Service"]["refs"]) =>
  Layer.effect(
    RepoClient,
    Effect.map(Effect.service(RepoClient), (real) => RepoClient.of({ ...real, refs: refs(real) })),
  ).pipe(
    Layer.provide(RepoClient.layer({ origin: h.origin, within: "10 seconds" })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
  )

/** How soon a file must show once RepoApi can answer: far less than a cold shape's many seconds. */
const RENDER_WITHIN_MS = 5_000

describe("a visitor's file page, while the repositories' shape hasn't answered", () => {
  test("shows the file as soon as RepoApi answers: its head from the refs, then the file", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await seedPublic(h)
    const tab = await open(h)
    const startedAt = performance.now()

    await navigate(tab, "blob", "main", "README.md")
    // The route's warm loaded it, so the page the router shows is complete.
    expect(tab.repo.lookups.file(id, headSha, "README.md")?.state).toBe("text")
    await waitFor(() => expect(tab.file().file?.state).toBe("text"), RENDER_WITHIN_MS)
    expect(performance.now() - startedAt).toBeLessThan(RENDER_WITHIN_MS)

    // Electric delivered nothing: the view's own resolution says where the file is.
    expect(tab.view().repository).toBeUndefined()
    expect(tab.view().view).toMatchObject({ revision: "main", sha: headSha, path: "README.md", defaultBranch: "main" })
    expect(pageOf(tab.view())).toEqual({
      kind: "files",
      repository: { owner: "octocat", name: "Spoon-Knife", defaultBranch: "main" },
    })
    expect(tab.file().file?.contents).toContain("# Fixture")
    // The refs' answer carried the branches, so the picker needs no second read.
    expect(tab.refs().refs).toMatchObject({ state: "ready", branches: [{ name: "main", sha: headSha }] })
    expect(tab.lines("repo.head.load").map((line) => line.annotations.outcome)).toEqual(["ready"])
    expect(tab.lines("repo.locate")[0]!.annotations).toMatchObject({ source: "refs", outcome: "located" })
    expect(tab.histogramCount(locateMs, { source: "refs", outcome: "located" })).toBe(1)
    expect(tab.histogramCount(headLoadMs, { outcome: "ready" })).toBe(1)
  })

  test("another file of the same repository reads with the head it has, asking RepoApi's refs nothing more", async () => {
    const h = await repoHarness(server)
    const { headSha } = await seedPublic(h)
    const tab = await open(h)
    await navigate(tab, "blob", "main", "README.md")
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))

    await navigate(tab, "blob", "main", "src/index.ts")
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
    expect(tab.view().view).toMatchObject({ sha: headSha, path: "src/index.ts" })
    expect(tab.lines("repo.head.load")).toHaveLength(1)
  })

  test("a directory shows its file list and README the same way", async () => {
    const h = await repoHarness(server)
    const { headSha } = await seedPublic(h)
    const tab = await open(h)
    await navigate(tab, "tree", "main", "")
    await waitFor(() => expect(tab.readme().readme?.state).toBe("text"))
    expect(tab.view().view).toMatchObject({ sha: headSha, path: "", readmePath: "README.md" })
    expect(tab.tree().tree?.paths).toContain("docs/guide.md")
    expect(pageOf(tab.view()).kind).toBe("files")
  })

  test("a ref the repository doesn't have is Not found, and a file it doesn't have says so", async () => {
    const h = await repoHarness(server)
    await seedPublic(h)
    const tab = await open(h)
    await navigate(tab, "blob", "no-such-branch", "README.md")
    await waitFor(() => expect(pageOf(tab.view())).toEqual({ kind: "missing" }))
    expect(tab.lines("repo.locate")[0]!.annotations).toMatchObject({ source: "refs", outcome: "missing" })

    await navigate(tab, "blob", "main", "nope.md")
    await waitFor(() => expect(tab.file().file).toMatchObject({ state: "failed", message: NOT_FOUND }))
    expect(pageOf(tab.view()).kind).toBe("files")
  })

  test("a repository nobody cloned claims nothing until the shape says what it is: then Not cloned", async () => {
    const h = await repoHarness(server)
    h.scripted.publish("octocat", "Spoon-Knife")
    h.github.publish("octocat", "Spoon-Knife")
    const tab = await open(h)
    await navigate(tab, "blob", "main", "README.md")
    // RepoApi's refs say no ready clone; whether it is cloning only the repository's row can say.
    await waitFor(() => expect(tab.lines("repo.head.load").map((line) => line.annotations.outcome)).toEqual(["absent"]))
    expect(tab.histogramCount(headLoadMs, { outcome: "absent" })).toBe(1)
    expect(pageOf(tab.view())).toEqual({ kind: "loading" })
    expect(tab.file().file).toBeUndefined()

    await tab.heal()
    await waitFor(() => expect(pageOf(tab.view())).toEqual({ kind: "empty", text: NOT_CLONED }))
    expect(h.scripted.calls.filter((call) => call.startsWith("readFile"))).toEqual([])
  })

  test("a refs read that fails leaves the page to the repository's row, which shows the file once Electric delivers it", async () => {
    const h = await repoHarness(server)
    const { headSha } = await seedPublic(h)
    let asked = 0
    // The first refs read refuses at once, so the warm sees it fail; the next one only after the warm stopped waiting,
    // so the open finds it still on its way.
    const refused = Effect.fail(new RepoRefused({ status: 503, code: "unavailable" }))
    const tab = await open(h, {
      client: withRefs(h, () => () => Effect.suspend(() => (asked++ === 0 ? refused : Effect.delay(refused, "300 millis")))),
      pageWait: "100 millis",
    })
    await navigate(tab, "blob", "main", "README.md")
    await waitFor(() => expect(tab.lines("repo.head.load").map((line) => line.annotations.outcome)).toEqual(["failed"]))
    expect(pageOf(tab.view())).toEqual({ kind: "loading" })
    expect(asked).toBe(1)
    // The navigation's warm asks again after a failure; the open that follows waits on what the warm asked.
    await navigate(tab, "blob", "main", "README.md")
    await waitFor(() => expect(asked).toBe(2))

    await tab.heal()
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
    expect(tab.view().view).toMatchObject({ sha: headSha, defaultBranch: "main" })
    expect(tab.lines("repo.locate").at(-1)!.annotations).toMatchObject({ source: "row", outcome: "located" })
  })
})

describe("a device that has the repository's ready row", () => {
  test("reads at its head and asks RepoApi's refs nothing", async () => {
    const h = await repoHarness(server)
    const { headSha } = await seedPublic(h)
    const tab = await open(h, { shapes: "real" })
    await navigate(tab, "blob", "main", "README.md")
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
    await waitFor(() => expect(tab.view().repository?.status).toBe("ready"))
    // A fresh device had no row at the first page, so it asked the refs once; that read ends on its own.
    await waitFor(() => expect(tab.lines("repo.head.load")).toHaveLength(1))
    const asked = tab.lines("repo.head.load").length

    await navigate(tab, "blob", "main", "src/index.ts")
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
    expect(tab.view().view).toMatchObject({ sha: headSha, defaultBranch: "main" })
    expect(tab.lines("repo.locate").at(-1)!.annotations).toMatchObject({ source: "row", outcome: "located" })
    expect(tab.lines("repo.head.load")).toHaveLength(asked)
  })
})

describe("a page whose repositories' shape answers before RepoApi's refs", () => {
  /** RepoApi's refs answer 8 s late, after the warm's own deadline and long after a local shape. */
  const slowRefs = (h: RepoHarness) => withRefs(h, (real) => (owner, name) => Effect.delay(real.refs(owner, name), "8 seconds"))

  test("a navigation's warm reads at the row's head, without waiting for the refs", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await seedPublic(h)
    const tab = await open(h, { shapes: "real", client: slowRefs(h) })
    await navigate(tab, "blob", "main", "README.md")
    expect(tab.repo.lookups.file(id, headSha, "README.md")?.state).toBe("text")
    expect(tab.lines("repo.head.load")).toEqual([])
    expect(tab.lines("repo.locate")[0]!.annotations).toMatchObject({ source: "row", outcome: "located" })
  })

  test("a repository nobody cloned: the warm ends on what GitHub says once the shape says so", async () => {
    const h = await repoHarness(server)
    h.scripted.publish("octocat", "Spoon-Knife")
    h.github.publish("octocat", "Spoon-Knife")
    const tab = await open(h, { shapes: "real", client: slowRefs(h) })
    await navigate(tab, "blob", "main", "README.md")
    expect(tab.lines("repo.head.load")).toEqual([])
    await waitFor(() => expect(tab.about().about?.state).toBe("ready"))
    await waitFor(() => expect(pageOf(tab.view())).toEqual({ kind: "empty", text: NOT_CLONED }))
  })
})
