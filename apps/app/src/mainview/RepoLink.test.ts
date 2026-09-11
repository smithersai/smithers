import { describe, expect, test } from "bun:test"
import {
  catalogRepository,
  openRequestedRepo,
  paramRepo,
  pathRepo,
  requestedRepo,
  signInReturnTo,
  withoutRepoParam
} from "./RepoLink"
import { createAppStore } from "./state/AppStore"
import { createTabsController } from "./state/controller/tabs"
import type { ControllerContext } from "./state/controller/context"

/*
 * A repository's app lives at `/owner/name`; the landing page's older "Open in
 * Smithers" link lands on `/?repo=owner/name`. The visitor should arrive with
 * that repository already selected, and only when the public catalog carries
 * it: the URL is anyone's to type.
 */

const SUMMARY = "Smithers is a durable framework that lets agents plan, run, and review changes to a code repository through flows."

const catalog = {
  repos: [
    { name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", summary: SUMMARY, stats: null }
  ]
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fixture = async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({
    kind: "localStorage",
    storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key)
    }
  })
  const tabs = createTabsController({
    store,
    services: {},
    commandActor: "user",
    repositories: { available: false }
  } as unknown as ControllerContext)
  const ran: Array<string> = []
  return {
    store,
    ran,
    controller: {
      store,
      selectRepo: tabs.selectRepo,
      runCommand: (name: string, args?: string) => {
        ran.push(args === undefined ? name : `${name} ${args}`)
        return true
      }
    }
  }
}

describe("paramRepo", () => {
  test("reads an owner/name from the repo parameter", () => {
    expect(paramRepo("?repo=smithersai/smithers")).toBe("smithersai/smithers")
    expect(paramRepo("?auth=failed&repo=smithersai/smithers")).toBe("smithersai/smithers")
  })

  test("ignores an absent, empty, or malformed value", () => {
    expect(paramRepo("")).toBeNull()
    expect(paramRepo("?repo=")).toBeNull()
    expect(paramRepo("?repo=smithers")).toBeNull()
    expect(paramRepo("?repo=../../etc")).toBeNull()
    expect(paramRepo("?repo=https://github.com/smithersai/smithers")).toBeNull()
  })
})

describe("pathRepo", () => {
  test("reads an owner/name from a two-segment path", () => {
    expect(pathRepo("/smithersai/smithers")).toBe("smithersai/smithers")
    expect(pathRepo("/SmithersAI/smithers.js")).toBe("SmithersAI/smithers.js")
  })

  test("a trailing slash names the same repository", () => {
    // A prerendered /owner/name/index.html is served at /owner/name/ too.
    expect(pathRepo("/smithersai/smithers/")).toBe("smithersai/smithers")
    expect(requestedRepo({ pathname: "/smithersai/smithers/", search: "" })).toBe("smithersai/smithers")
  })

  test("answers null for the root, one segment, an empty segment, or deeper paths", () => {
    expect(pathRepo("/")).toBeNull()
    expect(pathRepo("")).toBeNull()
    expect(pathRepo("/smithersai")).toBeNull()
    expect(pathRepo("/smithersai/")).toBeNull()
    expect(pathRepo("/smithersai//")).toBeNull()
    expect(pathRepo("/smithersai/smithers//")).toBeNull()
    expect(pathRepo("/smithersai/smithers/issues")).toBeNull()
    expect(pathRepo("/w/ws-1/b/main/f/frame-1")).toBeNull()
    expect(pathRepo("/a%20b/c")).toBeNull()
  })
})

describe("requestedRepo", () => {
  test("the path names the repository", () => {
    expect(requestedRepo({ pathname: "/smithersai/smithers", search: "" })).toBe("smithersai/smithers")
  })

  test("the path wins over the repo parameter", () => {
    expect(requestedRepo({ pathname: "/smithersai/smithers", search: "?repo=someone/else" })).toBe("smithersai/smithers")
  })

  test("the repo parameter is read at the root only", () => {
    expect(requestedRepo({ pathname: "/", search: "?repo=smithersai/smithers" })).toBe("smithersai/smithers")
    expect(requestedRepo({ pathname: "/w/ws-1/b/main/f/frame-1", search: "?repo=smithersai/smithers" })).toBeNull()
    expect(requestedRepo({ pathname: "/smithersai", search: "?repo=smithersai/smithers" })).toBeNull()
  })

  test("nothing is requested at the root without the parameter", () => {
    expect(requestedRepo({ pathname: "/", search: "" })).toBeNull()
    expect(requestedRepo({ pathname: "/", search: "?auth=failed" })).toBeNull()
  })
})

