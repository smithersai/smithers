import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Repo } from "@smthrs/rpc/LocalApp"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { scopedControllers } from "../ControllerTestScope"
import { trackDispatchCommits } from "../StoreTestScope"
import type { AppServices } from "../AppController"
import { repoKeyOf, repoTreeRowId } from "../AppState"
import { createAppStore } from "../AppStore"

const createAppController = scopedControllers()

/*
 * The sidebar's file tree seam (RepoTreeSeam.ts) through the real command
 * path: /repo.tree <copyId>[#path] posts the SAME request the files flows
 * post (`POST /api/repo/files { repoId, path }`, the route contract in
 * @smthrs/rpc/LocalApp) and writes the app-repo-tree row for that
 * directory: loaded with exactly the entries the route answered, or failed
 * with the route's error text verbatim. Toggling is collection state, never
 * a second request; the rows never survive a relaunch.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const localRepo = (id: string, name: string, path: string): Repo => ({
  id,
  path,
  name,
  git: { branch: "main", remote: `git@github.com:${name}.git` },
  warnings: [],
  smithers: { detected: true, workspaceFile: "WORKSPACE.ts", declarationFiles: [], reason: "1 workspace detected", workspaces: [{ path: ".", title: name }] }
})
const SMITHERS = localRepo("repo-smithers", "smithersai/smithers", "/Users/will/smithers")
const COPY = repoKeyOf(SMITHERS.path)

/*
 * The local app double, answering the route's own shapes: the root (dirs
 * first, a `.git` entry like any other), an empty directory, a truncated one,
 * a file, and two refusals in the route's error envelope.
 */
/*
 * The Worker's forward of a box's files route
 * (`GET /api/repos/{o}/{r}/workspaces/{id}/files?path=`, the same route the
 * Files facet reads), keyed by the path plue is asked for. Entries are plue's
 * WorkspaceFileEntry rows (`type` is `dir` or `file`); `ws-refused` is the
 * Worker's own 401 body, `ws-broken` plue's 409 for a box that stopped
 * between the inventory read and the click.
 */
const BOX_FILES = "/api/cloud/api/repos/will/flows/workspaces/ws-1/files"
const boxAnswers: Record<string, () => Response> = {
  "": () =>
    json(200, {
      path: "",
      entries: [
        { name: "apps", path: "apps", type: "dir", size: 0 },
        { name: "README.md", path: "README.md", type: "file", size: 12 },
        { name: "", path: "", type: "file", size: 0 },
        { name: "link", path: "link", type: "symlink", size: 0 }
      ]
    }),
  "apps": () => json(200, { path: "apps", entries: [{ name: "ui", path: "apps/ui", type: "dir", size: 0 }] }),
  "apps/ui": () => json(200, { path: "apps/ui", entries: [] }),
  "locked": () => json(409, { status: "error", message: "workspace ws-1 is not running" })
}

/*
 * The public contents route of the mirror
 * (`GET /api/repos/{o}/{r}/contents[/path]`, the read the files flows make,
 * allowlisted signed out by apps/server publicRepositoryReads.ts): a JSON
 * array of `{ name, path, type }` rows for a directory, a record with
 * `content`/`encoding` for a file, the mirror's message on a refusal.
 */
const SHARED_CONTENTS = "/api/repos/smithersai/smithers/contents"
const sharedAnswers: Record<string, () => Response> = {
  /*
   * The mirror answers a git tree's own byte order: uppercase before
   * lowercase, so `CHANGELOG.md` precedes `Cargo.lock` and the directories
   * sit wherever their names fall. The row the seam writes is in the
   * sidebar's one order instead.
   */
  "": () =>
    json(200, [
      { name: "CHANGELOG.md", path: "CHANGELOG.md", type: "file", sha: "", size: 0 },
      { name: "Cargo.lock", path: "Cargo.lock", type: "file", sha: "", size: 0 },
      { name: "PACKAGE.ts", path: "PACKAGE.ts", type: "file", sha: "", size: 0 },
      { name: "README.md", path: "README.md", type: "file", sha: "", size: 0 },
      { name: "apps", path: "apps", type: "dir", sha: "", size: 0 },
      { type: "file" }
    ]),
  "apps": () => json(200, [{ name: "ui", path: "apps/ui", type: "dir", sha: "", size: 0 }]),
  "apps/ui": () => json(200, []),
  "README.md": () => json(200, { name: "README.md", path: "README.md", type: "file", encoding: "base64", content: "IyBIaQo=", size: 5 }),
  "boom": () => json(500, { message: "the mirror is resyncing smithersai/smithers" })
}

