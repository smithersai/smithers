// A repository's view in a conversation (src/features/repo/embed.ts, docs/features/views.md#a-repository-and-its-issues),
// loaded on a tab as the views' follower loads it, with no React: `embed` per view id, read back through the `Repo`
// layer's embeds query and shown as `embedShown` shows it. The tab reaches RepoApi's real handler over the compose
// Postgres and Electric; Code Storage and GitHub are the scripted providers (worker/test/codeStorage.ts). Faults come
// from a faulty `RepoClient` (test.faults-by-injection).
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { fixture, shaOf } from "../../../worker/test/codeStorage"
import { testFile } from "../../../worker/test/harness"
import { type RepoHarness, repoHarness, resetRepos } from "../../../worker/test/repos"
import { openTab, type Tab } from "../../test/repoDevice"
import { RepoClient, RepoRefused } from "./api"
import { BUSY, NOT_CLONED, NOT_FOUND, READING_PAUSED } from "./contract"
import { embed, type EmbedTarget } from "./embed"
import { embedShown, fullScreenHref } from "./embedView"
import { embedLoadMs } from "./metrics"

const server = testFile("repo_embed")
beforeEach(() => resetRepos(server))

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

const waitFor = <A>(check: () => A) => vi.waitFor(check, { timeout: 15_000 })

const open = async (h: RepoHarness, client?: Layer.Layer<RepoClient>) => {
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, ...(client === undefined ? {} : { client }) })
  tabs.push(tab)
  return tab
}

/** Loads view `viewId` opening `target`, as the follower does, and answers its row of the embeds query once settled. */
const load = async (tab: Tab, viewId: string, target: EmbedTarget) => {
  await tab.runtime.runPromise(embed(viewId, target))
  return waitFor(() => {
    const row = tab.repo.queries.embeds.toArray.find((each) => each.embed.key === viewId)
    expect(row?.embed.state).not.toBe("loading")
    return row!
  })
}

const SPOON = "octocat/Spoon-Knife"

describe("a cloned repository's view", () => {
  test("opens its root with the README, a file it infers from the list, a directory, and a ref it doesn't have", async () => {
    const h = await repoHarness(server)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)

    const root = await load(tab, "v-root", { repo: SPOON })
    expect(root.embed).toMatchObject({ state: "ready", kind: "tree", path: "", revision: "main", sha: headSha, bodyPath: "README.md" })
    await waitFor(() => expect(tab.repo.queries.embeds.toArray.find((row) => row.embed.key === "v-root")?.body?.state).toBe("text"))
    const shownRoot = embedShown(tab.repo.queries.embeds.toArray.find((row) => row.embed.key === "v-root"))
    expect(shownRoot).toMatchObject({ kind: "view", location: { kind: "tree", path: "" }, readme: { path: "README.md" } })
    expect(fullScreenHref({ repo: SPOON }, root)).toBe("/octocat/Spoon-Knife/tree/main")

    // A path the repository lists as a file opens as one; its README-less directory as a directory.
    const file = await load(tab, "v-file", { repo: SPOON, path: "src/index.ts" })
    expect(file.embed).toMatchObject({ state: "ready", kind: "blob", path: "src/index.ts", bodyPath: "src/index.ts" })
    await waitFor(() =>
      expect(tab.repo.queries.embeds.toArray.find((row) => row.embed.key === "v-file")?.body).toMatchObject({
        state: "text",
        contents: expect.stringContaining("export const two = 2"),
      })
    )
    expect(fullScreenHref({ repo: SPOON, path: "src/index.ts" }, file)).toBe("/octocat/Spoon-Knife/blob/main/src/index.ts")
    const directory = await load(tab, "v-docs", { repo: SPOON, path: "docs" })
    expect(directory.embed).toMatchObject({ state: "ready", kind: "tree", path: "docs", bodyPath: null, bodyKey: null })
    // The row's kind wins over the list.
    expect((await load(tab, "v-kind", { repo: SPOON, path: "docs", kind: "blob" })).embed).toMatchObject({ kind: "blob" })

    expect((await load(tab, "v-dev", { repo: SPOON, ref: "dev" })).embed.state).toBe("missing")
    expect(embedShown(await load(tab, "v-dev", { repo: SPOON }))).toEqual({ kind: "empty", title: NOT_FOUND })
    expect(tab.histogramCount(embedLoadMs, { outcome: "ready" })).toBe(4)
    expect(tab.histogramCount(embedLoadMs, { outcome: "missing" })).toBe(1)
    expect(tab.lines("repo.embed.load").map((line) => line.annotations.outcome)).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
      "missing",
    ])

    // A view loaded once isn't loaded again; one that names no repository GitHub could have is missing at once.
    const reads = h.scripted.calls.length
    await tab.runtime.runPromise(embed("v-root", { repo: SPOON }))
    expect(h.scripted.calls).toHaveLength(reads)
    expect((await load(tab, "v-bad", { repo: "app/widgets" })).embed.state).toBe("missing")
    expect((await load(tab, "v-no-name", { repo: "octocat" })).embed).toMatchObject({ state: "missing", name: "" })
  })

  test("Full screen keeps the displayed revision before and after the repository shape arrives", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife")
    // Hold Electric through its injected Effect ShapeSource: RepoApi can resolve the head independently.
    const tab = await openTab({ origin: h.origin, fetch: h.fetch, shapes: "stalled" })
    tabs.push(tab)
    const target = { repo: SPOON }
    const before = await load(tab, "v-cold", target)
    expect(before.embed).toMatchObject({ state: "ready", revision: "main" })
    expect(before.repository).toBeUndefined()
    expect(fullScreenHref(target, before)).toBe("/octocat/Spoon-Knife/tree/main")

    await tab.heal()
    const after = await waitFor(() => {
      const row = tab.repo.queries.embeds.toArray.find((each) => each.embed.key === "v-cold")
      expect(row?.repository?.defaultBranch).toBe("main")
      return row!
    })
    expect(fullScreenHref(target, after)).toBe("/octocat/Spoon-Knife/tree/main")
    // A previously read query result must name the same destination too.
    expect(fullScreenHref(target, before)).toBe(fullScreenHref(target, after))
  })

  test("a ref whose branches Code Storage couldn't list says why", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife", fixture({
      branches: [{ name: "test-branch", sha: shaOf("test-branch"), files: { "README.md": "# On test-branch\n" } }],
    }))
    // RepoApi's refs may read the head first, through the same listing: every read of it fails.
    const failure = h.scripted.error("listBranches", "internal_error", 500)
    h.scripted.fail("listBranches", failure, failure, failure)
    const tab = await open(h)
    const row = await load(tab, "v-branch", { repo: SPOON, ref: "test-branch" })
    expect(row.embed).toMatchObject({ state: "failed", message: BUSY })
    expect(embedShown(row)).toEqual({ kind: "empty", title: BUSY })
    expect(tab.histogramCount(embedLoadMs, { outcome: "failed" })).toBe(1)
  })

  test("a file list Code Storage couldn't give: the view says why in the list's place", async () => {
    const h = await repoHarness(server)
    // The clone's Index lists the head's files first and shrugs its failure off; the second failure is the tab's.
    const failure = h.scripted.error("listFiles", "internal_error", 500)
    h.scripted.fail("listFiles", failure, failure)
    await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    const row = await load(tab, "v-list", { repo: SPOON, path: "README.md" })
    // Without the list, a path the row doesn't kind opens as a directory.
    expect(row.embed).toMatchObject({ state: "ready", kind: "tree", path: "README.md", bodyPath: null })
    await waitFor(() =>
      expect(embedShown(tab.repo.queries.embeds.toArray.find((each) => each.embed.key === "v-list")))
        .toMatchObject({ kind: "view", tree: { state: "failed", message: BUSY } })
    )
  })
})

