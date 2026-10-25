import { Action } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Cause, Effect, Exit, Layer, Schedule } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { fixture, shaOf } from "../../../worker/test/codeStorage"
import { testFile } from "../../../worker/test/harness"
import { type RepoHarness, repoHarness, resetRepos } from "../../../worker/test/repos"
import { runFlow } from "../../../worker/test/flowHost"
import { repoFlows } from "../../flows/registrations"
import { openTab, type Tab } from "../../test/repoDevice"
import { persistenceOn } from "../../test/deviceFixture"
import { tempDirectory } from "../../test/tempDirectory"
import { join } from "node:path"
import { SqlClient } from "effect/sql"
import { RepoStore } from "./store"
import { VIEW } from "./rows"
import { RepoClient, RepoRefused } from "./api"
import { BUSY, COULDNT_LOAD, GITHUB_DOWN, GITHUB_LIMIT, NOT_FOUND, rawRoute, READING_PAUSED, repoId } from "./contract"
import { TabClipboard } from "./copy"
import { RepoCloneRequest, RepoCopy, RepoCopyRefused, RepoRead, RepoRefs, RepoTree } from "./flows"
import { aboutLoadMs, blobLoadMs, clones, copies, refsLoadMs, roleAnswers, treeLoadMs } from "./metrics"
import { NotCopied } from "./repo"
import { aboutOf, generatedLinksFor, headerOf, previewReadmeOf, previewTreeOf } from "./view"
import * as Repos from "../../../worker/Repos.ts"

// The repository state machine on a tab, driven as React drives it, with no React: through the `Repo` layer's plain
// actions, reading its live queries. The tab reaches RepoApi's real handler (worker/RepoApi.ts) over the compose
// Postgres and Electric, through a fetch that hands each request to the handler in this process; a clone runs on the
// Node host. Code Storage and GitHub are the scripted providers (worker/test/codeStorage.ts).

const server = testFile("repo_tab")
beforeEach(() => resetRepos(server))

/**
 * Waits for `check` to pass: a dispatch runs on this tab's engine, which a loaded machine can take seconds to reach.
 */
const waitFor = <A>(check: () => A, options: { readonly timeout?: number } = {}) =>
  vi.waitFor(check, { timeout: 10_000, ...options })

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

/** A tab on `h`'s RepoApi. */
const open = async (h: RepoHarness) => {
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, confirmWithin: "10 seconds" })
  tabs.push(tab)
  return tab
}

const header = (tab: Tab) => {
  const { repository, clone, view, about } = tab.view()
  return headerOf(repository, clone, view.signedIn, view.answered, about)
}

const root = (owner: string, name: string) =>
  ({ owner, name, kind: "tree", ref: null, path: "", line: null, lineEnd: null }) as const

/** Spoon-Knife with two more branches, one named with a `/`, and a tag on one of them. */
const branched = () =>
  fixture({
    branches: [
      { name: "test-branch", sha: shaOf("test-branch"), files: { "README.md": "# On test-branch\n", "only.txt": "x" } },
      { name: "feature/x", sha: shaOf("feature/x"), files: { "docs/a.md": "# A\n" } },
    ],
    tags: [{ name: "v1.0.0", sha: shaOf("test-branch") }],
  })

/**
 * Waits until `tab`'s device has `id`'s ready row, as a device that synced it on an earlier visit has: its pages read
 * at the row's head, and keep the branches and tags under its sync.
 */
const rowReady = async (tab: Tab, id: string) => {
  await tab.runtime.runPromise(Effect.flatMap(Effect.service(RepoStore), (store) => Effect.ignore(store.repositories.preload)))
  await waitFor(() => expect(tab.repo.lookups.repository(id)?.status).toBe("ready"))
}

/** Opens `route` at `ref` and `path` in Spoon-Knife. */
const at = (tab: Tab, kind: "tree" | "blob", ref: string, path = "") =>
  tab.repo.actions.openRoute(kind, { owner: "octocat", repo: "Spoon-Knife", ref, _splat: path }, {})

