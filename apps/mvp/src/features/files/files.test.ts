import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserCollectionCoordinator } from "@tanstack/browser-db-sqlite-persistence"
import { close as closeFile, FilesPage, open as openFile } from "./actions"
import { FilesStore } from "./store"
import { replaceRole, RepoStore } from "../repo/store"
// File tabs (docs/features/files.md): the strip and its links as pure functions; then a tab on RepoApi's real handler
// and Electric (src/test/repoDevice.ts), whose repository view keeps a tab for every file it shows, and whose
// `file/open` and `file/close` run on its own engine through dispatch, the person's door and the agent's, asking the
// tab over the real files channel. A step whose tab is gone runs on the Node host's engine with no tab listening.
import { Action } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Effect, Exit, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { repoAuthority } from "../../test/repoAuthority"
import { testFile } from "../../../worker/test/harness"
import { type RepoHarness, repoHarness, resetRepos } from "../../../worker/test/repos"
import { runFlow } from "../../../worker/test/flowHost"
import { FlowDispatch } from "../../flows/dispatch"
import { TabRequests } from "../../flows/requests"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { openTab, type Tab } from "../../test/repoDevice"
import { nodeDevice } from "../../test/chatApi"
import { FILES_TELEMETRY, filesChannel, LINES_PATTERN } from "./contract"
import { CloseFile, FileTabsTabs, normalPath, OpenFile, registration } from "./flows"
import { fileTabs } from "./metrics"
import type { FileTabRow, Here } from "./schema"
import { fileHref, hereOf, linesOf, rootHref, stripOf, tabKey, tabsAt } from "./view"

const AT = { owner: "octocat", name: "Spoon-Knife", revision: "main" } as const

const row = (path: string, position: number, overrides: Partial<FileTabRow> = {}): FileTabRow => ({
  key: tabKey(AT, path),
  ...AT,
  repoId: "github/octocat/spoon-knife",
  path,
  lines: null,
  position,
  ...overrides,
})