const treeBackend = () => {
  const requests: Array<{ readonly repoId?: string; readonly path?: string }> = []
  /** Every box listing asked for, as `<workspaces path>?<query>`. */
  const boxRequests: Array<string> = []
  /** Every mirror contents read asked for, as its path. */
  const sharedRequests: Array<string> = []
  const answers: Record<string, () => Response> = {
    "": () =>
      json(200, {
        kind: "dir",
        path: "",
        entries: [{ name: ".git", kind: "dir" }, { name: "packages", kind: "dir" }, { name: "README.md", kind: "file" }, { name: "zeta.txt", kind: "file" }]
      }),
    "packages": () => json(200, { kind: "dir", path: "packages", entries: [{ name: "ui", kind: "dir" }, { name: "PACKAGE.ts", kind: "file" }] }),
    "packages/smithers/ui": () => json(200, { kind: "dir", path: "packages/smithers/ui", entries: [] }),
    ".git": () => json(200, { kind: "dir", path: ".git", entries: [{ name: "HEAD", kind: "file" }], truncated: true }),
    "README.md": () => json(200, { kind: "file", path: "README.md", size: 14, content: "# Local — hi\n", truncated: false, binary: false }),
    "secret": () => json(403, { error: { code: "path_outside_repository", message: "secret points outside the repository." } }),
    "boom": () => json(500, { error: { code: "read_failed", message: "Could not list boom." } })
  }
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const parsed = new URL(url, "http://local.test")
      const path = parsed.pathname
      if (path === SHARED_CONTENTS || path.startsWith(`${SHARED_CONTENTS}/`)) {
        // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes; not this seam's read.
        if (!path.endsWith("/contents/.smithers/factory.json")) sharedRequests.push(path)
        const at = decodeURIComponent(path.slice(SHARED_CONTENTS.length).replace(/^\//, ""))
        const answer = sharedAnswers[at]
        return answer === undefined ? json(404, { message: `smithersai/smithers has no ${at}` }) : answer()
      }
      if (path.startsWith("/api/cloud/api/repos/")) {
        boxRequests.push(`${path.slice("/api/cloud/api".length)}${parsed.search}`)
        if (path !== BOX_FILES) return json(401, { status: "error", message: "Sign in to run a Smithers turn." })
        const answer = boxAnswers[parsed.searchParams.get("path") ?? ""]
        return answer === undefined ? json(404, { status: "error", message: `no such path in ws-1: ${parsed.searchParams.get("path")}` }) : answer()
      }
      if (path !== "/api/repo/files") return json(404, { status: "error", message: `no stub for ${url}` })
      const body = JSON.parse(String(init?.body ?? "{}")) as { repoId?: string; path?: string }
      requests.push(body)
      const answer = answers[body.path ?? ""]
      return answer === undefined
        ? json(404, { error: { code: "path_not_found", message: `Path not found: ${body.path}` } })
        : answer()
    }
  }
  return { services, requests, boxRequests, sharedRequests }
}

const treeController = async (repos: ReadonlyArray<Repo> = [SMITHERS]) => {
  const backend = treeBackend()
  const storage = memoryStorage()
  const { store, settle } = trackDispatchCommits(await createAppStore({ kind: "localStorage", storage }))
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    ...backend.services,
    bootstrap: {
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "test",
      capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    }
  })
  await store.dispatch({ type: "repos.loaded", actor: "system", repos: [...repos] }).isPersisted.promise
  return { store, controller, storage, requests: backend.requests, boxRequests: backend.boxRequests, sharedRequests: backend.sharedRequests, settle }
}