describe("cloning from a tab", () => {
  test("a fresh persisted device projects a ready repository and retains it on reload", async () => {
    const h = await repoHarness(server, { codeStorage: "none" })
    // Only the persisted projection is under test; no forge or Code Storage stand-in is called.
    await server.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO repositories (id, owner, name, status, default_branch, head_sha)
      VALUES ('github/octocat/spoon-knife', 'octocat', 'Spoon-Knife', 'ready', 'main', ${"a".repeat(40)})`))
    const path = join(tempDirectory("mobile-repo-"), "device.sqlite")
    for (let visit = 0; visit < 2; visit++) {
      const tab = await openTab({ origin: h.origin, fetch: h.fetch, persistence: persistenceOn(path) })
      tabs.push(tab)
      const store = await tab.runtime.runPromise(Effect.service(RepoStore))
      await tab.runtime.runPromise(store.view.update(VIEW, (row) => { row.repoId = "github/octocat/spoon-knife" }))
      await waitFor(() => expect(header(tab)).toEqual({ kind: "ready" }))
      await tab.dispose()
      tabs.pop()
    }
  })

  test("Clone shows cloning, Electric delivers the row, and the view opens at its README", async () => {
    const h = await repoHarness(server)
    h.scripted.publish("octocat", "Spoon-Knife")
    h.scripted.syncPolls = 2
    const tab = await open(h)
    // A second device on the same deployment sees the same row.
    const other = await open(h)
    tab.repo.actions.open(root("octocat", "Spoon-Knife"))
    other.repo.actions.open(root("octocat", "Spoon-Knife"))
    await waitFor(() => expect(header(tab)).toEqual({ kind: "clone" }))
    tab.repo.actions.clone("octocat", "Spoon-Knife")
    expect(header(tab)).toEqual({ kind: "cloning" })
    // The Clone button runs `repo/clone` on this device's engine, whose step asks RepoApi.
    await waitFor(() => expect(tab.view().clone).toBeUndefined(), { timeout: 10_000 }).catch((error) => {
      // Capture live metadata before afterEach disposes the tabs; retain the original assertion failure.
      for (const [device, opened] of [["first", tab], ["second", other]] as const) {
        const view = opened.view()
        console.info("repo.clone.test.diagnostic", JSON.stringify({
          device,
          backgroundStarted: h.started().length,
          cloneStatus: view?.clone?.status ?? null,
          repositoryStatus: view?.repository?.status ?? null,
          records: opened.logs.filter((line) => typeof line.message === "string" && [
            "flow.dispatch", "repo.clone", "repo.clone.unconfirmed", "repo.tree.load", "repo.about.load",
            "engine-store.registration.recovered", "engine-store.sweep.failed",
          ].includes(line.message)).slice(-80).map((line) => ({
            message: line.message,
            annotations: Object.fromEntries(Object.entries(line.annotations).filter(([key]) =>
              ["flow", "smithers.flow", "durationMs", "outcome", "reason", "refusal"].includes(key))),
          })),
        }))
      }
      throw error
    })
    expect(tab.count(clones, { outcome: "started" })).toBe(1)
    expect(tab.lines("repo.clone")[0]!.annotations).toMatchObject({ outcome: "started", feature: "repo" })
    await h.settled()
    await waitFor(() => expect(header(tab)).toEqual({ kind: "ready" }), { timeout: 10_000 })
    await waitFor(() => expect(header(other)).toEqual({ kind: "ready" }), { timeout: 10_000 })
    await waitFor(() => expect(tab.tree().tree?.state).toBe("ready"))
    expect(tab.tree().tree?.paths).toEqual(expect.arrayContaining(["README.md", "docs/guide.md", "src/index.ts"]))
    await waitFor(() => expect(tab.readme().readme?.state).toBe("text"))
    expect(tab.view().view).toMatchObject({ revision: "main", path: "", readmePath: "README.md", missing: false })
    expect(tab.readme().readme?.contents).toContain("# Fixture")
    expect(tab.histogramCount(treeLoadMs, { outcome: "ready" })).toBe(1)
    expect(tab.lines("repo.tree.load")[0]!.annotations).toMatchObject({ outcome: "ready", feature: "repo" })
  })

  test("a clone already done answers 200, and the tab shows the row Electric has", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    tab.repo.actions.open(root("octocat", "Spoon-Knife"))
    await waitFor(() => expect(header(tab)).toEqual({ kind: "ready" }))
    tab.repo.actions.clone("octocat", "Spoon-Knife")
    await waitFor(() => expect(tab.view().clone).toBeUndefined())
    expect(tab.count(clones, { outcome: "existing" })).toBe(1)
    expect(header(tab)).toEqual({ kind: "ready" })
    expect(h.started()).toHaveLength(1)
  })

  test("a clone done before the device has its row waits for Electric to deliver it", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    tab.repo.actions.clone("octocat", "Spoon-Knife")
    await waitFor(() => expect(tab.repo.lookups.repository("github/octocat/spoon-knife")?.status).toBe("ready"))
    expect(tab.count(clones, { outcome: "existing" })).toBe(1)
  })
})

describe("reading a ready repository", () => {
  test("a file as text with its line anchor, a binary, one too large, and one that isn't there", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    const blob = (path: string, L?: string) =>
      tab.repo.actions.openRoute("blob", { owner: "octocat", repo: "Spoon-Knife", ref: "main", _splat: path }, { L })
    blob("src/index.ts", "2-3")
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
    expect(tab.file().file).toMatchObject({ contents: expect.stringContaining("export const two = 2"), size: 65 })
    expect(tab.view().view).toMatchObject({ sha: headSha, path: "src/index.ts", line: 2, lineEnd: 3 })
    expect(tab.repo.lookups.file(id, headSha, "src/index.ts")?.state).toBe("text")
    await waitFor(() => expect(tab.repo.lookups.tree(id, headSha)?.state).toBe("ready"))
    blob("logo.png")
    await waitFor(() => expect(tab.file().file).toMatchObject({ state: "binary", size: 12 }))
    blob("big.txt")
    await waitFor(() => expect(tab.file().file).toMatchObject({ state: "too-large", size: 600 * 1024 }))
    blob("nope.md")
    await waitFor(() => expect(tab.file().file).toMatchObject({ state: "failed", message: NOT_FOUND }))
    expect(tab.histogramCount(blobLoadMs, { outcome: "text" })).toBe(1)
    expect(tab.histogramCount(blobLoadMs, { outcome: "failed" })).toBe(1)
    // A file loaded once is never fetched again.
    const reads = h.scripted.calls.filter((call) => call.startsWith("readFile")).length
    blob("src/index.ts")
    expect(tab.file().file?.state).toBe("text")
    expect(h.scripted.calls.filter((call) => call.startsWith("readFile"))).toHaveLength(reads)
  })

  test("a directory shows its README; a commit SHA reads there; another ref names nothing", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife", ref: headSha, _splat: "docs" }, {})
    await waitFor(() => expect(tab.tree().tree?.state).toBe("ready"))
    expect(tab.view().view).toMatchObject({ revision: headSha, sha: headSha, path: "docs", readmePath: null })
    expect(tab.repo.lookups.readme(id, headSha, "docs")).toBeUndefined()
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife", ref: "dev" }, {})
    await waitFor(() => expect(tab.view().view.missing).toBe(true))
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife" }, {})
    await waitFor(() => expect(tab.readme().readme?.state).toBe("text"))
    expect(tab.repo.lookups.readme(id, headSha, "")?.state).toBe("text")
  })

  test("Copy permalink runs repo/copy, which puts the location at its commit on this tab's clipboard", async () => {
    const h = await repoHarness(server)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    tab.repo.actions.openRoute("blob", { owner: "octocat", repo: "Spoon-Knife", ref: "main", _splat: "src/index.ts" }, {
      L: "2",
    })
    await waitFor(() => expect(tab.view().view.sha).toBe(headSha))
    await tab.repo.actions.copy("permalink")
    expect(tab.copied).toEqual([`${h.origin}/octocat/Spoon-Knife/blob/${headSha}/src/index.ts?L=2`])
    tab.repo.actions.openRoute("blob", { owner: "octocat", repo: "Spoon-Knife", ref: "main", _splat: "src/index.ts" }, {
      L: "1-3",
    })
    await waitFor(() => expect(tab.view().view.line).toBe(1))
    await tab.repo.actions.copy("permalink")
    expect(tab.copied[1]).toBe(`${h.origin}/octocat/Spoon-Knife/blob/${headSha}/src/index.ts?L=1-3`)
    // A directory's permalink, and the root's.
    at(tab, "tree", "main", "docs")
    await waitFor(() => expect(tab.view().view).toMatchObject({ kind: "tree", sha: headSha }))
    await tab.repo.actions.copy("permalink")
    at(tab, "tree", "main")
    await waitFor(() => expect(tab.view().view).toMatchObject({ path: "", sha: headSha }))
    await tab.repo.actions.copy("permalink")
    expect(tab.copied.slice(2)).toEqual([
      `${h.origin}/octocat/Spoon-Knife/tree/${headSha}/docs`,
      `${h.origin}/octocat/Spoon-Knife/tree/${headSha}`,
    ])
    expect(tab.count(copies, { what: "permalink", door: "button", outcome: "copied" })).toBe(4)
    expect(tab.lines("repo.copy")[0]!.annotations).toMatchObject({ what: "permalink", door: "button", outcome: "copied" })
  })

  test("Copy path, Copy (the file's text) and the clone URL go on the clipboard through repo/copy", async () => {
    const h = await repoHarness(server)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    at(tab, "blob", "main", "src/index.ts")
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
    await tab.repo.actions.copy("path")
    await tab.repo.actions.copy("contents")
    await tab.repo.actions.copy("clone-url")
    expect(tab.copied).toEqual([
      "src/index.ts",
      "export const one = 1\nexport const two = 2\nexport const three = 3\n",
      "https://github.com/octocat/Spoon-Knife.git",
    ])
    expect(tab.view().view.sha).toBe(headSha)
    // A binary file has no text to copy: refused, and nothing reaches the clipboard.
    at(tab, "blob", "main", "logo.png")
    await waitFor(() => expect(tab.file().file?.state).toBe("binary"))
    await expect(tab.repo.actions.copy("contents")).rejects.toBeInstanceOf(NotCopied)
    expect(tab.count(copies, { what: "contents", door: "button", outcome: "refused" })).toBe(1)
    // The root has no path, and a directory no contents: nothing to dispatch.
    at(tab, "tree", "main")
    await waitFor(() => expect(tab.view().view.sha).toBe(headSha))
    await expect(tab.repo.actions.copy("path")).rejects.toBeInstanceOf(NotCopied)
    await expect(tab.repo.actions.copy("contents")).rejects.toBeInstanceOf(NotCopied)
    expect(tab.copied).toHaveLength(3)
  })

  test("a clipboard that refuses: repo/copy answers not copied, counted and logged", async () => {
    const h = await repoHarness(server)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await openTab({
      origin: h.origin,
      fetch: h.fetch,
      writeText: () => Promise.reject(new DOMException("Document is not focused.", "NotAllowedError")),
    })
    tabs.push(tab)
    tab.repo.actions.open(root("octocat", "Spoon-Knife"))
    await waitFor(() => expect(tab.view().view.sha).toBe(headSha))
    await expect(tab.repo.actions.copy("permalink")).rejects.toBeInstanceOf(NotCopied)
    expect(tab.count(copies, { what: "permalink", door: "button", outcome: "failed" })).toBe(1)
    expect(tab.lines("repo.copy")[0]!.annotations).toMatchObject({ outcome: "failed" })
  })

  test("a list Code Storage couldn't give fails busy, and navigating to it again loads it again", async () => {
    const h = await repoHarness(server)
    // The clone's Index lists the head's files into the cache: the first failure is its, which it shrugs off, so the
    // list isn't cached; the second is the tab's.
    const failure = h.scripted.error("listFiles", "internal_error", 500)
    h.scripted.fail("listFiles", failure, failure)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const tab = await open(h)
    tab.repo.actions.open(root("octocat", "Spoon-Knife"))
    await waitFor(() => expect(tab.tree().tree).toMatchObject({ state: "failed", message: BUSY }))
    expect(tab.histogramCount(treeLoadMs, { outcome: "failed" })).toBe(1)
    expect(tab.lines("repo.tree.load")[0]!.annotations).toMatchObject({ outcome: "failed", status: 503 })
    // A navigation warms the page before it opens it, and the warm asks again for a list that failed.
    await tab.repo.actions.warmRoute("tree", { owner: "octocat", repo: "Spoon-Knife" }, {})
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife" }, {})
    await waitFor(() => expect(tab.tree().tree?.state).toBe("ready"))
    expect(tab.view().view.sha).toBe(headSha)
  })
})

describe("branches, tags and commits", () => {
  test("the picker's refs load once per sync; a branch, a tag and a name with a slash read at their commits", async () => {
    const h = await repoHarness(server)
    const { id, headSha } = await h.seed("octocat", "Spoon-Knife", branched())
    const tab = await open(h)
    await rowReady(tab, id)
    at(tab, "tree", "main")
    await waitFor(() => expect(tab.refs().refs?.state).toBe("ready"))
    expect(tab.refs().refs).toMatchObject({
      // The sync's head and the last ref change after it, which the ready clone itself is.
      key: expect.stringMatching(new RegExp(`^${id}@${headSha}@.+$`)),
      branches: [
        { name: "feature/x", sha: shaOf("feature/x") },
        { name: "main", sha: headSha },
        { name: "test-branch", sha: shaOf("test-branch") },
      ],
      tags: [{ name: "v1.0.0", sha: shaOf("test-branch") }],
      truncated: false,
    })
    expect(tab.histogramCount(refsLoadMs, { outcome: "ready" })).toBe(1)
    at(tab, "tree", "test-branch")
    await waitFor(() => expect(tab.readme().readme?.state).toBe("text"))
    expect(tab.view().view).toMatchObject({ revision: "test-branch", sha: shaOf("test-branch"), path: "" })
    expect(tab.readme().readme?.contents).toBe("# On test-branch\n")
    at(tab, "blob", "v1.0.0", "only.txt")
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
    expect(tab.view().view).toMatchObject({ revision: "v1.0.0", sha: shaOf("test-branch"), path: "only.txt" })
    // GitHub's path for a branch named with a slash: the ref and the path arrive split.
    at(tab, "blob", "feature", "x/docs/a.md")
    await waitFor(() => expect(tab.file().file?.contents).toBe("# A\n"))
    expect(tab.view().view).toMatchObject({ revision: "feature/x", sha: shaOf("feature/x"), path: "docs/a.md" })
    // One listing served every ref: the device keeps it, and RepoApi's cache keeps it under the head.
    expect(h.scripted.calls.filter((call) => call.startsWith("listBranches"))).toHaveLength(1)
    at(tab, "tree", "no-such-branch")
    await waitFor(() => expect(tab.view().view.missing).toBe(true))
  })

  test("a branch made while the default branch's head stays where it was shows the next time the view opens", async () => {
    // Before, the device kept the refs under the head commit alone, so the new branch never showed until main moved.
    const h = await repoHarness(server)
    const { id } = await h.seed("octocat", "Spoon-Knife", branched())
    const tab = await open(h)
    await rowReady(tab, id)
    at(tab, "tree", "main")
    await waitFor(() => expect(tab.refs().refs?.state).toBe("ready"))
    const before = tab.view().repository?.refsChangedAt
    // What worker/branch/Branches.ts does for a new branch: make it on the forge, then record the change.
    await Effect.runPromise(h.scripted.client.createBranch(id, { branch: "made", from: "main" }))
    await server.runPromise(Repos.refsChanged(id))
    await waitFor(() => expect(tab.view().repository?.refsChangedAt).not.toBe(before))
    at(tab, "tree", "main")
    await waitFor(() => expect(tab.refs().refs?.branches.map((branch) => branch.name)).toContain("made"))
  })

  test("a ref chosen in the picker runs app/navigate, which moves this tab", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife", branched())
    const tab = await open(h)
    tab.repo.actions.navigate("/octocat/Spoon-Knife/tree/test-branch")
    await waitFor(() => expect(tab.navigated).toEqual(["/octocat/Spoon-Knife/tree/test-branch"]))
  })

  test("refs Code Storage couldn't list: a branch's view says why, and the default branch still reads", async () => {
    const h = await repoHarness(server)
    const { id } = await h.seed("octocat", "Spoon-Knife", branched())
    h.scripted.fail("listBranches", h.scripted.error("listBranches", "internal_error", 500))
    const tab = await open(h)
    await rowReady(tab, id)
    at(tab, "tree", "test-branch")
    await waitFor(() => expect(tab.view().view.failure).toBe(BUSY))
    expect(tab.refs().refs).toMatchObject({ state: "failed", message: BUSY })
    expect(tab.histogramCount(refsLoadMs, { outcome: "failed" })).toBe(1)
    at(tab, "tree", "main")
    await waitFor(() => expect(tab.readme().readme?.state).toBe("text"))
    expect(tab.view().view.failure).toBeNull()
    // Opened again, a failed listing loads again.
    await waitFor(() => expect(tab.refs().refs?.state).toBe("ready"))
  })

  test("GitHub's raw path answers RepoApi's raw route at the commit; nothing to load answers nothing", async () => {
    const h = await repoHarness(server)
    const { headSha } = await h.seed("octocat", "Spoon-Knife", branched())
    const tab = await open(h)
    const raw = (ref: string, path: string, repo = "Spoon-Knife") =>
      tab.repo.actions.rawRoute({ owner: "octocat", repo, ref, _splat: path })
    expect(await raw("main", "README.md")).toBe(rawRoute("octocat", "Spoon-Knife", headSha, "README.md"))
    expect(await raw("feature", "x/docs/a.md")).toBe(rawRoute("octocat", "Spoon-Knife", shaOf("feature/x"), "docs/a.md"))
    expect(await raw("nope", "README.md")).toBeUndefined()
    expect(await raw("main", "")).toBeUndefined()
    expect(await tab.repo.actions.rawRoute({ owner: "api", repo: "x", ref: "main", _splat: "a" })).toBeUndefined()
    // A repository nobody cloned: the view shows Clone, and there is nothing to load.
    expect(await raw("main", "README.md", "Hello-World")).toBeUndefined()
    expect(tab.view().view).toMatchObject({ kind: "blob", name: "Hello-World", path: "README.md" })
  })
})

describe("reads RepoApi refuses", () => {
  test("the read budget spent reads as paused; a gateway's error, as couldn't load", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife")
    // RepoApi's real routes, behind a client that refuses the reads (test.faults-by-injection).
    const real = RepoClient.layer({ origin: h.origin, within: "10 seconds" }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
    )
    const refusing = Layer.effect(
      RepoClient,
      Effect.map(Effect.service(RepoClient), (client) =>
        RepoClient.of({
          ...client,
          tree: () => Effect.fail(new RepoRefused({ status: 503, code: "capacity" })),
          blob: () => Effect.fail(new RepoRefused({ status: 502 })),
        })),
    ).pipe(Layer.provide(real))
    const tab = await openTab({ origin: h.origin, fetch: h.fetch, client: refusing, retry: Schedule.spaced("1 second") })
    tabs.push(tab)
    tab.repo.actions.openRoute("blob", { owner: "octocat", repo: "Spoon-Knife", ref: "main", _splat: "README.md" }, {})
    await waitFor(() => expect(tab.tree().tree).toMatchObject({ state: "failed", message: READING_PAUSED }))
    await waitFor(() => expect(tab.file().file).toMatchObject({ state: "failed", message: COULDNT_LOAD }))
  })
})

describe("the agent's repository flows on this device", () => {
  /** The engine worker's registration (src/flows/registrations.ts) over the host's HttpClient; no tab answers copies. */
  const flows = (h: RepoHarness) =>
    repoFlows(h.origin).pipe(
      Layer.provide(TabClipboard.layerChannel({ name: `none-${crypto.randomUUID()}`, origin: h.origin, within: "200 millis" })),
      Layer.provide(TabChannel.layer),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
    )

  test("repo/refs answers the default branch, its head, and every branch and tag", async () => {
    const h = await repoHarness(server)
    const { headSha } = await h.seed("octocat", "Spoon-Knife", branched())
    const refs = await runFlow(RepoRefs, { repo: "octocat/Spoon-Knife" }, flows(h))
    expect(refs.exit).toEqual(Exit.succeed({
      defaultBranch: "main",
      head: headSha,
      branches: [
        { name: "feature/x", sha: shaOf("feature/x") },
        { name: "main", sha: headSha },
        { name: "test-branch", sha: shaOf("test-branch") },
      ],
      tags: [{ name: "v1.0.0", sha: shaOf("test-branch") }],
      truncated: false,
    }))
    const missing = await runFlow(RepoRefs, { repo: "octocat/Hello-World" }, flows(h))
    expect(Exit.isFailure(missing.exit) && Cause.squash(missing.exit.cause)).toMatchObject({
      _tag: "@smthrs/mvp/repo/RepoNotFound",
    })
  })

  test("repo/clone asks RepoApi, which persists the clone, then launches it; asked again, it answers the row's status", async () => {
    const h = await repoHarness(server)
    h.scripted.publish("octocat", "Spoon-Knife")
    const started = await runFlow(RepoCloneRequest, { repo: "octocat/Spoon-Knife" }, flows(h))
    const cloneId = expect.stringMatching(/^[0-9a-f-]{36}$/)
    expect(started.exit).toEqual(Exit.succeed({ txid: expect.any(Number), id: "github/octocat/spoon-knife", attempt: 1, cloneId }))
    // Its second step launched the attempt the first persisted.
    expect(h.started()).toHaveLength(1)
    await h.settled()
    const again = await runFlow(RepoCloneRequest, { repo: "octocat/Spoon-Knife" }, flows(h))
    expect(again.exit).toEqual(Exit.succeed({ txid: null, id: "github/octocat/spoon-knife", status: "ready", cloneId }))
    expect(h.started()).toHaveLength(1)
  })

  test("repo/clone signed out is refused sign_in, and a Guest's forbidden", async () => {
    const signedOut = await repoHarness(server, { actor: null })
    const out = await runFlow(RepoCloneRequest, { repo: "octocat/Spoon-Knife" }, flows(signedOut))
    expect(Exit.isFailure(out.exit) && Cause.squash(out.exit.cause)).toMatchObject({ reason: "sign_in" })
    const guest = await repoHarness(server, { actor: { subject: { kind: "person", id: "g" }, role: "guest" } })
    const refused = await runFlow(RepoCloneRequest, { repo: "octocat/Spoon-Knife" }, flows(guest))
    expect(Exit.isFailure(refused.exit) && Cause.squash(refused.exit.cause)).toMatchObject({ reason: "forbidden" })
    expect(refused.status).toBe("failed")
  })

  test("repo/copy from the agent's call with no tab to answer: not copied; nothing to copy is refused", async () => {
    const h = await repoHarness(server)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const gone = await runFlow(RepoCopy, { repo: "octocat/Spoon-Knife", what: "clone-url" }, flows(h))
    expect(gone.exit).toEqual(Exit.succeed({ copied: false }))
    for (const payload of [
      { repo: "octocat/Spoon-Knife", what: "permalink" as const },
      { repo: "octocat/Spoon-Knife", what: "path" as const },
      { repo: "octocat/Spoon-Knife", what: "contents" as const, revision: headSha },
    ]) {
      const refused = await runFlow(RepoCopy, payload, flows(h))
      expect(Exit.isFailure(refused.exit) && Cause.squash(refused.exit.cause)).toEqual(
        new RepoCopyRefused({ reason: "invalid" }),
      )
    }
    const unreadable = await runFlow(
      RepoCopy,
      { repo: "octocat/Spoon-Knife", what: "contents", revision: headSha, path: "gone.md" },
      flows(h),
    )
    expect(Exit.isFailure(unreadable.exit) && Cause.squash(unreadable.exit.cause)).toMatchObject({
      _tag: "@smthrs/mvp/repo/RepoNotFound",
    })
  })

  test("repo/tree and repo/read run on the Node host as the engine worker registers them, through RepoApi's routes", async () => {
    const h = await repoHarness(server)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const reads = flows(h)
    const tree = await runFlow(RepoTree, { repo: "octocat/Spoon-Knife", revision: headSha }, reads)
    expect(tree.status).toBe("completed")
    expect(Exit.isSuccess(tree.exit) && tree.exit.value.paths).toEqual(expect.arrayContaining(["README.md"]))
    const file = await runFlow(RepoRead, { repo: "octocat/Spoon-Knife", revision: headSha, path: "README.md" }, reads)
    expect(file.exit).toEqual(Exit.succeed({ state: "text", contents: expect.stringContaining("# Fixture"), size: 43 }))
    const large = await runFlow(RepoRead, { repo: "octocat/Spoon-Knife", revision: headSha, path: "big.txt" }, reads)
    expect(large.exit).toEqual(Exit.succeed({ state: "too-large", size: 600 * 1024 }))
    const missing = await runFlow(RepoRead, { repo: "octocat/Spoon-Knife", revision: headSha, path: "gone.md" }, reads)
    expect(Exit.isFailure(missing.exit)).toBe(true)
    expect(missing.status).toBe("failed")
  })
})

/** The tab's answers of who the person is on each repository, as rows. */
const rolesOf = (tab: Tab) => tab.repo.queries.roles.toArray.map(({ id, role, own }) => ({ id, role, own }))

describe("who the person is on a repository (decision 0079)", () => {
  test("a repository route asks ChatApi: the role there and whether it is the deployment's own", async () => {
    const h = await repoHarness(server, { roles: "octocat/Spoon-Knife" })
    const tab = await open(h)
    tab.repo.actions.role("octocat", "Spoon-Knife")
    // Without the App, a role counts on the deployment's own repository alone.
    tab.repo.actions.role("acme", "widgets")
    await waitFor(() =>
      expect([...tab.repo.queries.roles.toArray].map(({ id, role, own }) => ({ id, role, own })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "github/acme/widgets", role: null, own: false },
        { id: "github/octocat/spoon-knife", role: "member", own: true },
      ])
    )
    expect(tab.count(roleAnswers, { outcome: "answered", role: "member" })).toBe(1)
    expect(tab.count(roleAnswers, { outcome: "answered", role: "none" })).toBe(1)
    expect(tab.lines("repo.role").map((line) => line.annotations)).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "answered", role: "member", own: true }),
    ]))
    // A name GitHub couldn't have asks nothing.
    tab.repo.actions.role("-bad", "x")
    expect(tab.repo.queries.roles.toArray).toHaveLength(2)
  })

  test("a refused answer keeps the row this tab had, and says so in its records", async () => {
    const h = await repoHarness(server, { roles: "octocat/Spoon-Knife" })
    let refusing = false
    const real = RepoClient.layer({ origin: h.origin, within: "10 seconds" }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
    )
    // ChatApi answering, then refusing (test.faults-by-injection).
    const client = Layer.effect(
      RepoClient,
      Effect.map(Effect.service(RepoClient), (client) =>
        RepoClient.of({
          ...client,
          // A refusal with ChatApi's status, or no answer at all (no status).
          role: (owner, name) =>
            refusing
              ? Effect.fail(name === "widgets" ? new RepoRefused({}) : new RepoRefused({ status: 503 }))
              : client.role(owner, name),
        })),
    ).pipe(Layer.provide(real))
    const tab = await openTab({ origin: h.origin, fetch: h.fetch, client })
    tabs.push(tab)
    tab.repo.actions.role("octocat", "Spoon-Knife")
    await waitFor(() => expect(rolesOf(tab)).toEqual([{ id: "github/octocat/spoon-knife", role: "member", own: true }]))
    refusing = true
    tab.repo.actions.role("octocat", "Spoon-Knife")
    tab.repo.actions.role("acme", "widgets")
    await waitFor(() => expect(tab.count(roleAnswers, { outcome: "refused", role: "unknown" })).toBe(2))
    expect(rolesOf(tab)).toEqual([{ id: "github/octocat/spoon-knife", role: "member", own: true }])
    expect(tab.lines("repo.role").filter((line) => line.annotations.outcome === "refused").map((line) => [line.level, line.annotations.status]))
      .toEqual(expect.arrayContaining([["WARN", 503], ["WARN", 0]]))
  })
})

describe("what GitHub says, cloned or not", () => {
  test.each([
    ["rate_limited", GITHUB_LIMIT],
    // Will, 2026-10-19 12:41: "show some UI that mentions github is down and smithers will continue to work for repos
    // that are already imported". Before, GitHub down showed "Couldn't load".
    ["github_unavailable", GITHUB_DOWN],
    ["unavailable", COULDNT_LOAD],
  ])("an exhausted %s About read shows its refusal and retries successfully", async (code, message) => {
    const h = await repoHarness(server)
    h.github.publish("octocat", "Spoon-Knife")
    const real = RepoClient.layer({ origin: h.origin, within: "10 seconds" }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
    )
    let refused = true
    let attempts = 0
    const faulty = Layer.effect(RepoClient, Effect.map(RepoClient, (client) => RepoClient.of({
      ...client,
      about: (owner, name) => Effect.suspend(() => {
        attempts++
        return refused ? Effect.fail(new RepoRefused({ status: 503, code })) : client.about(owner, name)
      }),
    }))).pipe(Layer.provide(real))
    const tab = await openTab({ origin: h.origin, fetch: h.fetch, client: faulty })
    tabs.push(tab)
    tab.repo.actions.open(root("octocat", "Spoon-Knife"))
    // Exercise the real durable retry budget, including the terminal answer after it expires.
    await waitFor(() => expect(attempts).toBeGreaterThan(1))
    expect(tab.about().about?.state).toBe("loading")
    await waitFor(() => expect(tab.about().about).toMatchObject({ state: "failed", message }), { timeout: 150_000 })
    expect(tab.histogramCount(aboutLoadMs, { outcome: "failed" })).toBe(1)
    const exhausted = attempts
    tab.repo.actions.open(root("octocat", "Spoon-Knife"))
    expect(attempts).toBe(exhausted)
    expect(tab.about().about).toMatchObject({ state: "failed", message })
    refused = false
    expect(tab.repo.actions.retryAbout("octocat", "Spoon-Knife")).toBe(true)
    await waitFor(() => expect(tab.about().about?.state).toBe("ready"))
    expect(attempts).toBe(exhausted + 1)
    expect(tab.histogramCount(aboutLoadMs, { outcome: "ready" })).toBe(1)
    expect(h.github.calls.length).toBeGreaterThan(0)
  }, 180_000)

  test("a terminal public About refusal can be retried through the same flow", async () => {
    const h = await repoHarness(server)
    h.github.publish("octocat", "Spoon-Knife")
    const real = RepoClient.layer({ origin: h.origin, within: "10 seconds" }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
    )
    let paused = true
    const refusing = Layer.effect(
      RepoClient,
      Effect.map(Effect.service(RepoClient), (client) => RepoClient.of({
        ...client,
        about: (owner, name) => paused
          ? Effect.fail(new RepoRefused({ status: 503, code: "capacity" }))
          : client.about(owner, name),
      })),
    ).pipe(Layer.provide(real))
    const tab = await openTab({ origin: h.origin, fetch: h.fetch, client: refusing })
    tabs.push(tab)
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife" }, {})
    await waitFor(() => expect(tab.about().about).toMatchObject({ state: "failed", message: READING_PAUSED }))
    expect(tab.histogramCount(aboutLoadMs, { outcome: "failed" })).toBe(1)
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife" }, {})
    expect(tab.about().about).toMatchObject({ state: "failed", message: READING_PAUSED })
    expect(tab.repo.actions.retryAbout("", "")).toBe(false)
    paused = false
    expect(tab.repo.actions.retryAbout("octocat", "Spoon-Knife")).toBe(true)
    await waitFor(() => expect(tab.about().about?.state).toBe("ready"))
    expect(tab.histogramCount(aboutLoadMs, { outcome: "ready" })).toBe(1)
    expect(h.github.calls.length).toBeGreaterThan(0)
  })

  test("a repository nobody cloned shows GitHub's top folder, README and about at once, with no clone", async () => {
    const h = await repoHarness(server)
    h.github.publish("octocat", "Spoon-Knife")
    const tab = await open(h)
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife" }, {})
    await waitFor(() => expect(tab.about().about?.state).toBe("ready"))
    const about = aboutOf(tab.about().about)
    expect(previewTreeOf(about)).toEqual({ state: "ready", paths: ["README.md", "index.html"], directories: ["docs"], truncated: false })
    expect(previewReadmeOf(about)?.file).toMatchObject({ state: "text", contents: expect.stringContaining("Well hello there!") })
    expect(tab.view().repository).toBeUndefined()
    expect(h.started()).toEqual([])
    expect(tab.histogramCount(aboutLoadMs, { outcome: "ready" })).toBe(1)
    // Loaded once per tab: opening it again asks nothing more of GitHub.
    const calls = h.github.calls.length
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife" }, {})
    expect(h.github.calls).toHaveLength(calls)
  })

  test("one GitHub doesn't have is missing; one GitHub can't answer for a moment shows once it answers, with no reopen", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Gone" }, {})
    await waitFor(() => expect(tab.about().about).toMatchObject({ state: "missing", message: NOT_FOUND }))
    await waitFor(() => expect(header(tab)).toEqual({ kind: "clone", status: NOT_FOUND }))
    expect(tab.view().about).toMatchObject({ state: "missing", message: NOT_FOUND })
    expect(tab.view().repository).toBeUndefined()
    expect(tab.view().clone).toBeUndefined()
    expect(h.started()).toEqual([])
    h.github.publish("octocat", "Spoon-Knife")
    h.github.fail("", 502)
    const before = h.github.calls.length
    tab.repo.actions.openRoute("tree", { owner: "octocat", repo: "Spoon-Knife" }, {})
    // RepoApi answered 503: `repo/about`'s step waits and asks again under its retry policy, and the panel shows it
    // loading meanwhile. Before, the panel showed Couldn't load until the page was opened again.
    await waitFor(() => expect(h.github.calls.length).toBeGreaterThan(before))
    expect(tab.about().about?.state).toBe("loading")
    h.github.clear()
    await waitFor(() => expect(tab.about().about?.state).toBe("ready"), { timeout: 30_000 })
    expect(tab.histogramCount(aboutLoadMs, { outcome: "failed" })).toBe(0)
  })

  test("a file the repository's manifest lists: the manifest loads beside it, and links its flow and sources", async () => {
    const h = await repoHarness(server)
    const manifest = JSON.stringify({ outputs: { "docs/guide.md": { flow: "docs/build", inputs: ["src/index.ts"] } } })
    await h.seed("octocat", "Spoon-Knife", fixture({
      files: { ...fixture().files, ".smithers/generated.json": manifest, ".smithers/flows/docs/build/flow.ts": "x" },
    }))
    const tab = await open(h)
    at(tab, "blob", "main", "docs/guide.md")
    await waitFor(() => expect(tab.manifest().manifest?.state).toBe("text"))
    await waitFor(() => expect(tab.file().file?.state).toBe("text"))
    const { view, repository } = tab.view()
    expect(generatedLinksFor(view, repository, view.path, tab.file().file?.contents ?? undefined, tab.manifest().manifest, tab.tree().tree))
      .toEqual({
        flow: { label: "docs/build", href: "/octocat/Spoon-Knife/blob/main/.smithers/flows/docs/build/flow.ts" },
        sources: [{ label: "src/index.ts", href: "/octocat/Spoon-Knife/blob/main/src/index.ts" }],
      })
    expect(view.manifestPath).toBe(".smithers/generated.json")
    // A directory's page loads it too, for the branch's editor over it; a repository without one has none.
    at(tab, "tree", "main", "docs")
    await waitFor(() => expect(tab.manifest().manifest?.state).toBe("text"))
    // A project's own manifest is nearer than the root's, for its files and its folders alike.
    const nested = await repoHarness(server)
    await nested.seed("octocat", "Nested", fixture({
      files: {
        ...fixture().files,
        ".smithers/generated.json": manifest,
        "tools/docgen/.smithers/generated.json": JSON.stringify({ version: 1, outputs: { "out/a.md": { flow: "docs/generate" } } }),
        "tools/docgen/out/a.md": "# A",
      },
    }))
    const project = await open(nested)
    project.repo.actions.openRoute("blob", { owner: "octocat", repo: "Nested", ref: "main", _splat: "tools/docgen/out/a.md" }, {})
    await waitFor(() => expect(project.view().view.manifestPath).toBe("tools/docgen/.smithers/generated.json"))
    project.repo.actions.openRoute("tree", { owner: "octocat", repo: "Nested", ref: "main", _splat: "tools/docgen" }, {})
    await waitFor(() => expect(project.view().view.path).toBe("tools/docgen"))
    await waitFor(() => expect(project.view().view.manifestPath).toBe("tools/docgen/.smithers/generated.json"))
    const plain = await repoHarness(server)
    await plain.seed("octocat", "Plain")
    const other = await open(plain)
    other.repo.actions.openRoute("blob", { owner: "octocat", repo: "Plain", ref: "main", _splat: "README.md" }, {})
    await waitFor(() => expect(other.file().file?.state).toBe("text"))
    await waitFor(() => expect(other.tree().tree?.state).toBe("ready"))
    expect(other.view().view.manifestKey).toBeNull()
    expect(other.view().view.manifestPath).toBeNull()
  })
})
