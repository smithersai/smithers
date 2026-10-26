import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { fixture, scripted } from "../../../worker/test/codeStorage"
import { testFile } from "../../../worker/test/harness"
import { type RepoHarness, repoHarness, resetRepos } from "../../../worker/test/repos"
import { openTab, type Tab } from "../../test/repoDevice"
import { Deferred, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import type { CuratedFile } from "../../../worker/home/Curated.ts"
import { scriptedGitHub, spoonKnife } from "../../../worker/test/githubRest"
import { RepoClient } from "../repo/api"
import { RepoStore } from "../repo/store"
import { HomeClient, HomeRefused } from "./api"
import { HomeStore } from "./store"
import { HOME_FILE, HOME_INVALID, HOME_UNREADABLE } from "./contract"
import { answers, resolves } from "./metrics"
import { homePageOf, tabsOf } from "./view"

// A repository's home on a tab, driven as React drives it, with no React: the route's loader calls `open`, and the
// page reads the `Home` layer's live queries. The tab reaches RepoApi's real handler (worker/RepoApi.ts) over the
// compose Postgres and Electric; Code Storage is the scripted provider (worker/test/codeStorage.ts), whose faults stand
// in for an outage (test.faults-by-injection).

const server = testFile("home_tab")
beforeEach(() => resetRepos(server))

const waitFor = <A>(check: () => A) => vi.waitFor(check, { timeout: 10_000 })

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

const open = async (h: RepoHarness, homeClient?: Layer.Layer<HomeClient>) => {
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, ...(homeClient === undefined ? {} : { homeClient }) })
  tabs.push(tab)
  return tab
}

/** What the page shows, and the tabs over it. */
const page = (tab: Tab) => {
  const { current, home, curated } = tab.home.queries.home.toArray[0]!
  const shown = homePageOf(current, home, curated)
  return { page: shown, tabs: tabsOf(shown, current), current, home, curated }
}

/** The kinds of block the page shows, section by section. */
const kinds = (tab: Tab) => {
  const shown = page(tab).page
  return shown.kind === "home" ? shown.sections.map((section) => section.blocks.map((block) => block.type)) : shown.kind
}

/** Effect's HttpClient over the harness's `fetch`: how a faulty client reaches the real route behind it. */
const fetchLayer = (h: RepoHarness) => FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, h.fetch)))

/** A curated home for `repository`: a Maintainers' section, a Members' one and everyone's. */
const curatedFor = (repository: string): CuratedFile => ({
  repository,
  defaultBranch: "trunk",
  home: {
    sections: [
      { title: "Today", audience: "maintainer", blocks: [{ type: "runs" }] },
      { title: "Your work", audience: "contributor", blocks: [{ type: "prompt" }] },
      { blocks: [{ type: "hero", title: `Curated ${SECRET}` }] },
    ],
  },
})

const files = (tab: Tab) => Object.fromEntries(tab.home.queries.files.toArray.map((file) => [file.path, file]))

/** A sentinel no record may carry. */
const SECRET = "sentinel-6b1f2c"

const declared = JSON.stringify({
  blocks: [
    { type: "prompt", title: `What should we work on? ${SECRET}`, placeholder: "Ask Smithers…" },
    { type: "text", text: `A small HTTP server. ${SECRET}` },
    { type: "links", links: [{ label: "Docs", url: `https://example.com/${SECRET}` }] },
    { type: "markdown", path: "docs/intro.md", title: "Intro" },
    { type: "markdown", path: "docs/intro.md" },
    { type: "markdown", path: "docs/missing.md" },
    { type: "app", flow: "flow.new", title: "Make a flow", picture: "wiki" },
    { type: "chart", data: [1, 2, 3] },
  ],
})

/** A ready repository whose default branch holds `files`. */
const seeded = async (h: RepoHarness, files: Record<string, string | Uint8Array>, defaultBranch = "main") => {
  // These scenarios read a ready home, with outages injected explicitly by each unhappy-path test.
  h.scripted.syncPolls = 0
  await h.seed("maya", "tinyhttp", fixture({ branch: defaultBranch, files: { "README.md": "# tinyhttp\n", ...files } }))
}