/** A cloud workspace copy (a box) as the inventory view writes it; `state` is plue's status verbatim. */
const boxCopy = (id: string, state: string, repoId = "will/flows") => ({
  id,
  repoId,
  kind: "workspace" as const,
  label: "fix-landings",
  workspaceId: id,
  state
})

describe("repo tree seam — one directory per request, the route's answer verbatim", () => {
  test("/repo.tree <copyId> lists the root through POST /api/repo/files and writes the loaded row, nothing filtered", async () => {
    const { store, controller, requests } = await treeController()
    const outcome = await controller.commands.run("repo.tree", COPY)
    expect(outcome.status).toBe("executed")
    expect(requests).toEqual([{ repoId: "repo-smithers", path: "" }])
    const root = store.collections.repoTree.get(repoTreeRowId(COPY, ""))
    expect(root).toMatchObject({
      copyId: COPY,
      path: "",
      expanded: true,
      state: "loaded",
      entries: [{ name: ".git", kind: "dir" }, { name: "packages", kind: "dir" }, { name: "README.md", kind: "file" }, { name: "zeta.txt", kind: "file" }]
    })
    expect(root?.truncated).toBeUndefined()
    expect(root?.error).toBeUndefined()
  })

  test("a nested path rides the `#` grammar; a second toggle collapses without a request, a third expands without one", async () => {
    const { store, controller, requests } = await treeController()
    expect((await controller.commands.run("repo.tree", `${COPY}#packages`)).status).toBe("executed")
    expect(requests).toEqual([{ repoId: "repo-smithers", path: "packages" }])
    const id = repoTreeRowId(COPY, "packages")
    expect(store.collections.repoTree.get(id)?.entries).toEqual([{ name: "ui", kind: "dir" }, { name: "PACKAGE.ts", kind: "file" }])
    expect((await controller.commands.run("repo.tree", `${COPY}#packages`)).status).toBe("executed")
    expect(store.collections.repoTree.get(id)?.expanded).toBe(false)
    expect((await controller.commands.run("repo.tree", `${COPY}#packages/`)).status).toBe("executed")
    expect(store.collections.repoTree.get(id)?.expanded).toBe(true)
    expect(requests).toHaveLength(1)
    // An empty directory is a loaded row with no entries — the tree says "empty", never invents a child.
    expect((await controller.commands.run("repo.tree", `${COPY}#packages/smithers/ui`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "packages/smithers/ui"))).toMatchObject({ state: "loaded", entries: [] })
  })

  test("a capped listing keeps the route's truncated flag", async () => {
    const { store, controller } = await treeController()
    expect((await controller.commands.run("repo.tree", `${COPY}#.git`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, ".git"))).toMatchObject({ state: "loaded", truncated: true, entries: [{ name: "HEAD", kind: "file" }] })
  })

  test("a refusal writes the failed row with the server's message verbatim, and the next toggle retries", async () => {
    const { store, controller, requests } = await treeController()
    expect((await controller.commands.run("repo.tree", `${COPY}#secret`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "secret"))).toMatchObject({
      state: "failed",
      expanded: true,
      entries: [],
      error: "secret points outside the repository."
    })
    expect((await controller.commands.run("repo.tree", `${COPY}#boom`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "boom"))?.error).toBe("Could not list boom.")
    expect((await controller.commands.run("repo.tree", `${COPY}#missing`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "missing"))?.error).toBe("Path not found: missing")
    // A file behind a caret cannot happen from the tree, but the row still says so honestly.
    expect((await controller.commands.run("repo.tree", `${COPY}#README.md`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "README.md"))?.error).toBe("README.md in smithersai/smithers is a file — run /files.read README.md instead")
    // A failed row collapses like any other; expanding it again is the retry.
    const before = requests.length
    expect((await controller.commands.run("repo.tree", `${COPY}#boom`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "boom"))?.expanded).toBe(false)
    expect(requests.length).toBe(before)
    expect((await controller.commands.run("repo.tree", `${COPY}#boom`)).status).toBe("executed")
    expect(requests.length).toBe(before + 1)
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "boom"))).toMatchObject({ expanded: true, state: "failed", error: "Could not list boom." })
  })

  test("a copy that is not open on this machine, or not a checkout, fails in place; an unknown copy is a refusal", async () => {
    const { store, controller, requests } = await treeController()
    const other = repoKeyOf("/Users/will/plue")
    await store.dispatch({
      type: "repo.pinned",
      actor: "user",
      pin: { id: other, name: "plue", path: "/Users/will/plue", branch: "main", origin: "local", pinnedAt: 1 }
    }).isPersisted.promise
    expect((await controller.commands.run("repo.tree", other)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(other, ""))).toMatchObject({
      state: "failed",
      error: "plue is pinned but not open on this machine — open it with /repo.open, then retry."
    })
    expect(requests).toHaveLength(0)
    const unknown = await controller.commands.run("repo.tree", "local:/nowhere")
    expect(unknown.status).toBe("failed")
    expect(JSON.stringify(unknown)).toContain("There is no working copy with id local:/nowhere.")
    // A blank line lacks the copy id: the form asks for it (THE FORM LAW), nothing is refused.
    const blank = await controller.commands.run("repo.tree", "")
    expect(blank).toEqual({ status: "form", flow: "repo.tree", cardId: "form-repo.tree", fields: ["copy"] })
  })

  test("the rows are collection state for this launch only: a store reopened over the same storage starts collapsed", async () => {
    const { store, controller, storage, settle } = await treeController()
    expect((await controller.commands.run("repo.tree", COPY)).status).toBe("executed")
    expect(store.collections.repoTree.size).toBe(1)
    expect([...store.collections.repoTree.values()][0]?.expanded).toBe(true)
    await controller.dispose()
    await settle()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.repoTree.size).toBe(0)
    // Nothing under the tree's id ever reached the shared storage.
    expect(storage.getItem("smithers-mvp.app-repo-tree")).toBeNull()
  })

  test("unpinning a checkout forgets its tree rows", async () => {
    const { store, controller } = await treeController()
    expect((await controller.commands.run("repo.tree", COPY)).status).toBe("executed")
    expect((await controller.commands.run("repo.tree", `${COPY}#packages`)).status).toBe("executed")
    expect(store.collections.repoTree.size).toBe(2)
    expect((await controller.commands.run("repo.unpin", COPY)).status).toBe("executed")
    expect(store.collections.repoTree.size).toBe(0)
  })

  /*
   * The guard belongs to the seam, not to one route: every copy kind refuses
   * a path that leaves the repository before it spends that path on a URL
   * or a request body (FilesSeam.unsafePath, the wording the files flows
   * answer with).
   */
  test("a path that leaves the repository fails the row in place, and the local app is never posted", async () => {
    const { store, controller, requests } = await treeController()
    expect((await controller.commands.run("repo.tree", `${COPY}#../../../../user/secrets`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "../../../../user/secrets"))).toMatchObject({
      state: "failed",
      expanded: true,
      entries: [],
      error: "File paths must stay inside the repository."
    })
    expect(requests).toEqual([])
  })

  test("repo.tree is one flow with three doors: the caret, the slash, and the agent (the three-door law); the agent reads contents with files.list", async () => {
    const { controller } = await treeController()
    const catalog = controller.commands.all().find((command) => command.name === "repo.tree")
    expect(catalog?.hidden).toBeUndefined()
    expect(catalog?.confirm).toBeUndefined()
    expect(controller.commands.find("repo.tree")?.binding.descriptor.modelInvocable).toBe(true)
  })
})