describe("the strip and its links", () => {
  test("a file's page and the root's, each segment encoded, the lines in ?L=", () => {
    expect(fileHref(AT, "src/index.ts", null)).toBe("/octocat/Spoon-Knife/blob/main/src/index.ts")
    expect(fileHref(AT, "src/index.ts", "3-5")).toBe("/octocat/Spoon-Knife/blob/main/src/index.ts?L=3-5")
    expect(fileHref({ owner: "a b", name: "c#d", revision: "feature/x" }, "my dir/é.md", "2"))
      .toBe("/a%20b/c%23d/blob/feature/x/my%20dir/%C3%A9.md?L=2")
    expect(rootHref({ ...AT, revision: "feature/x" })).toBe("/octocat/Spoon-Knife/tree/feature/x")
    expect(tabKey(AT, "a.ts")).toBe("octocat/Spoon-Knife@main:a.ts")
  })

  test("only the tabs of the repository and revision shown, in the order they opened, the file on screen active", () => {
    const rows = [
      row("b.ts", 3),
      row("a.ts", 1, { lines: "4" }),
      row("other.ts", 2, { revision: "v1" }),
      row("x.ts", 4, { owner: "other", key: "other" }),
    ]
    const here: Here = { ...AT, kind: "blob", path: "b.ts" }
    expect(tabsAt(rows, here).map((r) => r.path)).toEqual(["a.ts", "b.ts"])
    expect(stripOf(rows, here)).toEqual([
      { key: "a.ts", label: "a.ts", title: "a.ts", href: "/octocat/Spoon-Knife/blob/main/a.ts?L=4", active: false },
      { key: "b.ts", label: "b.ts", title: "b.ts", href: "/octocat/Spoon-Knife/blob/main/b.ts", active: true },
    ])
    // A directory has no file on screen; a file under one is labelled by its name.
    expect(stripOf([row("src/deep/c.ts", 1)], { ...AT, kind: "tree", path: "src" })).toEqual([
      { key: "src/deep/c.ts", label: "c.ts", title: "src/deep/c.ts", href: "/octocat/Spoon-Knife/blob/main/src/deep/c.ts", active: false },
    ])
    expect(stripOf(rows, undefined)).toEqual([])
  })

  test("lines as ?L= writes them", () => {
    expect(linesOf(null, null)).toBeNull()
    expect(linesOf(3, null)).toBe("3")
    expect(linesOf(3, 3)).toBe("3")
    expect(linesOf(3, 2)).toBe("3")
    expect(linesOf(3, 9)).toBe("3-9")
    expect(["12", "10-20"].every((lines) => LINES_PATTERN.test(lines))).toBe(true)
    expect(["0", "1-", "-2", "a", "1-2-3", ""].some((lines) => LINES_PATTERN.test(lines))).toBe(false)
  })

  test("where a tab is: the repository view's place, on that repository's root, directory or file page only", () => {
    const view = { owner: "octocat", name: "Spoon-Knife", revision: "main", kind: "blob" as const, path: "a.ts" }
    const here = { ...AT, kind: "blob", path: "a.ts" }
    expect(hereOf("/octocat/Spoon-Knife/blob/main/a.ts", view)).toEqual(here)
    expect(hereOf("/octocat/Spoon-Knife", view)).toEqual(here)
    // The URL changes at once and the view's row once the page opened: the URL's directory or file wins.
    expect(hereOf("/octocat/Spoon-Knife/tree/main", view)).toEqual({ ...AT, kind: "tree", path: "" })
    expect(hereOf("/octocat/Spoon-Knife/blob/main/src/b%20c.ts/", view)).toEqual({ ...AT, kind: "blob", path: "src/b c.ts" })
    expect(hereOf("/octocat/Spoon-Knife/blob/feature/x/a.ts", { ...view, revision: "feature/x" }))
      .toEqual({ ...AT, revision: "feature/x", kind: "blob", path: "a.ts" })
    // Another revision than the row's, or a revision the path only starts with: the row's place.
    expect(hereOf("/octocat/Spoon-Knife/blob/v1/b.ts", view)).toEqual(here)
    expect(hereOf("/octocat/Spoon-Knife/blob/mainline/b.ts", view)).toEqual(here)
    expect(hereOf("/a%20b/c", { ...view, owner: "a b", name: "c" })).toMatchObject({ owner: "a b", name: "c" })
    for (const pathname of ["/app", "/", "/octocat/Spoon-Knife/issues", "/octocat/other/blob/main/a.ts", "/octocat/%E0%A4%A"]) {
      expect([pathname, hereOf(pathname, view)]).toEqual([pathname, undefined])
    }
    // Before the revision resolves, or with no repository opened yet, nowhere.
    expect(hereOf("/octocat/Spoon-Knife", { ...view, revision: null })).toBeUndefined()
    expect(hereOf("/", { ...view, owner: "", name: "" })).toBeUndefined()
  })

  test("a path from the repository's root", () => {
    expect(normalPath("/src/a.ts/")).toBe("src/a.ts")
    expect(normalPath("README.md")).toBe("README.md")
  })

  test("the relay keeps every file tabs record", () => {
    for (const name of FILES_TELEMETRY.records) expect(BROWSER_TELEMETRY.records).toContain(name)
    for (const field of FILES_TELEMETRY.fields) expect(BROWSER_TELEMETRY.fields).toContain(field)
    expect(filesChannel("smithers")).toBe("smithers/files")
  })
})

const server = testFile("files_tab")
beforeEach(() => resetRepos(server))

const waitFor = <A>(check: () => A) => vi.waitFor(check, { timeout: 10_000 })

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

/** A tab on `h`'s RepoApi, with Spoon-Knife cloned. */
const open = async (h: RepoHarness) => {
  await h.seed("octocat", "Spoon-Knife")
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, confirmWithin: "10 seconds" })
  tabs.push(tab)
  return tab
}