describe("a repository's home", () => {
  test("a declared home draws its blocks, reads its Markdown files once each at the same commit, and gets tabs", async () => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    await seeded(h, { [HOME_FILE]: declared, "docs/intro.md": `# Intro ${SECRET}\n` })
    const tab = await open(h)
    expect(tab.home.queries.stack("unopened").toArray).toEqual([])
    expect(tab.home.queries.stackAccess.toArray).toEqual([])
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).page.kind).toBe("home"))
    const { page: shown, tabs: links, home } = page(tab)
    expect(home).toMatchObject({ state: "declared", skipped: 1, reason: null })
    expect(shown.kind === "home" && shown.sections.flatMap((section) => section.blocks.map((block) => block.type)))
      .toEqual([
        "prompt",
        "text",
        "links",
        "markdown",
        "markdown",
        "markdown",
        "app",
      ])
    expect(shown).toMatchObject({ source: "declared", audience: "contributor" })
    expect(shown).toMatchObject({ askHref: "/maya/tinyhttp/tree/main" })
    expect(links).toEqual({ owner: "maya", repo: "tinyhttp", ref: "main", _splat: "", docs: false })
    await waitFor(() => expect(files(tab)["docs/missing.md"]?.state).toBe("failed"))
    await waitFor(() => expect(files(tab)["docs/intro.md"]).toMatchObject({ state: "text", text: `# Intro ${SECRET}\n` }))
    expect(h.scripted.calls.filter((call) => call.endsWith(":docs/intro.md"))).toHaveLength(1)
    expect(tab.count(resolves, { outcome: "declared" })).toBe(1)
    expect(tab.lines("home.resolve")[0]!.annotations).toMatchObject({
      feature: "home",
      outcome: "declared",
      blocks: 7,
      skipped: 1,
    })
    expect(tab.lines("home.file.load").map((line) => line.annotations.outcome).sort()).toEqual(["failed", "text"])
    // Nothing the repository wrote reaches a record.
    expect(JSON.stringify(tab.logs)).not.toContain(SECRET)
    // Opened again: the file that couldn't be read is read again; the one it has is not.
    const missing = () => h.scripted.calls.filter((call) => call.endsWith(":docs/missing.md")).length
    expect(missing()).toBe(1)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(missing()).toBe(2))
    await waitFor(() => expect(files(tab)["docs/missing.md"]?.state).toBe("failed"))
    expect(h.scripted.calls.filter((call) => call.endsWith(":docs/intro.md"))).toHaveLength(1)
  })

  test("opening it again, or another page of it, reads nothing more: a home at a commit never changes", async () => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    const home = JSON.stringify({ blocks: [{ type: "markdown", path: "docs/intro.md" }, { type: "text", text: "Hi" }] })
    await seeded(h, { [HOME_FILE]: home, "docs/intro.md": "# Intro\n" })
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(files(tab)["docs/intro.md"]?.state).toBe("text"))
    const reads = h.scripted.calls.length
    tab.home.actions.open("maya", "tinyhttp")
    // The page keeps its home while the head is read again.
    expect(page(tab).page.kind).toBe("home")
    await waitFor(() => expect(tab.count(resolves, { outcome: "cached" })).toBe(1))
    expect(h.scripted.calls.length).toBe(reads)
    expect(page(tab).page.kind).toBe("home")
  })

  test("a default branch named with a `/` splits into the tree route's ref and splat", async () => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    await seeded(h, { [HOME_FILE]: declared }, "release/1.0")
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).page.kind).toBe("home"))
    expect(page(tab).tabs).toEqual({ owner: "maya", repo: "tinyhttp", ref: "release", _splat: "1.0", docs: false })
    expect(page(tab).page).toMatchObject({ askHref: "/maya/tinyhttp/tree/release/1.0" })
  })

  test("a repository without a home is its tree, with navigation and no line", async () => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    await seeded(h, {})
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).home?.state).toBe("absent"))
    expect(page(tab)).toMatchObject({ page: { kind: "tree", notice: null }, tabs: { owner: "maya", repo: "tinyhttp", ref: "main", _splat: "", docs: false } })
    expect(tab.lines("home.resolve")[0]!.annotations).toMatchObject({ outcome: "absent", status: 404, blocks: 0 })
    expect(h.line("repo.blob").map((line) => line.annotations.status)).toEqual([204])
  })

  test("a home declaring no blocks is the tree too", async () => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    await seeded(h, { [HOME_FILE]: '{"blocks":[]}' })
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).home?.state).toBe("declared"))
    expect(page(tab)).toMatchObject({ page: { kind: "tree", notice: null }, tabs: { owner: "maya", repo: "tinyhttp", ref: "main", _splat: "", docs: false } })
  })

  // Each scenario gets the full tab and harness teardown before the next fixture reset.
  test.each([
    { body: "{ not json", reason: "json" },
    { body: '{"blocks":[{"type":"text","text":"<b>bold</b>"}]}', reason: "block" },
    { body: JSON.stringify({ blocks: Array.from({ length: 33 }, () => ({ type: "text", text: "x" })) }), reason: "blocks" },
    { body: new Uint8Array([0, 1, 2, 3]), reason: "binary" },
    { body: "x".repeat(512 * 1024 + 1), reason: "too_large" },
  ])("a home that isn't one is the tree under `Home is invalid`, by its reason: $reason", async ({ body, reason }) => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    await seeded(h, { [HOME_FILE]: body })
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).home?.state).toBe("invalid"))
    expect([reason, page(tab).home?.reason, page(tab).page]).toEqual([reason, reason, { kind: "tree", notice: HOME_INVALID }])
    expect(page(tab).tabs).toEqual({ owner: "maya", repo: "tinyhttp", ref: "main", _splat: "", docs: false })
    expect(tab.lines("home.resolve")[0]!.annotations).toMatchObject({ outcome: "invalid", reason })
  })

  test("RepoApi couldn't read it: the tree under `Couldn't read home`, read again on the next open", async () => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    await seeded(h, { [HOME_FILE]: declared })
    h.scripted.fail("readFile", h.scripted.error("readFile", "unavailable", 503))
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).home?.state).toBe("unreadable"))
    expect(page(tab).page).toEqual({ kind: "tree", notice: HOME_UNREADABLE })
    expect(tab.lines("home.resolve")[0]).toMatchObject({ level: "WARN", annotations: { outcome: "unreadable", status: 503 } })
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).page.kind).toBe("home"))
    expect(tab.count(resolves, { outcome: "declared" })).toBe(1)
  })

  test("a button's navigation that rejects is logged by its code, never its message, and one that resolves is not", async () => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    const tab = await open(h)
    tab.home.actions.watch("ask", Promise.reject(new TypeError("private navigation failure")))
    tab.home.actions.watch("action", Promise.resolve("/maya/tinyhttp"))
    await waitFor(() =>
      expect(tab.lines("home.navigate")).toEqual([expect.objectContaining({
        level: "WARN",
        annotations: expect.objectContaining({ feature: "home", what: "ask", outcome: "failed", errorCode: "TypeError" }),
      })])
    )
    expect(JSON.stringify(tab.logs)).not.toContain("private navigation failure")
  })

  test("before the repository is ready the page is the tree's; another repository interrupts the wait", async () => {
    const h = await repoHarness(server, { roles: "maya/tinyhttp" })
    await seeded(h, { [HOME_FILE]: declared })
    const tab = await open(h)
    // Not cloned: nothing while ChatApi is first asked; then, with no curated home, the tree's page, which says why.
    tab.home.actions.open("octocat", "Spoon-Knife")
    expect(page(tab)).toMatchObject({
      page: { kind: "loading" },
      current: { owner: "octocat", key: null, answering: true, previewing: true },
    })
    await waitFor(() => expect(page(tab).current).toMatchObject({ answering: false, previewing: false }))
    expect(page(tab)).toMatchObject({ page: { kind: "tree", notice: null }, curated: { state: "absent" } })
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).page.kind).toBe("home"))
    expect(page(tab).current).toMatchObject({ owner: "maya", name: "tinyhttp", defaultBranch: "main" })
    // A name GitHub couldn't have opens nothing.
    tab.home.actions.open("app", "x y")
    expect(page(tab)).toMatchObject({ page: { kind: "tree", notice: null }, current: { owner: "app", key: null } })
  })
})