/*
 * A cloud workspace copy (a box, docs/workbench-lanes/sidebar-tree.md) lists
 * through the route its Files facet reads, forwarded by the Worker with the
 * visitor's own session: `GET /api/repos/{o}/{r}/workspaces/{id}/files?path=`.
 * The row holds plue's entries mapped to the tree's `{ name, kind }`, or the
 * refusal verbatim. A box the inventory shows as anything but running is
 * refused in place with its state sentence and no request: nothing invented.
 */
describe("repo tree seam: a cloud workspace copy reads the box's files route", () => {
  const loadBox = async (copies: ReadonlyArray<ReturnType<typeof boxCopy>>) => {
    const scope = await treeController([])
    await scope.store.dispatch({ type: "workingcopies.workspaces.loaded", actor: "system", copies: [...copies] }).isPersisted.promise
    return scope
  }

  test("/repo.tree <boxCopy> lists the box's root through GET .../workspaces/{id}/files?path= and maps plue's entries to the tree's rows", async () => {
    const { store, controller, requests, boxRequests } = await loadBox([boxCopy("ws-1", "running")])
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(boxRequests).toEqual(["/repos/will/flows/workspaces/ws-1/files?path="])
    // The local route is never asked for a box.
    expect(requests).toEqual([])
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))).toMatchObject({
      copyId: "ws-1",
      path: "",
      expanded: true,
      state: "loaded",
      // `dir` is a directory, anything else plue names is a file; a row without a name drops.
      // The sidebar's order, not the route's: directories first, then by name.
      entries: [{ name: "apps", kind: "dir" }, { name: "link", kind: "file" }, { name: "README.md", kind: "file" }]
    })
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))?.error).toBeUndefined()
    // A nested directory is one more request with its path; an empty one is a loaded row with no entries.
    expect((await controller.commands.run("repo.tree", "ws-1#apps")).status).toBe("executed")
    expect(boxRequests[1]).toBe("/repos/will/flows/workspaces/ws-1/files?path=apps")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "apps"))?.entries).toEqual([{ name: "ui", kind: "dir" }])
    expect((await controller.commands.run("repo.tree", "ws-1#apps/ui/")).status).toBe("executed")
    expect(boxRequests[2]).toBe("/repos/will/flows/workspaces/ws-1/files?path=apps%2Fui")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "apps/ui"))).toMatchObject({ state: "loaded", entries: [] })
    // Collapsing is collection state: no request.
    expect((await controller.commands.run("repo.tree", "ws-1#apps")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "apps"))?.expanded).toBe(false)
    expect(boxRequests).toHaveLength(3)
  })

  test("a box that is not running fails the row with its state sentence and asks the route nothing", async () => {
    const { store, controller, boxRequests } = await loadBox([
      boxCopy("ws-1", "starting"),
      boxCopy("ws-2", "suspended"),
      boxCopy("ws-3", "pending"),
      boxCopy("ws-4", "failed")
    ])
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))).toMatchObject({
      state: "failed",
      expanded: true,
      entries: [],
      error: "fix-landings (ws-1) is starting, not running; wait for it to settle (the workspace card tracks it)."
    })
    expect((await controller.commands.run("repo.tree", "ws-2#apps")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-2", "apps"))?.error).toBe("fix-landings (ws-2) is suspended, not running; /workspace.resume it first.")
    expect((await controller.commands.run("repo.tree", "ws-3")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-3", ""))?.error).toBe("fix-landings (ws-3) is pending, not running; wait for it to settle (the workspace card tracks it).")
    // A failed box never settles and cannot be resumed: no invented remedy, the card carries plue's failure_message.
    expect((await controller.commands.run("repo.tree", "ws-4")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-4", ""))).toMatchObject({
      state: "failed",
      expanded: true,
      entries: [],
      error: "fix-landings (ws-4) is failed; the workspace card names why."
    })
    expect(boxRequests).toEqual([])
    // The box settles: the inventory refresh rewrites the copy, and the next toggle is the retry that lists it.
    await store.dispatch({ type: "workingcopies.workspaces.loaded", actor: "system", copies: [boxCopy("ws-1", "running")] }).isPersisted.promise
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))?.expanded).toBe(false)
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(boxRequests).toEqual(["/repos/will/flows/workspaces/ws-1/files?path="])
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))).toMatchObject({ state: "loaded", entries: [{ name: "apps", kind: "dir" }, { name: "link", kind: "file" }, { name: "README.md", kind: "file" }] })
  })

  test("a refusal from the Worker or plue writes the failed row with the message verbatim", async () => {
    const { store, controller } = await loadBox([boxCopy("ws-1", "running"), boxCopy("ws-9", "running")])
    // plue's 409 for a box that stopped between the inventory read and the click.
    expect((await controller.commands.run("repo.tree", "ws-1#locked")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "locked"))).toMatchObject({ state: "failed", error: "workspace ws-1 is not running" })
    expect((await controller.commands.run("repo.tree", "ws-1#missing")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "missing"))?.error).toBe("no such path in ws-1: missing")
    // The Worker's own refusal (a signed-out page) reaches the row in the Worker's words.
    expect((await controller.commands.run("repo.tree", "ws-9")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-9", ""))).toMatchObject({ state: "failed", error: "Sign in to run a Smithers turn." })
  })
})

