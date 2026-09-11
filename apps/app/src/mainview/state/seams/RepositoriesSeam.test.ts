import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { BOOKMARK_WIRE } from "./fixtures/BookmarkWire"
import { USER_WORKSPACE_ROW } from "./fixtures/UserWorkspaceRow"
import { createRepositoriesSeam } from "./RepositoriesSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The repositories seam (lane piper step 2): /api/user/repos + /api/user/orgs
 * classify and list, one bookmarks call per repo fills the default bookmark's
 * head, and /api/user/workspaces feeds the cloud working copies — a 403 there
 * (the degraded legacy token) answers an empty list, honestly. plue#445's
 * `owner_type` and `default_bookmark_head` short-circuit the per-repo call
 * the moment they land. Nothing is faked: an unread head is `head: null`.
 *
 * The bookmarks and workspaces routes are answered with the SAME recorded
 * shapes BookmarksSeam and WorkspaceSeam are tested against
 * (fixtures/BookmarkWire.ts, fixtures/UserWorkspaceRow.ts): the cursor
 * envelope and plue's UserWorkspaceRow, never a shape only this suite knows.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const REPOS = [
  { owner: "will", name: "smithers", full_name: "will/smithers", default_bookmark: "main" },
  { owner: "plue", name: "plue", full_name: "plue/plue", default_bookmark: "main" },
  // No default bookmark: no head call, head stays null.
  { owner: "will", name: "scratch", full_name: "will/scratch", default_bookmark: null },
  // Malformed rows drop.
  { name: "broken" },
  null
]

/** The route answers by path; the query (`?limit=…&cursor=…`) rides along for the routes that page. */
const harness = async (
  route: (path: string, query: URLSearchParams) => Response | Promise<Response>,
  options: { readonly workspaces?: Response } = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<string> = []
  const ctx: SeamContext = {
    http: async (input) => {
      requests.push(input)
      const stripped = input.startsWith(CLOUD_ROUTE_PREFIX) ? input.slice(CLOUD_ROUTE_PREFIX.length) : input
      const [path = "", search = ""] = stripped.split("?")
      if (path === "api/user/workspaces" && options.workspaces !== undefined) return options.workspaces.clone()
      return route(path, new URLSearchParams(search))
    },
    baseUrl: "",
    store,
    dispatch: store.dispatch,
    actor: () => "user",
    nextOrdinal: () => 0
  }
  return { store, seam: createRepositoriesSeam(ctx), requests }
}

const backend = (path: string): Response => {
  switch (path) {
    case "api/user/repos":
      return json(200, REPOS)
    case "api/user/orgs":
      return json(200, [{ login: "plue" }])
    case "api/repos/will/smithers/bookmarks":
      return json(200, BOOKMARK_WIRE.page([
        BOOKMARK_WIRE.row("main", "qupxosqw", "c0ffee1"),
        BOOKMARK_WIRE.row("dev", "zzzzzzzz", "deadbeef")
      ]))
    case "api/repos/plue/plue/bookmarks":
      return json(500, { message: "boom" })
    default:
      return json(404, { message: `no route ${path}` })
  }
}

const repos = (store: AppStore) => [...store.collections.repositories.values()].sort((a, b) => a.id.localeCompare(b.id))
const copies = (store: AppStore) => [...store.collections.workingCopies.values()].sort((a, b) => a.id.localeCompare(b.id))
const bookmarkCalls = (requests: ReadonlyArray<string>) =>
  requests.filter((request) => request.includes("/bookmarks")).map((request) => request.slice(CLOUD_ROUTE_PREFIX.length))