describe("a repository's own home before any clone", () => {
  const vibe = JSON.stringify({
    docs: "https://vibelang.sh/llms.txt",
    sections: [
      { title: "Today", audience: "maintainer", blocks: [{ type: "runs" }] },
      { title: "Contribute", audience: "contributor", blocks: [{ type: "prompt" }] },
      { blocks: [{ type: "hero", title: `VibeLang ${SECRET}` }] },
    ],
  })
  const head = spoonKnife().commits[0]!.sha

  test("shows from what GitHub says, at its newest commit, by the person's audience, kept on the device", async () => {
    const h = await repoHarness(server, { actor: null })
    h.github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang", home: { text: vibe } }))
    const tab = await open(h)
    tab.home.actions.open("smithersai", "vibelang")
    await waitFor(() => expect(kinds(tab)).toEqual([["hero"]]))
    expect(page(tab).page).toMatchObject({ source: "declared", audience: "everyone", askHref: "/smithersai/vibelang/tree/main" })
    expect(page(tab).current).toMatchObject({ key: `github/smithersai/vibelang@${head}`, previewing: false })
    expect(page(tab).tabs).toEqual({ owner: "smithersai", repo: "vibelang", ref: "main", _splat: "", docs: true })
    expect(tab.count(resolves, { outcome: "preview" })).toBe(1)
    expect(JSON.stringify(tab.logs)).not.toContain(SECRET)
    // Opened again, the home it kept shows as it is: nothing is read or drawn twice.
    tab.home.actions.open("smithersai", "vibelang")
    await waitFor(() => expect(page(tab).current).toMatchObject({ answering: false, previewing: false }))
    expect(kinds(tab)).toEqual([["hero"]])
    expect(tab.count(resolves, { outcome: "preview" })).toBe(1)

    // This session's Member role was read on VibeLang, not the default deployment repository.
    const member = await repoHarness(server, { roles: "smithersai/vibelang" })
    member.github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang", home: { text: vibe } }))
    const inside = await open(member)
    inside.home.actions.open("smithersai", "vibelang")
    await waitFor(() => expect(kinds(inside)).toEqual([["prompt"], ["hero"]]))
  })

  test("a home with a Markdown block, an invalid one or none waits for the clone: the tree's page until then", async () => {
    const h = await repoHarness(server)
    const markdown = JSON.stringify({ blocks: [{ type: "markdown", path: "docs/intro.md" }] })
    h.github.publish("maya", "notes", spoonKnife({ fullName: "maya/notes", home: { text: markdown } }))
    h.github.publish("maya", "broken", spoonKnife({ fullName: "maya/broken", home: { text: "{" } }))
    h.github.publish("maya", "plain", spoonKnife({ fullName: "maya/plain" }))
    const tab = await open(h)
    for (const name of ["notes", "broken", "plain", "missing"]) {
      tab.home.actions.open("maya", name)
      await waitFor(() => expect(page(tab).current).toMatchObject({ name, answering: false, previewing: false }))
      expect(page(tab).page).toEqual({ kind: "tree", notice: null })
      // A tree has no views to switch between.
      tab.home.actions.view("everyone")
      expect(page(tab).current).toMatchObject({ viewing: null, docs: null })
    }
  })

  test("another repository opened mid-read keeps none of the first one's home or docs", async () => {
    // VibeLang's home file is held at GitHub, so its read is in flight when maya/plain opens.
    const github = scriptedGitHub()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let asked = false
    const h = await repoHarness(server, {
      actor: null,
      github: {
        ...github,
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname.endsWith(`smithersai/vibelang/contents/${HOME_FILE}`)) {
            asked = true
            await held
          }
          return github.fetch(request)
        },
      },
    })
    github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang", home: { text: vibe } }))
    github.publish("maya", "plain", spoonKnife({ fullName: "maya/plain" }))
    const tab = await open(h)
    tab.home.actions.open("smithersai", "vibelang")
    await waitFor(() => expect(asked).toBe(true))
    tab.home.actions.open("maya", "plain")
    await waitFor(() => expect(page(tab).current).toMatchObject({ name: "plain", answering: false, previewing: false }))
    // VibeLang's read lands while maya/plain shows: nothing of it shows here.
    release()
    expect(page(tab).page).toEqual({ kind: "tree", notice: null })
    expect(page(tab).current).toMatchObject({ key: null, docs: null, curatedDocs: null })
    tab.home.actions.open("smithersai", "vibelang")
    await waitFor(() => expect(page(tab).tabs).toMatchObject({ repo: "vibelang", docs: true }))
  })

  test("a clone that lands while GitHub's copy of the home is read wins over it", async () => {
    // GitHub's answer for the home file is held until the clone's home shows: the injected GitHub, not a mock.
    const github = scriptedGitHub()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const h = await repoHarness(server, {
      github: {
        ...github,
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname.endsWith(`/contents/${HOME_FILE}`)) await held
          return github.fetch(request)
        },
      },
    })
    github.publish("maya", "tinyhttp", spoonKnife({ fullName: "maya/tinyhttp", home: { text: vibe } }))
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await seeded(h, { [HOME_FILE]: declared })
    const cloned = [["prompt", "text", "links", "markdown", "markdown", "markdown", "app"]]
    await waitFor(() => expect(kinds(tab)).toEqual(cloned))
    release()
    await waitFor(() => expect(page(tab).current.previewing).toBe(false))
    expect(kinds(tab)).toEqual(cloned)
    expect(tab.count(resolves, { outcome: "preview" })).toBe(0)
  })

  test("once the repository is ready, its clone's home is read instead", async () => {
    const h = await repoHarness(server)
    await seeded(h, { [HOME_FILE]: declared })
    h.github.publish("maya", "tinyhttp", spoonKnife({ fullName: "maya/tinyhttp", home: { text: vibe } }))
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(kinds(tab)).toEqual([["prompt", "text", "links", "markdown", "markdown", "markdown", "app"]]))
  })
})