/** Opens Spoon-Knife's `kind` page at main and `path`, as the router does: its location, then its route. */
const show = async (tab: Tab, kind: "tree" | "blob", path = "", L?: string) => {
  tab.at(`/octocat/Spoon-Knife/${kind}/main${path === "" ? "" : `/${path}`}`)
  tab.repo.actions.openRoute("blob" === kind ? "blob" : "tree", { owner: "octocat", repo: "Spoon-Knife", ref: "main", _splat: path }, L === undefined ? {} : { L })
  await waitFor(() => expect(tab.view().view).toMatchObject({ kind, path, revision: "main" }))
}

/** Runs `name` with `payload` through the tab's dispatch, as its strip (door `button`) or the agent does. */
const dispatch = (tab: Tab, name: "file/open" | "file/close", payload: object, options: { door?: "button" | "agent"; executionId?: string } = {}) =>
  tab.runtime.runPromise(
    Effect.exit(Effect.flatMap(FlowDispatch, (d) =>
      d.dispatch(name, payload as never, { door: options.door ?? "button", ...(options.executionId === undefined ? {} : { executionId: options.executionId }) }))),
  )

/** What a dispatch that ran answered: `{ _tag: "Done", value }` or `{ _tag: "Failed", error }`; else its failure. */
const ran = async (...args: Parameters<typeof dispatch>) => {
  const exit = await dispatch(...args)
  return Exit.isSuccess(exit) ? exit.value : exit
}

const paths = (tab: Tab) => tab.tabs().map((r) => [r.path, r.lines])