describe("a repository nobody cloned", () => {
  test("shows its root as GitHub has it; deeper says Not cloned; one GitHub doesn't have is Not found", async () => {
    const h = await repoHarness(server)
    h.github.publish("octocat", "Spoon-Knife")
    const tab = await open(h)
    const root = await load(tab, "v-preview", { repo: SPOON })
    expect(root.embed.state).toBe("preview")
    expect(embedShown(root)).toMatchObject({
      kind: "view",
      tree: { state: "ready", paths: ["README.md", "index.html"], directories: ["docs"] },
      readme: { file: { state: "text", contents: expect.stringContaining("Well hello there!") } },
    })
    expect((await load(tab, "v-main", { repo: SPOON, ref: "main" })).embed.state).toBe("preview")
    const deeper = await load(tab, "v-deeper", { repo: SPOON, path: "docs" })
    expect(embedShown(deeper)).toEqual({ kind: "empty", title: NOT_CLONED })
    expect((await load(tab, "v-other-ref", { repo: SPOON, ref: "dev" })).embed.state).toBe("not_cloned")
    const gone = await load(tab, "v-gone", { repo: "octocat/Gone" })
    expect(gone.embed).toMatchObject({ state: "missing", message: NOT_FOUND })
    expect(h.started()).toEqual([])
  })

  test("what GitHub says that can't be read shows why", async () => {
    const h = await repoHarness(server)
    h.github.publish("octocat", "Spoon-Knife")
    const paused = Layer.effect(
      RepoClient,
      Effect.map(Effect.service(RepoClient), (client) =>
        RepoClient.of({ ...client, about: () => Effect.fail(new RepoRefused({ status: 503, code: "capacity" })) })),
    ).pipe(
      Layer.provide(RepoClient.layer({ origin: h.origin, within: "10 seconds" })),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
    )
    const tab = await open(h, paused)
    const row = await load(tab, "v-paused", { repo: SPOON })
    expect(row.embed).toMatchObject({ state: "failed", message: READING_PAUSED })
    expect(embedShown(row)).toEqual({ kind: "empty", title: READING_PAUSED })
  })
})