describe("Smithers' curated home", () => {
  test("shows for a repository that isn't on this device, with only the sections ChatApi sends a Member", async () => {
    const h = await repoHarness(server, { homes: [curatedFor("octocat/Spoon-Knife")], roles: "octocat/Spoon-Knife" })
    const tab = await open(h)
    // No repository open: there is no view to switch.
    tab.home.actions.view("everyone")
    expect(page(tab).current).toMatchObject({ repoId: null, viewing: null })
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(page(tab).page.kind).toBe("home"))
    expect(page(tab).page).toMatchObject({ source: "curated", audience: "contributor", askHref: "/octocat/Spoon-Knife/tree/trunk" })
    expect(kinds(tab)).toEqual([["prompt"], ["hero"]])
    expect(page(tab).tabs).toEqual({ owner: "octocat", repo: "Spoon-Knife", ref: "trunk", _splat: "", docs: false })
    expect(page(tab).current).toMatchObject({ audience: "contributor", answering: false, key: null })
    expect(tab.count(answers, { outcome: "declared" })).toBe(1)
    expect(tab.lines("home.answer")[0]!.annotations).toMatchObject({ feature: "home", outcome: "declared", audience: "contributor", sections: 2 })
    // Nothing the curated home says reaches a record.
    expect(JSON.stringify(tab.logs)).not.toContain(SECRET)
  })

  test("signed out it is everyone's section alone; a Maintainer gets all three, but not a Maintainer of another repository", async () => {
    const out = await repoHarness(server, { homes: [curatedFor("octocat/Spoon-Knife")], actor: null, roles: "octocat/Spoon-Knife" })
    const visitor = await open(out)
    visitor.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(kinds(visitor)).toEqual([["hero"]]))
    expect(page(visitor).page).toMatchObject({ audience: "everyone" })

    const maintainer = { subject: { kind: "person" as const, id: "maya" }, role: "maintainer" as const }
    const inside = await repoHarness(server, { homes: [curatedFor("octocat/Spoon-Knife")], actor: maintainer, roles: "octocat/Spoon-Knife" })
    const tab = await open(inside)
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(kinds(tab)).toEqual([["runs"], ["prompt"], ["hero"]]))

    // A Maintainer of another repository: roles are per repository, so everyone's section alone.
    const elsewhere = await repoHarness(server, { homes: [curatedFor("octocat/Spoon-Knife")], actor: maintainer, roles: "maya/tinyhttp" })
    const other = await open(elsewhere)
    other.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(kinds(other)).toEqual([["hero"]]))
    expect(page(other).page).toMatchObject({ audience: "everyone" })
  })

  test("a Maintainer switches down to the contributor and user views; another repository opens on their own", async () => {
    const maintainer = { subject: { kind: "person" as const, id: "maya" }, role: "maintainer" as const }
    const h = await repoHarness(server, {
      homes: [curatedFor("octocat/Spoon-Knife"), curatedFor("octocat/hello-world")],
      roles: "octocat/Spoon-Knife",
      actor: maintainer,
    })
    const tab = await open(h)
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(kinds(tab)).toEqual([["runs"], ["prompt"], ["hero"]]))
    expect(page(tab).page).toMatchObject({ audience: "maintainer", views: ["maintainer", "contributor", "everyone"] })

    tab.home.actions.view("contributor")
    expect(kinds(tab)).toEqual([["prompt"], ["hero"]])
    tab.home.actions.view("everyone")
    expect(kinds(tab)).toEqual([["hero"]])
    expect(page(tab).page).toMatchObject({ audience: "everyone", views: ["maintainer", "contributor", "everyone"] })
    tab.home.actions.view("maintainer")
    expect(kinds(tab)).toEqual([["runs"], ["prompt"], ["hero"]])

    tab.home.actions.view("everyone")
    tab.home.actions.open("octocat", "hello-world")
    // The role was read on Spoon-Knife alone. Navigation resets View as, never transfers authority.
    await waitFor(() => expect(kinds(tab)).toEqual([["hero"]]))
    expect(page(tab).page).toMatchObject({ audience: "everyone", views: [] })
    expect(page(tab).current.viewing).toBeNull()
    tab.home.actions.view("maintainer")
    expect(kinds(tab)).toEqual([["hero"]])
    expect(page(tab).current.viewing).toBeNull()
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(kinds(tab)).toEqual([["runs"], ["prompt"], ["hero"]]))
    expect(page(tab).page).toMatchObject({ audience: "maintainer", views: ["maintainer", "contributor", "everyone"] })
    expect(page(tab).current.viewing).toBeNull()
  })

  test("a Member may view as a user, never as a maintainer; a visitor has no view to switch to", async () => {
    const h = await repoHarness(server, { homes: [curatedFor("octocat/Spoon-Knife")], roles: "octocat/Spoon-Knife" })
    const tab = await open(h)
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(kinds(tab)).toEqual([["prompt"], ["hero"]]))
    tab.home.actions.view("maintainer")
    expect(kinds(tab)).toEqual([["prompt"], ["hero"]])
    expect(page(tab).current.viewing).toBeNull()
    tab.home.actions.view("everyone")
    expect(kinds(tab)).toEqual([["hero"]])

    const out = await repoHarness(server, { homes: [curatedFor("octocat/Spoon-Knife")], actor: null })
    const visitor = await open(out)
    visitor.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(kinds(visitor)).toEqual([["hero"]]))
    expect(page(visitor).page).toMatchObject({ views: [] })
    visitor.home.actions.view("contributor")
    expect(kinds(visitor)).toEqual([["hero"]])
  })

  test("a repository's own home wins over the curated one", async () => {
    const h = await repoHarness(server, { homes: [curatedFor("maya/tinyhttp")], roles: "maya/tinyhttp" })
    await seeded(h, { [HOME_FILE]: declared, "docs/intro.md": "# Intro\n" })
    const tab = await open(h)
    tab.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(tab).home?.state).toBe("declared"))
    await waitFor(() => expect(page(tab).curated?.state).toBe("declared"))
    expect(page(tab).page).toMatchObject({ source: "declared" })
  })

  test("without a repository's own home, the curated home shows", async () => {
    const bare = await repoHarness(server, { homes: [curatedFor("maya/tinyhttp")], roles: "maya/tinyhttp" })
    await seeded(bare, {})
    const other = await open(bare)
    other.home.actions.open("maya", "tinyhttp")
    await waitFor(() => expect(page(other).home?.state).toBe("absent"))
    await waitFor(() => expect(page(other).page).toMatchObject({ source: "curated", defaultBranch: "trunk" }))
  })

  test("ChatApi couldn't answer: the tree, and a curated home this device kept stays", async () => {
    const state = { down: true }
    const faulty = Layer.effect(
      HomeClient,
      Effect.map(HomeClient, (real) =>
        HomeClient.of({
          answer: (owner, name) => (state.down ? Effect.fail(new HomeRefused({ status: 503 })) : real.answer(owner, name)),
        })),
    )
    const h = await repoHarness(server, { homes: [curatedFor("octocat/Spoon-Knife")], roles: "octocat/Spoon-Knife" })
    const tab = await open(
      h,
      faulty.pipe(Layer.provide(HomeClient.layer({ origin: h.origin, within: "10 seconds" })), Layer.provide(fetchLayer(h))),
    )
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(page(tab).current).toMatchObject({ answering: false, previewing: false }))
    expect(page(tab)).toMatchObject({ page: { kind: "tree", notice: null }, curated: undefined, current: { audience: null } })
    expect(tab.lines("home.answer")[0]).toMatchObject({ level: "WARN", annotations: { outcome: "unreadable", status: 503 } })
    expect(tab.count(answers, { outcome: "unreadable" })).toBe(1)
    // Answered once, the home is kept: a failed answer later leaves it.
    state.down = false
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(page(tab).page).toMatchObject({ source: "curated" }))
    state.down = true
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(tab.count(answers, { outcome: "unreadable" })).toBe(2))
    expect(page(tab).page).toMatchObject({ source: "curated", audience: "contributor" })
  })

  test("a curated home without a stack block, or a tab without TODOs or issues, opens no stack and no issues", async () => {
    const withStack: CuratedFile = {
      repository: "octocat/Spoon-Knife",
      defaultBranch: "main",
      home: { sections: [{ audience: "contributor", blocks: [{ type: "stack" }, { type: "issues" }] }] },
    }
    const h = await repoHarness(server, { homes: [withStack], roles: "octocat/Spoon-Knife" })
    const tab = await open(h)
    tab.home.actions.open("octocat", "Spoon-Knife")
    await waitFor(() => expect(page(tab).page.kind).toBe("home"))
    // This tab has no TODOs or issues store: the blocks' rows come from nowhere, and nothing is opened.
    expect(page(tab).current).toMatchObject({ stack: null, issues: null })
    const [items, syncs] = [tab.home.queries.items("github/octocat/Spoon-Knife"), tab.home.queries.syncs("github/octocat/Spoon-Knife")]
    items.startSyncImmediate()
    syncs.startSyncImmediate()
    await waitFor(() => expect([items.isReady(), syncs.isReady()]).toEqual([true, true]))
    expect([items.toArray, syncs.toArray]).toEqual([[], []])
  })
})