describe("a file the repository view shows", () => {
  test("a refused coordinator request leaves the route follower listening for the next file", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife")
    const host = nodeDevice().persistence!
    let refuse = false
    let refused = false
    // A transient host/channel failure before SQLite is reached; a SQL durability
    // failure deliberately puts TanStack's collection in a terminal error state.
    class RefusingCoordinator extends BrowserCollectionCoordinator {
      override async requestApplyLocalMutations(...args: Parameters<BrowserCollectionCoordinator["requestApplyLocalMutations"]>) {
        if (refuse) {
          refuse = false
          refused = true
          throw new Error("coordinator request refused")
        }
        return super.requestApplyLocalMutations(...args)
      }
    }
    const device = `files-recovery-${crypto.randomUUID()}`
    const persistence = Persistence.layer({ ...host, coordinator: () => new RefusingCoordinator({ dbName: device }) })
    const tab = await openTab({ origin: h.origin, fetch: h.fetch, persistence })
    tabs.push(tab)
    await tab.runtime.runPromise(Effect.flatMap(FilesStore, (store) => store.tabs.restored))
    await show(tab, "tree")
    refuse = true
    await show(tab, "blob", "README.md")
    await waitFor(() => expect(refused).toBe(true))
    await waitFor(() => expect(tab.lines("persisted write failed")).toHaveLength(1))
    await show(tab, "blob", "src/index.ts", "2-4")
    await waitFor(() => expect(paths(tab)).toContainEqual(["src/index.ts", "2-4"]))
  })

  test("gets a tab with its lines; another file adds one after it; the lines follow the page", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    await show(tab, "blob", "README.md", "2")
    await waitFor(() => expect(paths(tab)).toEqual([["README.md", "2"]]))
    await show(tab, "blob", "src/index.ts", "1-3")
    await waitFor(() => expect(paths(tab)).toEqual([["README.md", "2"], ["src/index.ts", "1-3"]]))
    await show(tab, "blob", "README.md")
    await waitFor(() => expect(paths(tab)).toEqual([["README.md", null], ["src/index.ts", "1-3"]]))
    // A directory adds none.
    await show(tab, "tree", "docs")
    expect(paths(tab)).toEqual([["README.md", null], ["src/index.ts", "1-3"]])
    expect(tab.tabs().map((r) => r.revision)).toEqual(["main", "main"])
  })

  // Astra on 19af7eb9: the gate stays closed until the device's refusal marks are applied, so a cold reload shows no
  // row before them. This measures what that costs (the coordinator's ruling: tell them if it is over 100 ms): the time
  // from the store's start to the marks being known, and how long the strip's first tab waits past its stored row.
  test("a cold reload with a stored refusal shows the strip once the refusals are known, and says how long that took", async () => {
    const h = await repoHarness(server)
    await h.seed("octocat", "Spoon-Knife")
    const device = nodeDevice()
    const persistence = Persistence.layer(device.persistence!)
    const first = await openTab({ origin: h.origin, fetch: h.fetch, confirmWithin: "10 seconds", persistence })
    tabs.push(first)
    await show(first, "blob", "README.md", "2")
    await waitFor(() => expect(paths(first)).toEqual([["README.md", "2"]]))
    // Another repository refused this person: its mark is on the device.
    await first.runtime.runPromise(Effect.flatMap(RepoStore, (store) => store.refuse("github/acme/refused")))
    await waitFor(() => expect(device.stored("repo-refusals")).toBe(1))
    await first.dispose()
    tabs.splice(tabs.indexOf(first), 1)
    const openedAt = performance.now()
    const second = await openTab({ origin: h.origin, fetch: h.fetch, confirmWithin: "10 seconds", persistence })
    tabs.push(second)
    const files = await second.runtime.runPromise(Effect.service(FilesStore))
    files.all.tanstack.startSyncImmediate()
    let storedAt: number | undefined
    let shownAt: number | undefined
    await vi.waitFor(() => {
      const now = performance.now()
      if (storedAt === undefined && files.tabs.tanstack.toArray.length > 0) storedAt = now
      if (shownAt === undefined && files.all.tanstack.toArray.length > 0) shownAt = now
      expect(shownAt).toBeDefined()
    }, { timeout: 10_000, interval: 1 })
    const known = second.lines("repo.refusals.known")[0]?.annotations
    expect(known).toMatchObject({ marks: 1 })
    console.log(`[data gate timing] store start to refusals known: ${String(known?.durationMs)} ms; ` +
      `strip's first tab after its stored row: ${(shownAt! - (storedAt ?? shownAt!)).toFixed(1)} ms; ` +
      `tab open to first tab shown: ${(shownAt! - openedAt).toFixed(1)} ms`)
    expect(files.all.tanstack.toArray.map((row) => row.path)).toEqual(["README.md"])
  })

  // Astra on 0c7b9f01: the strip filtered the tabs in its component; the store exposed every one. The store's query
  // holds none of a repository that may not show, from the change that hides it, and they stay on the device.
  test("a refused repository's tabs leave the store's query in the same change, and stay on the device", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    await show(tab, "blob", "README.md", "2")
    await waitFor(() => expect(paths(tab)).toEqual([["README.md", "2"]]))
    const after = await tab.runtime.runPromise(Effect.gen(function* () {
      const repos = yield* RepoStore
      const files = yield* FilesStore
      yield* replaceRole(repos, { id: "github/octocat/spoon-knife", role: null, own: false, refused: "forbidden" })
      return { shown: (yield* files.all.toArray).map((r) => r.path), kept: (yield* files.tabs.toArray).map((r) => r.path) }
    }))
    expect(after).toEqual({ shown: [], kept: ["README.md"] })
  })
})