describe("repositories seam", () => {
  test("loads the inventory: owners classified, heads from the default bookmark, workspaces as copies", async () => {
    const { store, seam, requests } = await harness(backend, {
      workspaces: json(200, [
        USER_WORKSPACE_ROW,
        // A switcher row whose state plue left out carries no state.
        { ...USER_WORKSPACE_ROW, workspace_id: "ws-2", workspace_title: "broken-row", state: undefined },
        // Malformed rows drop.
        { id: 42, weird: true },
        null
      ])
    })
    const refusal = await seam.loadRepositories()
    expect(refusal).toBeUndefined()

    expect(repos(store)).toEqual([
      expect.objectContaining({ id: "plue/plue", org: "plue", ownerKind: "org", name: "plue", head: null }),
      expect.objectContaining({ id: "will/scratch", org: "will", ownerKind: "user", head: null }),
      expect.objectContaining({
        id: "will/smithers",
        org: "will",
        ownerKind: "user",
        name: "smithers",
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      })
    ])
    // No mirror field exists anywhere on the row.
    expect(JSON.stringify(repos(store))).not.toContain("mirror")

    // Workspaces: both rows land; the one without a status carries no state.
    expect(copies(store)).toEqual([
      expect.objectContaining({
        id: "workspace:ws-1",
        repoId: "will/smithers",
        kind: "workspace",
        label: "review",
        workspaceId: "ws-1",
        state: "running"
      }),
      expect.objectContaining({
        id: "workspace:ws-2",
        repoId: "will/smithers",
        kind: "workspace",
        label: "broken-row",
        workspaceId: "ws-2"
      })
    ])

    // One bookmarks call per headed repo, asking a full page; none for the headless ones.
    expect(bookmarkCalls(requests).sort()).toEqual([
      "api/repos/plue/plue/bookmarks?limit=100",
      "api/repos/will/smithers/bookmarks?limit=100"
    ])
  })

  test("the default bookmark on a later page is found by following next_cursor", async () => {
    // The route sorts `landing/…` before `main`, so the base bookmark can sit past the first page.
    const paged = (path: string, query: URLSearchParams): Response => {
      if (path !== "api/repos/will/smithers/bookmarks") return backend(path)
      return query.get("cursor") === "page-2"
        ? json(200, BOOKMARK_WIRE.page([BOOKMARK_WIRE.row("main", "qupxosqw", "c0ffee1")]))
        : json(200, BOOKMARK_WIRE.page([BOOKMARK_WIRE.row("landing/one", "chg-l1", "aaa111")], "page-2"))
    }
    const { store, seam, requests } = await harness(paged, { workspaces: json(403, {}) })
    expect(await seam.loadRepositories()).toBeUndefined()
    expect(store.collections.repositories.get("will/smithers")?.head).toEqual({
      bookmark: "main",
      changeId: "qupxosqw",
      commitId: "c0ffee1"
    })
    expect(bookmarkCalls(requests).filter((call) => call.startsWith("api/repos/will/smithers/"))).toEqual([
      "api/repos/will/smithers/bookmarks?limit=100",
      "api/repos/will/smithers/bookmarks?limit=100&cursor=page-2"
    ])
  })

  test.each([false, true])("legacy bookmark arrays and workspace DTOs remain supported (named envelope: %s)", async (named) => {
    const { store, seam } = await harness((path) => {
      if (path !== "api/repos/will/smithers/bookmarks") return backend(path)
      const bookmarks = [BOOKMARK_WIRE.row("main", "qupxosqw", "c0ffee1")]
      return json(200, named ? { bookmarks } : bookmarks)
    }, {
      workspaces: json(200, [{ id: "ws-1", repo_full_name: "will/smithers", name: "review", status: "running" }])
    })
    expect(await seam.loadRepositories()).toBeUndefined()
    expect(store.collections.repositories.get("will/smithers")?.head).toEqual({ bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" })
    expect(copies(store)).toEqual([expect.objectContaining({
      id: "workspace:ws-1", repoId: "will/smithers", workspaceId: "ws-1", label: "review", state: "running"
    })])
  })

  test("a repeated cursor stops pagination and preserves a previously loaded head", async () => {
    const stuck = (path: string): Response =>
      path === "api/repos/will/smithers/bookmarks"
        ? json(200, BOOKMARK_WIRE.page([BOOKMARK_WIRE.row("landing/one", "chg-l1")], "stuck"))
        : backend(path)
    const { store, seam, requests } = await harness(stuck, { workspaces: json(403, {}) })
    const head = { bookmark: "main", changeId: "known-change", commitId: "known-commit" }
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head }]
    })
    expect(await seam.loadRepositories()).toBeUndefined()
    expect(store.collections.repositories.get("will/smithers")?.head).toEqual(head)
    // Page 1 without a cursor, page 2 with it, then the cursor did not advance: no third read.
    expect(bookmarkCalls(requests).filter((call) => call.startsWith("api/repos/will/smithers/"))).toHaveLength(2)
  })

  test("a reload over a loaded inventory keeps the same repo and copy identities", async () => {
    let reloaded = false
    const { store, seam } = await harness((path) => {
      if (path === "api/user/workspaces") return json(200, [
        { ...USER_WORKSPACE_ROW, state: reloaded ? "suspended" : "running" },
        { ...USER_WORKSPACE_ROW, workspace_id: "ws-2", workspace_title: "bench", state: "suspended" }
      ])
      if (reloaded && path === "api/repos/will/smithers/bookmarks") {
        return json(200, BOOKMARK_WIRE.page([BOOKMARK_WIRE.row("main", "next-change", "next-commit")]))
      }
      return backend(path)
    })
    await seam.loadRepositories()
    const before = { repos: repos(store).map((repo) => repo.id), copies: copies(store).map((copy) => copy.id) }
    reloaded = true
    await seam.loadRepositories()
    expect(repos(store).map((repo) => repo.id)).toEqual(before.repos)
    expect(copies(store).map((copy) => copy.id)).toEqual(before.copies)
    expect(before.copies).toEqual(["workspace:ws-1", "workspace:ws-2"])
    expect(store.collections.repositories.get("will/smithers")?.head).toEqual({ bookmark: "main", changeId: "next-change", commitId: "next-commit" })
    expect(copies(store).map((copy) => [copy.repoId, copy.label, copy.state])).toEqual([
      ["will/smithers", "review", "suspended"],
      ["will/smithers", "bench", "suspended"]
    ])
  })

  test("a 300-repo inventory never has more than 6 bookmarks reads in flight", async () => {
    const inventory = Array.from({ length: 300 }, (_, index) => ({
      owner: "org",
      name: `repo-${index}`,
      full_name: `org/repo-${index}`,
      default_bookmark: "main"
    }))
    let inFlight = 0
    let peak = 0
    const slow = async (path: string): Promise<Response> => {
      if (path === "api/user/repos") return json(200, inventory)
      if (path === "api/user/orgs") return json(200, [{ login: "org" }])
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return json(200, BOOKMARK_WIRE.page([BOOKMARK_WIRE.row("main", `chg-${path}`, "c0ffee1")]))
    }
    const { store, seam, requests } = await harness(slow, { workspaces: json(403, {}) })
    expect(await seam.loadRepositories()).toBeUndefined()
    expect(bookmarkCalls(requests)).toHaveLength(300)
    expect(peak).toBeLessThanOrEqual(6)
    expect(peak).toBeGreaterThan(1)
    expect(repos(store)).toHaveLength(300)
    expect(store.collections.repositories.get("org/repo-299")?.head).toEqual({
      bookmark: "main",
      changeId: "chg-api/repos/org/repo-299/bookmarks",
      commitId: "c0ffee1"
    })
    // 300 reads at concurrency 6 is 50 rounds of a real timer, so the wall clock here
    // tracks machine load. The claim under test is `peak`, not the duration.
  }, 30000)

  test("when the wire answered most heads, a row it left headless is not read again", async () => {
    const headed = (index: number) => ({
      owner: "will",
      name: `repo-${index}`,
      full_name: `will/repo-${index}`,
      default_bookmark: "main",
      owner_type: "User",
      default_bookmark_head: { change_id: `chg-${index}`, commit_id: `c-${index}` }
    })
    const mixed = (path: string): Response =>
      path === "api/user/repos"
        ? json(200, [headed(1), headed(2), { owner: "will", name: "bare", full_name: "will/bare", default_bookmark: "main" }])
        : path === "api/user/orgs"
        ? json(200, [])
        : json(200, BOOKMARK_WIRE.page([BOOKMARK_WIRE.row("main", "should-not-be-read")]))
    const { store, seam, requests } = await harness(mixed, { workspaces: json(403, {}) })
    expect(await seam.loadRepositories()).toBeUndefined()
    expect(bookmarkCalls(requests)).toEqual([])
    expect(store.collections.repositories.get("will/bare")?.head).toBeNull()
    expect(store.collections.repositories.get("will/repo-2")?.head).toEqual({ bookmark: "main", changeId: "chg-2", commitId: "c-2" })
  })

  test("a degraded token's 403 on workspaces answers an empty list, not an error", async () => {
    const { store, seam } = await harness(backend, {
      workspaces: json(403, { error: "insufficient token scope" })
    })
    const refusal = await seam.loadRepositories()
    expect(refusal).toBeUndefined()
    expect(repos(store)).toHaveLength(3)
    expect(copies(store)).toEqual([])
  })

  test("plue#445's wire fields replace the per-repo bookmarks call", async () => {
    const withHead = (path: string): Response =>
      path === "api/user/repos"
        ? json(200, [{
          owner: "will",
          name: "smithers",
          full_name: "will/smithers",
          default_bookmark: "main",
          owner_type: "User",
          default_bookmark_head: { change_id: "newchange", commit_id: "newcommit" }
        }])
        : path === "api/user/orgs"
        ? json(200, [])
        : json(404, {})
    const { store, seam, requests } = await harness(withHead, { workspaces: json(403, {}) })
    const refusal = await seam.loadRepositories()
    expect(refusal).toBeUndefined()
    expect(repos(store)).toEqual([
      expect.objectContaining({
        id: "will/smithers",
        ownerKind: "user",
        head: { bookmark: "main", changeId: "newchange", commitId: "newcommit" }
      })
    ])
    expect(requests.filter((request) => request.includes("/bookmarks"))).toEqual([])
  })

  test("the bookmarks list reads plue's cursor envelope, not only a bare array", async () => {
    // plue answers `{ items, next_cursor }` here (routes/jj_vcs.go ListBookmarks
    // through routes/pagination.go cursorResponse), so a head read out of the
    // envelope is the deployed protocol, not a variant.
    const enveloped = (path: string): Response =>
      path === "api/user/repos"
        ? json(200, [{ owner: "will", name: "smithers", full_name: "will/smithers", default_bookmark: "main" }])
        : path === "api/user/orgs"
        ? json(200, [])
        : path === "api/repos/will/smithers/bookmarks"
        ? json(200, {
          items: [{ name: "main", target_change_id: "qupxosqw", target_commit_id: "c0ffee1", is_tracking_remote: false }],
          next_cursor: ""
        })
        : json(404, {})
    const { store, seam } = await harness(enveloped, { workspaces: json(403, {}) })
    const refusal = await seam.loadRepositories()
    expect(refusal).toBeUndefined()
    expect(repos(store)).toEqual([
      expect.objectContaining({
        id: "will/smithers",
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      })
    ])
  })

  test("a failed repos read is an honest error and dispatches nothing", async () => {
    const { store, seam } = await harness(() => json(401, { message: "bad credentials" }))
    const refusal = await seam.loadRepositories()
    expect(refusal).toBe("bad credentials")
    expect(repos(store)).toEqual([])
  })

  test("a kept head survives a later answer that carries none", async () => {
    const { store, seam } = await harness(backend, { workspaces: json(403, {}) })
    await seam.loadRepositories()
    // A second load where the bookmarks call now fails: the head stays.
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null }]
    })
    expect(store.collections.repositories.get("will/smithers")?.head).toEqual({
      bookmark: "main",
      changeId: "qupxosqw",
      commitId: "c0ffee1"
    })
  })
})