test("an interrupted Markdown read can be read on the next open", async () => {
  const h = await repoHarness(server)
  await seeded(h, { [HOME_FILE]: JSON.stringify({ blocks: [{ type: "markdown", path: "intro.md" }] }), "intro.md": "Intro" })
  const entered = Deferred.makeUnsafe<void>()
  let stalled = true
  const faulty = Layer.effect(RepoClient, Effect.map(RepoClient, (real) => RepoClient.of({ ...real,
    blob: (owner, name, sha, path) => path === "intro.md" && stalled
      ? Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)
      : real.blob(owner, name, sha, path),
  }))).pipe(Layer.provide(RepoClient.layer({ origin: h.origin, within: "10 seconds" })), Layer.provide(fetchLayer(h)))
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, client: faulty })
  tabs.push(tab)
  tab.home.actions.open("maya", "tinyhttp")
  await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("10 seconds")))
  tab.home.actions.open("invalid", "x y")
  stalled = false
  tab.home.actions.open("maya", "tinyhttp")
  await waitFor(() => expect(files(tab)["intro.md"]?.state).toBe("text"))
  expect(tab.lines("home.file.load").map((line) => line.annotations.outcome)).toContain("interrupted")
})

test("concurrent warm and open share a declaration read and warm its Markdown files", async () => {
  const h = await repoHarness(server)
  await seeded(h, { [HOME_FILE]: JSON.stringify({ blocks: [{ type: "markdown", path: "intro.md" }] }), "intro.md": "Introduction" })
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let reads = 0
  const faulty = Layer.effect(RepoClient, Effect.map(RepoClient, (real) => RepoClient.of({ ...real,
    blob: (owner, name, sha, path) => Effect.gen(function* () {
      if (path === HOME_FILE) {
        reads++
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }
      return yield* real.blob(owner, name, sha, path)
    }),
  }))).pipe(Layer.provide(RepoClient.layer({ origin: h.origin, within: "10 seconds" })), Layer.provide(fetchLayer(h)))
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, client: faulty })
  tabs.push(tab)
  // Preload the synced repository before racing its two readers.
  await tab.runtime.runPromise(Effect.flatMap(RepoStore, (store) => store.repositories.preload))
  const warming = tab.home.actions.warm("maya", "tinyhttp")
  await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("10 seconds")))
  tab.home.actions.open("maya", "tinyhttp")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await warming
  await waitFor(() => expect(files(tab)["intro.md"]?.state).toBe("text"))
  await waitFor(() => expect(page(tab).home?.state).toBe("declared"))
  expect(reads).toBe(1)
})