describe("file/open and file/close", () => {
  test("a person's file/open opens the file of the repository shown, at its lines, as a tab, recorded by door", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    await show(tab, "tree")
    expect(await ran(tab, "file/open", { path: "/docs/guide.md", lines: "1-2" })).toEqual({
      _tag: "Done",
      value: { repository: "octocat/Spoon-Knife", ref: "main", path: "docs/guide.md", lines: "1-2", opened: true },
    })
    expect(tab.navigated).toEqual(["/octocat/Spoon-Knife/blob/main/docs/guide.md?L=1-2"])
    expect(paths(tab)).toEqual([["docs/guide.md", "1-2"]])
    expect(tab.count(fileTabs, { op: "open", door: "button", outcome: "opened" })).toBe(1)
    expect(tab.lines("files.tab")[0]!.annotations).toMatchObject({ op: "open", door: "button", outcome: "opened" })
    // The strip's click opens a tab at the lines it last highlighted.
    await tab.files.actions.open("docs/guide.md")
    expect(tab.navigated.at(-1)).toBe("/octocat/Spoon-Knife/blob/main/docs/guide.md?L=1-2")
  })

  test("the agent's call opens the file in the tab whose composer asked, recorded as the agent's", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    await show(tab, "blob", "README.md")
    await tab.runtime.runPromise(Effect.flatMap(TabRequests, (r) => r.add("answer-1", "composer")))
    expect(await ran(tab, "file/open", { path: "src/index.ts" }, { door: "agent", executionId: "answer-1/call/1" }))
      .toMatchObject({ _tag: "Done", value: { opened: true } })
    expect(tab.navigated).toEqual(["/octocat/Spoon-Knife/blob/main/src/index.ts"])
    await waitFor(() => expect(paths(tab)).toEqual([["README.md", null], ["src/index.ts", null]]))
    expect(tab.count(fileTabs, { op: "open", door: "agent", outcome: "opened" })).toBe(1)
  })

  test("closing the file on screen shows the tab after it, else before it, else the root; closing another moves nothing", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    for (const path of ["README.md", "src/index.ts", "docs/guide.md"]) await show(tab, "blob", path)
    await waitFor(() => expect(tab.tabs()).toHaveLength(3))
    await show(tab, "blob", "src/index.ts", "2")
    await waitFor(() => expect(paths(tab)[1]).toEqual(["src/index.ts", "2"]))
    // Not on screen: it goes, and the page stays.
    await tab.files.actions.close("README.md")
    expect(paths(tab).map(([path]) => path)).toEqual(["src/index.ts", "docs/guide.md"])
    expect(tab.navigated).toEqual([])
    // On screen: the next tab shows.
    await tab.files.actions.close("src/index.ts")
    expect(tab.navigated).toEqual(["/octocat/Spoon-Knife/blob/main/docs/guide.md"])
    await show(tab, "blob", "docs/guide.md")
    await show(tab, "blob", "README.md")
    await waitFor(() => expect(tab.tabs()).toHaveLength(2))
    // The last tab on screen: the one before it shows.
    await tab.files.actions.close("README.md")
    expect(tab.navigated.at(-1)).toBe("/octocat/Spoon-Knife/blob/main/docs/guide.md")
    await show(tab, "blob", "docs/guide.md")
    // The only tab: the root shows.
    expect(await ran(tab, "file/close", { path: "docs/guide.md" })).toEqual({ _tag: "Done", value: { closed: true } })
    expect(tab.navigated.at(-1)).toBe("/octocat/Spoon-Knife/tree/main")
    // No such tab: nothing closes.
    expect(await ran(tab, "file/close", { path: "nope.md" })).toEqual({ _tag: "Done", value: { closed: false } })
    expect(tab.count(fileTabs, { op: "close", door: "button", outcome: "closed" })).toBe(4)
    expect(tab.count(fileTabs, { op: "close", door: "button", outcome: "absent" })).toBe(1)
  })

  test("a tab that shows no repository refuses: NotInRepository, and nothing opens or closes", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    await show(tab, "blob", "README.md")
    tab.at("/app")
    for (const [name, payload] of [["file/open", { path: "README.md" }], ["file/close", { path: "README.md" }]] as const) {
      expect(await ran(tab, name, payload)).toMatchObject({ _tag: "Failed", error: { _tag: "@smthrs/mvp/files/NotInRepository" } })
    }
    expect(tab.navigated).toEqual([])
    expect(paths(tab)).toEqual([["README.md", null]])
    expect(tab.count(fileTabs, { op: "open", door: "button", outcome: "no_repository" })).toBe(1)
    expect(tab.lines("files.tab").map((line) => line.level)).toContain("WARN")
    // The strip's click there opens nothing either.
    await tab.files.actions.open("README.md")
    expect(tab.navigated).toEqual([])
  })

  test("payloads that aren't a file and lines are refused before any step", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    await show(tab, "tree")
    for (const payload of [
      { path: "" },
      { path: "/" },
      { path: "." },
      { path: "../README.md" },
      { path: "docs/../../x" },
      { path: "docs/.." },
      { path: "a.ts", lines: "0" },
      { path: "a.ts", lines: "3-" },
      { path: "x".repeat(1_025) },
    ]) {
      expect(Exit.isFailure(await dispatch(tab, "file/open", payload))).toBe(true)
    }
    expect(tab.navigated).toEqual([])
    // A dot that isn't a whole segment is a name.
    expect(await ran(tab, "file/open", { path: ".github/a..b.md" })).toMatchObject({ _tag: "Done", value: { opened: true } })
  })

  test("closing a file whose page is still opening shows the tab before it, and its tab stays closed", async () => {
    const h = await repoHarness(server)
    const tab = await open(h)
    await show(tab, "blob", "README.md")
    await waitFor(() => expect(tab.tabs()).toHaveLength(1))
    // The URL moves at once; the route hasn't opened src/index.ts yet.
    await ran(tab, "file/open", { path: "src/index.ts" })
    expect(paths(tab)).toEqual([["README.md", null], ["src/index.ts", null]])
    expect(await ran(tab, "file/close", { path: "src/index.ts" })).toEqual({ _tag: "Done", value: { closed: true } })
    expect(tab.navigated).toEqual(["/octocat/Spoon-Knife/blob/main/src/index.ts", "/octocat/Spoon-Knife/blob/main/README.md"])
    expect(paths(tab)).toEqual([["README.md", null]])
  })
})