describe("catalogRepository", () => {
  test("matches the catalog spelling case-insensitively", () => {
    expect(catalogRepository(catalog, "SmithersAI/Smithers")).toEqual({
      id: "smithersai/smithers",
      org: "smithersai",
      name: "smithers",
      summary: SUMMARY
    })
  })

  test("a catalog without the curated sentence yields a row without one, never a made-up sentence", () => {
    const bare = { repos: [{ name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", stats: null }] }
    expect(catalogRepository(bare, "smithersai/smithers")).toEqual({ id: "smithersai/smithers", org: "smithersai", name: "smithers" })
    const blank = { repos: [{ ...catalog.repos[0], summary: "   " }] }
    expect(catalogRepository(blank, "smithersai/smithers")?.summary).toBeUndefined()
  })

  test("answers null for a name outside the catalog or a malformed catalog", () => {
    expect(catalogRepository(catalog, "someone/else")).toBeNull()
    expect(catalogRepository({ repos: "nope" }, "smithersai/smithers")).toBeNull()
    expect(catalogRepository(null, "smithersai/smithers")).toBeNull()
  })
})

describe("withoutRepoParam", () => {
  test("drops only the repo parameter and keeps the rest of the location", () => {
    expect(withoutRepoParam({ pathname: "/", search: "?repo=smithersai/smithers", hash: "" })).toBe("/")
    expect(withoutRepoParam({ pathname: "/app", search: "?tab=main&repo=a/b", hash: "#top" })).toBe("/app?tab=main#top")
  })

  test("keeps the repository path in the address bar", () => {
    expect(withoutRepoParam({ pathname: "/smithersai/smithers", search: "", hash: "" })).toBe("/smithersai/smithers")
    expect(withoutRepoParam({ pathname: "/smithersai/smithers", search: "?repo=someone/else", hash: "" })).toBe(
      "/smithersai/smithers"
    )
  })
})

/*
 * A sign-in that starts on a repository page comes back to it: the page is
 * the return path the start route carries. The landing page needs none (the
 * callback lands there on its own), and a spent auth marker never replays.
 */
describe("signInReturnTo", () => {
  test("a repository page returns to itself, query included", () => {
    expect(signInReturnTo({ pathname: "/smithersai/smithers", search: "" })).toBe("/smithersai/smithers")
    expect(signInReturnTo({ pathname: "/smithersai/smithers/", search: "?tab=issues" })).toBe(
      "/smithersai/smithers/?tab=issues"
    )
  })

  test("spent auth markers never replay", () => {
    expect(signInReturnTo({ pathname: "/smithersai/smithers", search: "?signed-in=github" })).toBe("/smithersai/smithers")
    expect(signInReturnTo({ pathname: "/smithersai/smithers", search: "?auth=failed&tab=issues" })).toBe(
      "/smithersai/smithers?tab=issues"
    )
  })

  test("the landing page and non-repository paths carry no return path", () => {
    expect(signInReturnTo({ pathname: "/", search: "" })).toBeNull()
    expect(signInReturnTo({ pathname: "/", search: "?repo=smithersai/smithers" })).toBeNull()
    expect(signInReturnTo({ pathname: "/smithersai", search: "" })).toBeNull()
    expect(signInReturnTo({ pathname: "/a/b/c", search: "" })).toBeNull()
  })

  test("a query the server would drop is left behind rather than losing the page", () => {
    expect(signInReturnTo({ pathname: "/smithersai/smithers", search: `?q=${"x".repeat(600)}` })).toBe(
      "/smithersai/smithers"
    )
  })
})

describe("openRequestedRepo", () => {
  test("a catalog repository becomes the active selection, and the welcome opens the transcript", async () => {
    const { store, controller, ran } = await fixture()
    const requests: Array<string> = []
    const http = async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return jsonResponse(catalog)
    }
    expect(await openRequestedRepo(controller, http, "SmithersAI/Smithers")).toBeUndefined()
    // The catalog, then the mirror's repository document for the shared copy's bookmark.
    expect(requests).toEqual(["/api/public/repos", "/api/repos/smithersai/smithers"])
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
    expect(store.collections.repositories.get("smithersai/smithers")).toMatchObject({
      org: "smithersai",
      name: "smithers",
      head: null,
      // Provenance: the row is readable signed out, and the chat opens on it.
      catalog: true,
      // The curated sentence the welcome reads (controller/onboarding.ts).
      summary: SUMMARY
    })
    // The welcome, then the shared read-only copy's root opens (the caret's own act), once per launch.
    expect(ran).toEqual(["repo.welcome", "repo.tree shared:smithersai/smithers"])
  })

  /*
   * The shared read-only copy (WorkspaceViews.ts) is the signed-out visitor's
   * one tab: its root opens on the first paint, and its bookmark is the
   * mirror's default bookmark (`GET /api/repos/{o}/{r}`, a public read the
   * Worker forwards signed out), never a name the catalog did not carry.
   */
  test("the shared copy opens its root once and names the mirror's default bookmark; a reload with the tree already open runs nothing twice", async () => {
    const { store, controller, ran } = await fixture()
    const requests: Array<string> = []
    const http = async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return String(input) === "/api/repos/smithersai/smithers" ? jsonResponse({ default_bookmark: "main" }) : jsonResponse(catalog)
    }
    expect(await openRequestedRepo(controller, http, "smithersai/smithers")).toBeUndefined()
    expect(requests).toEqual(["/api/public/repos", "/api/repos/smithersai/smithers"])
    expect(store.collections.repositories.get("smithersai/smithers")?.head).toEqual({ bookmark: "main", changeId: null, commitId: null })
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toMatchObject({ kind: "shared", access: "read", bookmark: "main" })
    expect(ran).toEqual(["repo.welcome", "repo.tree shared:smithersai/smithers"])
    // The tree row stands for this launch: the reload leaves the caret's state alone.
    store.dispatch({ type: "repo-tree.loaded", actor: "system", copyId: "shared:smithersai/smithers", path: "", entries: [], truncated: false })
    expect(await openRequestedRepo(controller, http, "smithersai/smithers")).toBeUndefined()
    expect(ran.filter((name) => name.startsWith("repo.tree"))).toEqual(["repo.tree shared:smithersai/smithers"])
  })

  test("a mirror that answers no bookmark leaves the row's head alone: nothing invented", async () => {
    const { store, controller } = await fixture()
    const http = async (input: RequestInfo | URL) =>
      String(input) === "/api/repos/smithersai/smithers" ? jsonResponse({ message: "unavailable" }, 502) : jsonResponse(catalog)
    expect(await openRequestedRepo(controller, http, "smithersai/smithers")).toBeUndefined()
    expect(store.collections.repositories.get("smithersai/smithers")?.head).toBeNull()
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")?.bookmark).toBeUndefined()
  })

  test("a reload that finds the welcome already in the transcript does not repeat it", async () => {
    const { store, controller, ran } = await fixture()
    store.dispatch({
      type: "card.upsert",
      actor: "user",
      card: {
        id: "repo-welcome-smithersai/smithers",
        kind: "repo-onboarding",
        title: "Welcome · smithersai/smithers",
        status: "active",
        createdAt: 1,
        ordinal: 0,
        payload: { stage: "welcome", repo: "smithersai/smithers", summary: null }
      }
    })
    expect(await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")).toBeUndefined()
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
    // No second welcome; the shared copy's tree opens, because tree rows never survive a relaunch.
    expect(ran).toEqual(["repo.tree shared:smithersai/smithers"])
  })

  test("a name outside the catalog is refused and selects nothing", async () => {
    const { store, controller, ran } = await fixture()
    const refusal = await openRequestedRepo(controller, async () => jsonResponse(catalog), "someone/else")
    expect(refusal).toBe("someone/else is not in the public repository catalog.")
    expect(store.session().activeRepoKey ?? null).toBeNull()
    expect(store.collections.repositories.size).toBe(0)
    expect(ran).toEqual([])
  })

  test("an unreachable catalog is a refusal, not a selection", async () => {
    const { store, controller } = await fixture()
    expect(await openRequestedRepo(controller, async () => jsonResponse({}, 503), "smithersai/smithers")).toMatch(/HTTP 503/)
    expect(await openRequestedRepo(controller, async () => { throw new Error("offline") }, "smithersai/smithers")).toMatch(/offline/)
    expect(store.session().activeRepoKey ?? null).toBeNull()
  })

  /*
   * Opening one repository is a fact about that one row. The cloud inventory
   * beside it is left exactly as it was: a whole-list replace would rewrite
   * every row (and silently drop any field the caller's projection forgot).
   */
  test("the catalog row is upserted alone: every inventory row beside it is untouched", async () => {
    const { store, controller } = await fixture()
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        {
          id: "acme/widgets",
          org: "acme",
          ownerKind: "org",
          name: "widgets",
          head: { bookmark: "trunk", changeId: "zzz", commitId: "abc" },
          summary: "The widgets."
        }
      ]
    })
    const before = structuredClone(store.collections.repositories.get("acme/widgets"))
    const http = async (input: RequestInfo | URL) =>
      String(input) === "/api/repos/smithersai/smithers" ? jsonResponse({ default_bookmark: "main" }) : jsonResponse(catalog)
    expect(await openRequestedRepo(controller, http, "smithersai/smithers")).toBeUndefined()
    // Neither the catalog row's insert nor the mirror bookmark's landing touches it.
    expect(structuredClone(store.collections.repositories.get("acme/widgets"))).toEqual(before)
    expect(store.collections.repositories.get("smithersai/smithers")).toMatchObject({
      org: "smithersai",
      name: "smithers",
      catalog: true,
      summary: SUMMARY,
      head: { bookmark: "main", changeId: null, commitId: null }
    })
  })

  test("the cloud inventory already loaded stays beside the catalog row", async () => {
    const { store, controller } = await fixture()
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "acme/widgets", org: "acme", ownerKind: "org", name: "widgets", head: null }]
    })
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
    expect([...store.collections.repositories.keys()].sort()).toEqual(["acme/widgets", "smithersai/smithers"])
    expect(store.collections.repositories.get("acme/widgets")?.ownerKind).toBe("org")
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
  })
})