test("a preview delayed at its write cannot replace the clone's default branch", async () => {
  const provider = scripted()
  const cloneRelease = Deferred.makeUnsafe<void>()
  const previewEntered = Deferred.makeUnsafe<void>()
  const previewRelease = Deferred.makeUnsafe<void>()
  const previewDone = Deferred.makeUnsafe<void>()
  const h = await repoHarness(server, { scripted: provider, codeStorage: {
    ...provider.client,
    listCommits: (...args) => Effect.andThen(Deferred.await(cloneRelease), provider.client.listCommits(...args)),
  } })
  const text = JSON.stringify({ blocks: [{ type: "text", text: "Home" }] })
  provider.publish("maya", "tinyhttp", fixture({ branch: "release/1.0", files: { [HOME_FILE]: text } }))
  h.github.publish("maya", "tinyhttp", spoonKnife({ home: { text } }))
  let paused = false
  const homeStore = Layer.effect(HomeStore, Effect.map(HomeStore, (real) => HomeStore.of({
    ...real,
    current: { ...real.current, update: (...args) => Effect.gen(function* () {
      const span = yield* Effect.option(Effect.currentSpan)
      const delay = !paused && Option.isSome(span) && span.value.name === "home.preview"
      if (delay) {
        paused = true
        yield* Deferred.succeed(previewEntered, undefined)
        yield* Deferred.await(previewRelease)
      }
      const result = yield* real.current.update(...args)
      if (delay) yield* Deferred.succeed(previewDone, undefined)
      return result
    }) },
  }))).pipe(Layer.provide(HomeStore.layer))
  await h.clone("maya", "tinyhttp")
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, homeStore })
  tabs.push(tab)
  tab.home.actions.open("maya", "tinyhttp")
  try {
    await Effect.runPromise(Deferred.await(previewEntered).pipe(Effect.timeout("10 seconds")))
    await Effect.runPromise(Deferred.succeed(cloneRelease, undefined))
    await h.settled()
    await waitFor(() => expect(page(tab).current.defaultBranch).toBe("release/1.0"))
    await Effect.runPromise(Deferred.succeed(previewRelease, undefined))
    await Effect.runPromise(Deferred.await(previewDone).pipe(Effect.timeout("10 seconds")))
    expect(page(tab).current.defaultBranch).toBe("release/1.0")
    await waitFor(() => expect(page(tab).page).toMatchObject({ askHref: "/maya/tinyhttp/tree/release/1.0" }))
  } finally {
    await Effect.runPromise(Deferred.succeed(cloneRelease, undefined))
    await Effect.runPromise(Deferred.succeed(previewRelease, undefined))
  }
})