/*
 * The shared read-only copy of a public repository (WorkspaceViews.ts): the
 * one virtual box every reader shares over the mirror. No VM and no
 * terminal, so its listing is the mirror's contents route, the same public
 * read the files flows make; the local route and the box route are never
 * asked for it.
 */
describe("repo tree seam: the shared read-only copy reads the mirror's contents route", () => {
  const SHARED = "shared:smithersai/smithers"
  const loadShared = async () => {
    const scope = await treeController([])
    await scope.store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: { bookmark: "main", changeId: null, commitId: null }, catalog: true }]
    }).isPersisted.promise
    expect(scope.store.collections.workingCopies.get(SHARED)).toMatchObject({ kind: "shared", access: "read" })
    return scope
  }

  test("/repo.tree <sharedCopy> lists the root through GET .../contents and maps the mirror's rows to the tree's rows, nothing filtered", async () => {
    const { store, controller, requests, boxRequests, sharedRequests } = await loadShared()
    expect((await controller.commands.run("repo.tree", SHARED)).status).toBe("executed")
    expect(sharedRequests).toEqual([SHARED_CONTENTS])
    expect(requests).toEqual([])
    expect(boxRequests).toEqual([])
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, ""))).toMatchObject({
      copyId: SHARED,
      path: "",
      expanded: true,
      state: "loaded",
      /*
       * `dir` is a directory, `file` a file; a row without a name drops. The
       * order is the sidebar's, not the mirror's: directories first, then by
       * name, so `Cargo.lock` precedes `CHANGELOG.md` here and the byte order
       * the route answered in does not reach the tree.
       */
      entries: [
        { name: "apps", kind: "dir" },
        { name: "Cargo.lock", kind: "file" },
        { name: "CHANGELOG.md", kind: "file" },
        { name: "PACKAGE.ts", kind: "file" },
        { name: "README.md", kind: "file" }
      ]
    })
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, ""))?.truncated).toBeFalsy()
    // A nested directory is one more read with its path (per-segment encoding); an empty one is a loaded row with no entries.
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps`)).status).toBe("executed")
    expect(sharedRequests[1]).toBe(`${SHARED_CONTENTS}/apps`)
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "apps"))?.entries).toEqual([{ name: "ui", kind: "dir" }])
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps/ui/`)).status).toBe("executed")
    expect(sharedRequests[2]).toBe(`${SHARED_CONTENTS}/apps/ui`)
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "apps/ui"))).toMatchObject({ state: "loaded", entries: [] })
    // Collapsing is collection state: no read.
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "apps"))?.expanded).toBe(false)
    expect(sharedRequests).toHaveLength(3)
  })

  test("a refusal writes the failed row with the mirror's message verbatim; a file path names the read that answers it", async () => {
    const { store, controller } = await loadShared()
    expect((await controller.commands.run("repo.tree", `${SHARED}#boom`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "boom"))).toMatchObject({ state: "failed", expanded: true, entries: [], error: "the mirror is resyncing smithersai/smithers" })
    expect((await controller.commands.run("repo.tree", `${SHARED}#missing`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "missing"))?.error).toBe("smithersai/smithers has no missing")
    expect((await controller.commands.run("repo.tree", `${SHARED}#README.md`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "README.md"))?.error).toBe("README.md in smithersai/smithers is a file; run /files.read README.md instead")
  })

  /*
   * `..` never leaves the repository's namespace. `encodeRepoPath` does not
   * escape a dot and a URL parser collapses the segments before the request
   * leaves the page, so `.../contents/../../../../user/secrets` resolves to
   * `/api/user/secrets` and would be sent same-origin with the visitor's own
   * cookies, then painted as this copy's file rows. `repo.tree` is not
   * userOnly, so the agent can name that path: the seam refuses it in place,
   * before any request, and the mirror is never asked.
   */
  test("a path that leaves the repository is refused in place, and the mirror is never asked", async () => {
    const { store, controller, requests, boxRequests, sharedRequests } = await loadShared()
    expect((await controller.commands.run("repo.tree", `${SHARED}#../../../../user/secrets`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "../../../../user/secrets"))).toMatchObject({
      copyId: SHARED,
      state: "failed",
      expanded: true,
      entries: [],
      error: "File paths must stay inside the repository."
    })
    expect(sharedRequests).toEqual([])
    expect(requests).toEqual([])
    expect(boxRequests).toEqual([])
    // A percent-encoded escape is the same path, so it is the same refusal.
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps/%2e%2e/%2e%2e/user/secrets`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "apps/%2e%2e/%2e%2e/user/secrets"))?.error).toBe("File paths must stay inside the repository.")
    expect(sharedRequests).toEqual([])
    // A path that stays inside still lists, so the guard costs the tree nothing.
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps`)).status).toBe("executed")
    expect(sharedRequests).toEqual([`${SHARED_CONTENTS}/apps`])
  })

  test("the shared copy is never a checkout on this machine: the local resolver says so in place", async () => {
    const { store, controller } = await loadShared()
    const { openRepoOfCopy } = await import("./RepoTreeSeam")
    expect(openRepoOfCopy(store, SHARED)).toEqual({ error: "shared is the shared read-only copy of smithersai/smithers; its files are read from the public mirror, never from this machine." })
    expect(controller.commands.find("repo.tree")).toBeDefined()
  })
})