test("a step whose tab is gone settles: opened false, closed false, counted as gone", async () => {
  const name = `files-${crypto.randomUUID()}`
  const steps = registration.pipe(
    Layer.provide(FileTabsTabs.layerChannel({ name, within: "100 millis" })),
    Layer.provide(TabChannel.layer),
    Layer.provideMerge(Action.layerImplementations),
  )
  const { exit } = await runFlow(OpenFile, { path: "a.ts", lines: "2" }, steps)
  expect(exit).toEqual(Exit.succeed({ repository: "", ref: "", path: "a.ts", lines: "2", opened: false }))
  const closed = await runFlow(CloseFile, { path: "a.ts" }, steps)
  expect(closed.exit).toEqual(Exit.succeed({ closed: false }))
})


test("a headless device keeps and closes tabs without a routed repository follower", async () => {
  const stored = (value: FileTabRow) => ({ ...value, $collectionId: "file-tabs", $hasPendingWrites: false,
    $key: value.key, $origin: "local", $synced: true })
  await Effect.runPromise(Effect.gen(function* () {
    const store = yield* FilesStore
    yield* store.keep(AT, "README.md", "2-4")
    yield* store.keep(AT, "other.ts", null)
    expect(yield* store.tabs.toArray).toEqual([
      stored(row("README.md", 1, { lines: "2-4" })), stored(row("other.ts", 2)),
    ])
    expect(yield* store.drop(AT, "README.md")).toBe(true)
    expect(yield* store.tabs.toArray).toEqual([stored(row("other.ts", 2))])
    expect(yield* store.drop(AT, "README.md")).toBe(false)
  }).pipe(Effect.provide(FilesStore.layer.pipe(Layer.provide(repoAuthority), Layer.provide(Persistence.memory)))))
})

test("a host without a router pathname refuses file actions even with repository rows present", async () => {
  const h = await repoHarness(server)
  const tab = await open(h)
  await show(tab, "blob", "README.md")
  await waitFor(() => expect(paths(tab)).toEqual([["README.md", null]]))
  const navigated: Array<string> = []
  const page = FilesPage.layer({ navigate: (path) => { navigated.push(path) } })
  const replies = await tab.runtime.runPromise(Effect.all([
    openFile("other.ts", "2-4"), closeFile("README.md"),
  ]).pipe(Effect.provide(page)))
  expect(replies).toEqual([
    { repository: null, ref: null, done: false },
    { repository: null, ref: null, done: false },
  ])
  expect(navigated).toEqual([])
  expect(paths(tab)).toEqual([["README.md", null]])
})
