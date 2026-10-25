import { type Duration, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { testFile } from "../../../worker/test/harness"
import { type RepoHarness, repoHarness, resetRepos } from "../../../worker/test/repos"
import { openTab, type Tab } from "../../test/repoDevice"
import { HomeClient, HomeRefused } from "../home/api"
import { homePageOf } from "../home/view"
import { RepoClient, RepoRefused } from "./api"
import { RepoStore } from "./store"

// Warming a repository page (docs/features/navigation.md), driven as the router drives it, with no React: a link's
// hover or focus calls the route's warm, which loads what the page shows into the tab without opening it; a navigation
// warms, then opens, so the page shows complete instead of blank. The tab reaches RepoApi's real handler
// (worker/RepoApi.ts) over the compose Postgres and Electric; Code Storage is the scripted provider, whose `never`
// stands in for a read that doesn't come (test.faults-by-injection).

const server = testFile("repo_warm")
beforeEach(() => resetRepos(server))

const waitFor = <A>(check: () => A) => vi.waitFor(check, { timeout: 10_000 })

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

const open = async (
  h: RepoHarness,
  options: {
    readonly pageWait?: Duration.Input
    readonly client?: Layer.Layer<RepoClient>
    readonly homeClient?: Layer.Layer<HomeClient>
  } = {},
) => {
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, ...options })
  tabs.push(tab)
  return tab
}