describe("the workspace name", () => {
  test("/workspace.rename writes the heading's name; a blank name renders the form; the pencil toggles the inline editor", async () => {
    const { store, controller } = await treeController([])
    expect(store.session().workspaceName).toBeUndefined()
    expect((await controller.commands.run("workspace.rename", "  Force  ")).status).toBe("executed")
    expect(store.session().workspaceName).toBe("Force")
    expect(store.session().workspaceRenameOpen).toBe(false)
    const blank = await controller.commands.run("workspace.rename", "   ")
    expect(blank).toEqual({ status: "form", flow: "workspace.rename", cardId: "form-workspace.rename", fields: ["name"] })
    expect(store.session().workspaceName).toBe("Force")
    expect((await controller.commands.run("workspace.rename.edit")).status).toBe("executed")
    expect(store.session().workspaceRenameOpen).toBe(true)
    expect((await controller.commands.run("workspace.rename.edit")).status).toBe("executed")
    expect(store.session().workspaceRenameOpen).toBe(false)
    // A rename while the editor is open closes it.
    await controller.commands.run("workspace.rename.edit")
    expect((await controller.commands.run("workspace.rename", "Plue")).status).toBe("executed")
    expect(store.session()).toMatchObject({ workspaceName: "Plue", workspaceRenameOpen: false })
  })
})