/** RepoApi's real client over the harness, with its file list in place of the real one's. */
const withTree = (h: RepoHarness, tree: (real: RepoClient["Service"]) => RepoClient["Service"]["tree"]) =>
  Layer.effect(
    RepoClient,
    Effect.map(Effect.service(RepoClient), (real) => RepoClient.of({ ...real, tree: tree(real) })),
  ).pipe(
    Layer.provide(RepoClient.layer({ origin: h.origin, within: "10 seconds" })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
  )

/** A client whose first read of a file RepoApi couldn't give (503), counting the reads it asked for. */
const readFailsOnce = (h: RepoHarness) => {
  const reads = { count: 0 }
  const layer = Layer.effect(
    RepoClient,
    Effect.map(Effect.service(RepoClient), (real) =>
      RepoClient.of({
        ...real,
        blob: (owner, name, sha, path) =>
          Effect.suspend(() =>
            ++reads.count === 1 ? Effect.fail(new RepoRefused({ status: 503, code: "unavailable" })) : real.blob(owner, name, sha, path)
          ),
      })),
  ).pipe(
    Layer.provide(RepoClient.layer({ origin: h.origin, within: "10 seconds" })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
  )
  return { reads, layer }
}

/** A client whose file list never answers. */
const listNever = (h: RepoHarness) => withTree(h, () => () => Effect.never)

/** A client whose first file list Code Storage couldn't give (503), counting the lists it asked for. */
const listFailsOnce = (h: RepoHarness) => {
  const lists = { count: 0 }
  const layer = withTree(h, (real) => (owner, name, sha) =>
    Effect.suspend(() =>
      ++lists.count === 1 ? Effect.fail(new RepoRefused({ status: 503, code: "unavailable" })) : real.tree(owner, name, sha)
    ))
  return { lists, layer }
}

const SPOON = { owner: "octocat", repo: "Spoon-Knife" } as const

/** The Code Storage reads made so far, by kind. */
const reads = (h: RepoHarness) => ({
  lists: h.scripted.calls.filter((call) => call.startsWith("listFiles")).length,
  files: h.scripted.calls.filter((call) => call.startsWith("readFile")).length,
})

/** What the home part of the page shows. */
const homePage = (tab: Tab) => {
  const { current, home, curated } = tab.home.queries.home.toArray[0]!
  return homePageOf(current, home, curated).kind
}

describe("a link's warm", () => {
  test("a repository still cloning: no file and no home is read, and the warm ends on what GitHub says", async () => {
    const h = await repoHarness(server)
    h.github.publish("octocat", "Spoon-Knife")
    await server.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO repositories (id, owner, name, status)
      VALUES ('github/octocat/spoon-knife', 'octocat', 'Spoon-Knife', 'cloning')`))
    const tab = await open(h)
    // The device syncs the repositories as a page would, before anything is warmed.
    await tab.runtime.runPromise(Effect.flatMap(Effect.service(RepoStore), (store) => Effect.ignore(store.repositories.preload)))
    await waitFor(() => expect(tab.repo.lookups.repository("github/octocat/spoon-knife")?.status).toBe("cloning"))

    await Promise.all([tab.repo.actions.warmRoute("tree", SPOON, {}), tab.home.actions.warm("octocat", "Spoon-Knife")])
    expect(reads(h)).toEqual({ lists: 0, files: 0 })
    expect(tab.lines("repo.head.load")).toEqual([])
    expect(tab.repo.lookups.repository("github/octocat/spoon-knife")?.status).toBe("cloning")
  })

  test("loads the root's files, README and home into the tab without opening the page; the click then opens it complete with no read of its own", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    // Another page is open: warming never moves it.
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Other" }, {})
    tab.home.actions.open("octocat", "Other")

    await Promise.all([tab.repo.actions.warmRoute("tree", SPOON, {}), tab.home.actions.warm("octocat", "Spoon-Knife")])
    expect(tab.repo.lookups.tree(id, headSha)?.state).toBe("ready")
    expect(tab.repo.lookups.readme(id, headSha, "")?.state).toBe("text")
    expect(tab.view().view).toMatchObject({ owner: "octocat", name: "Other" })
    expect(tab.home.queries.home.toArray[0]!.current).toMatchObject({ owner: "octocat", name: "Other" })
    const warmed = reads(h)

    tab.repo.actions.openRoute("tree", SPOON, {})
    tab.home.actions.open("octocat", "Spoon-Knife")
    // The home shows at once: the page is never blank while its home is read.
    expect(homePage(tab)).not.toBe("loading")
    await waitFor(() => expect(tab.readme().readme?.state).toBe("text"))
    expect(tab.view().view).toMatchObject({ sha: headSha, readmePath: "README.md" })
    expect(tab.tree().tree?.state).toBe("ready")
    expect(reads(h)).toEqual(warmed)
  })

  test("a list that failed loads again on the next warm, and opening shows what that answered; a file's warm loads it", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await h.seed("octocat", "Spoon-Knife")
    const client = listFailsOnce(h)
    const tab = await open(h, { client: client.layer })
    await tab.repo.actions.warmRoute("tree", SPOON, {})
    expect(tab.repo.lookups.tree(id, headSha)?.state).toBe("failed")
    // Opening never asks again for a failure a warm just had: the page says why at once.
    tab.repo.actions.openRoute("tree", SPOON, {})
    await waitFor(() => expect(tab.view().view.treeKey).not.toBeNull())
    expect(tab.tree().tree?.state).toBe("failed")
    expect(client.lists.count).toBe(1)
    await tab.repo.actions.warmRoute("tree", SPOON, {})
    expect(client.lists.count).toBe(2)
    tab.repo.actions.openRoute("tree", SPOON, {})
    await waitFor(() => expect(tab.tree().tree?.state).toBe("ready"))
    const file = { ...SPOON, ref: "main", _splat: "src/index.ts" }
    await tab.repo.actions.warmRoute("blob", file, {})
    expect(tab.repo.lookups.file(id, headSha, "src/index.ts")?.state).toBe("text")
    expect(tab.view().view).toMatchObject({ kind: "tree", path: "" })
  })

  test("of a repository nobody cloned ends once the device can tell, with no read", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    const before = reads(h)
    await Promise.all([
      tab.repo.actions.warmRoute("tree", { owner: "octocat", repo: "Nobody" }, {}),
      tab.home.actions.warm("octocat", "Nobody"),
    ])
    expect(reads(h)).toEqual(before)
    expect(tab.view().view.repoId).toBeNull()
  })

  test("of files that don't come ends after the page wait; the page then opens with them still loading", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h, { pageWait: "300 millis", client: listNever(h) })
    const startedAt = Date.now()
    await tab.repo.actions.warmRoute("tree", SPOON, {})
    const waited = Date.now() - startedAt
    expect(waited).toBeGreaterThanOrEqual(290)
    expect(waited).toBeLessThan(5_000)
    expect(tab.repo.lookups.tree(id, headSha)?.state).toBe("loading")
    tab.repo.actions.openRoute("tree", SPOON, {})
    await waitFor(() => expect(tab.view().view.sha).toBe(headSha))
    expect(tab.tree().tree?.state).toBe("loading")
  })

  test("of what names no page, a ref that names nothing, or a folder with no README ends with no read it needn't make", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    const before = reads(h)
    // Not a repository's name: nothing to load.
    await Promise.all([tab.repo.actions.warmRoute("tree", { owner: "api", repo: "x" }, {}), tab.home.actions.warm("api", "x")])
    // A ref that names nothing: the refs load, and no list.
    await tab.repo.actions.warmRoute("tree", { ...SPOON, ref: "no-such-ref" }, {})
    expect(reads(h).lists).toBe(before.lists)
    // A folder without a README: its list, and no file.
    await tab.repo.actions.warmRoute("tree", { ...SPOON, ref: "main", _splat: "src" }, {})
    expect(tab.repo.lookups.tree(id, headSha)?.state).toBe("ready")
    expect(reads(h).files).toBe(before.files)
    expect(tab.view().view.repoId).toBeNull()
  })

  test("of a home asks ChatApi for the curated home once; one it couldn't answer leaves the page to ask again", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife")
    const asked: Array<string> = []
    const refusing = Layer.succeed(
      HomeClient,
      HomeClient.of({ answer: (owner, name) => Effect.suspend(() => (asked.push(`${owner}/${name}`), Effect.fail(new HomeRefused({ status: 503 })))) }),
    )
    const tab = await open(h, { homeClient: refusing })
    await tab.home.actions.warm("octocat", "Spoon-Knife")
    expect(asked).toEqual(["octocat/Spoon-Knife"])
    expect(tab.home.queries.home.toArray[0]!.curated).toBeUndefined()
    // A warm never touches the page shown.
    expect(tab.home.queries.home.toArray[0]!.current.repoId).toBeNull()
    const answering = await open(h)
    await answering.home.actions.warm("octocat", "Spoon-Knife")
    await answering.home.actions.warm("octocat", "Spoon-Knife")
    answering.home.actions.open("octocat", "Spoon-Knife")
    expect(answering.home.queries.home.toArray[0]!.curated).toMatchObject({ state: "absent" })
    expect(homePage(answering)).not.toBe("loading")
  })

  test("of a file that failed reads it again; opening shows what that answered and never asks again itself", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await h.seed("octocat", "Spoon-Knife")
    const client = readFailsOnce(h)
    // A wait long enough for a loaded machine to reach the file's read.
    const tab = await open(h, { client: client.layer, pageWait: "10 seconds" })
    const file = { ...SPOON, ref: "main", _splat: "src/index.ts" }
    await tab.repo.actions.warmRoute("blob", file, {})
    expect(tab.repo.lookups.file(id, headSha, "src/index.ts")?.state).toBe("failed")
    tab.repo.actions.openRoute("blob", file, {})
    await waitFor(() => expect(tab.view().view.fileKey).not.toBeNull())
    expect(tab.file().file?.state).toBe("failed")
    expect(client.reads.count).toBe(1)
    await tab.repo.actions.warmRoute("blob", file, {})
    expect(client.reads.count).toBe(2)
    tab.repo.actions.openRoute("blob", file, {})
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
  })

  test("of a repository still cloning ends at once with no read: the page says Cloning", async () => {
    const h = await repoHarness(server)
    h.scripted.publish("octocat", "Spoon-Knife")
    // The clone stays Cloning until the tab has seen it: its first poll waits for the test.
    const release = h.scripted.hold("listCommits")
    const tab = await open(h)
    // The page is open while the clone runs, so the tab syncs the repositories.
    tab.repo.actions.openRoute("tree", SPOON, {})
    await h.clone("octocat", "Spoon-Knife")
    await waitFor(() => expect(tab.repo.lookups.repository("github/octocat/spoon-knife")?.status).toBe("cloning"))
    const before = reads(h)
    await tab.repo.actions.warmRoute("tree", SPOON, {})
    expect(reads(h)).toEqual(before)
    release()
    await h.settled()
  })
})
