import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CardSchema } from "@smthrs/rpc/Cards"
import type { Repo } from "@smthrs/rpc/LocalApp"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { repoKeyOf } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { resolveFileTarget } from "./FilesSeam"

/*
 * The repo files seam (FilesSeam.ts) through the real command path: /files.list
 * reads GET /api/repos/{owner}/{repo}/contents[/path] and surfaces the
 * "file-list" card (entries sorted dirs-first, then by name); /files.read reads
 * the same route for a file path and surfaces the "file" card (base64 decoded,
 * capped at 16 KB, binary refused). Failures are honest strings, never throws;
 * a namespace 404 answers the /repos.import hint. The wire shapes mirror multi
 * src/files/filesClient.ts: a directory answers a JSON array of {name, path,
 * type} entries, a file answers one {path, content, encoding, size} record.
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

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64")

/** A README with a multi-byte character: the decode must answer UTF-8, not mojibake. */
const README_TEXT = "# Flows — the runtime\n\nbun install\n"
/** Longer than the 16 KB card cap, so the card truncates honestly. */
const BIG_TEXT = "x".repeat(16 * 1024 + 100)

const WORD_LIST = "apple\nberry\n".repeat(25)
const SHA256SUMS = Array.from({ length: 8 }, (_, index) => `${String(index).repeat(64)}\n`).join("")

interface SeenRequest {
  readonly method: string
  readonly url: string
}

/*
 * The platform double: one imported repository (will/flows) answered in the
 * reference wire shape. Directory answers are DELIBERATELY unsorted and carry
 * one malformed row, so the card pins the seam's sorting and dropping. Every
 * other namespace 404s the way the platform 404s an un-imported repo.
 */
const filesBackend = () => {
  const requests: SeenRequest[] = []
  const routes: Record<string, () => Response> = {
    "/api/repos/will/flows/contents": () =>
      json(200, [
        { name: "zeta.txt", path: "zeta.txt", type: "file" },
        { name: "src", path: "src", type: "dir" },
        { name: "README.md", path: "README.md", type: "file" },
        { name: "docs", path: "docs", type: "dir" },
        { name: "broken", path: "broken", type: "symlink" },
        null
      ]),
    "/api/repos/will/flows/contents/src": () =>
      json(200, [
        { name: "lib", path: "src/lib", type: "dir" },
        // No name — the seam derives it from the path's last segment.
        { path: "src/app.ts", type: "file" }
      ]),
    "/api/repos/will/flows/contents/src/lib": () => json(200, []),
    "/api/repos/will/flows/contents/README.md": () =>
      json(200, {
        path: "README.md",
        content: base64(README_TEXT),
        encoding: "base64",
        size: README_TEXT.length
      }),
    "/api/repos/will/flows/contents/plain.txt": () =>
      json(200, { path: "plain.txt", content: "hello, plain wire\n", encoding: "", size: 18 }),
    "/api/repos/will/flows/contents/big.txt": () =>
      json(200, { path: "big.txt", content: base64(BIG_TEXT), encoding: "base64", size: BIG_TEXT.length }),
    "/api/repos/will/flows/contents/logo.png": () =>
      json(200, {
        path: "logo.png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]).toString("base64"),
        encoding: "base64",
        size: 7
      }),
    "/api/repos/will/flows/contents/raw.bin": () =>
      json(200, { path: "raw.bin", content: "PK\u0000\u0003", encoding: "", size: 4 }),
    /*
     * The shape the real platform answers for blob.bin: base64 bytes with
     * `encoding: "utf-8"` on them.
     */
    "/api/repos/will/flows/contents/mislabelled.bin": () =>
      json(200, {
        path: "mislabelled.bin",
        content: Buffer.from(
          Array.from({ length: 512 }, (_byte, index) => (index * 7 + 3) % 256)
        ).toString("base64"),
        encoding: "utf-8",
        size: 512
      }),
    "/api/repos/will/flows/contents/long.md": () =>
      json(200, {
        path: "long.md",
        content: `# Smithers\n\n${"Smithers keeps what it learns in world notes. ".repeat(40)}`,
        encoding: "utf-8",
        size: 2000
      }),
    ...Object.fromEntries(Object.entries({ "words.txt": WORD_LIST, SHA256SUMS }).map(([path, content]) => [
      `/api/repos/will/flows/contents/${path}`,
      () => json(200, { path, content, encoding: "utf-8", size: Buffer.byteLength(content) })
    ])),
    "/api/repos/will/flows/contents/missing.txt": () => json(404, { message: "Path not found: missing.txt" }),
    "/api/repos/will/flows/contents/boom.txt": () => json(500, { message: "the platform fell over" })
  }
  const services: AppServices = {
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes("/contents")) {
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
      // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this seam's request.
      if (url.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
      requests.push({ method: "GET", url })
      if (url.includes("net.txt")) throw new Error("socket hang up")
      const route = routes[url]
      if (route !== undefined) return route()
      // The platform 404s the whole namespace of a repo it never imported.
      return json(404, { code: "not_found", message: "repository not found" })
    }
  }
  return { services, requests }
}

const freshController = async () => {
  const backend = filesBackend()
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    requests: backend.requests,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, backend.services)
  }
}

const ready = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  // Lane piper: the inventory (not the retired watch-list) is the repo source.
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{
      id: "will/flows",
      org: "will",
      ownerKind: "user",
      name: "flows",
      head: { bookmark: "main", changeId: "change123", commitId: "commit123" }
    }]
  })
  await settled()
}

const listCard = (store: AppStore, id: string) => {
  const card = store.collections.cards.get(id)
  if (card === undefined || card.kind !== "file-list") return undefined
  return card
}

const fileCard = (store: AppStore, id: string) => {
  const card = store.collections.cards.get(id)
  if (card === undefined || card.kind !== "file") return undefined
  return card
}

describe("files seam — files.list", () => {
  test("rejects dot-segment and mixed-separator traversal before any request", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    for (const path of ["../../api/admin/health", "src/../secret", String.raw`..\api\admin`, "%2e%2e/admin"]) {
      const outcome = await controller.commands.run("files.list", path)
      expect(outcome.status).toBe("failed")
    }
    expect(requests).toEqual([])
  })
  test("the bare command lists the root: entries sorted dirs-first then by name, malformed rows dropped", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toEqual([{ method: "GET", url: "/api/repos/will/flows/contents" }])

    const card = listCard(store, "files-will/flows-/")
    expect(card).toBeDefined()
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.path).toBe("")
    expect(card?.payload.entries).toEqual([
      { name: "docs", kind: "dir" },
      { name: "src", kind: "dir" },
      { name: "README.md", kind: "file" },
      { name: "zeta.txt", kind: "file" }
    ])
    // The payload matches the shared wire schema exactly.
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("a \"/\" path is the root too: the same card id, one route", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "/")
    expect(outcome.status).toBe("executed")
    expect(requests[0]?.url).toBe("/api/repos/will/flows/contents")
    expect(listCard(store, "files-will/flows-/")).toBeDefined()
  })

  test("a path plus an explicit owner/repo targets that directory; names derive from paths when absent", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src will/flows")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests[0]?.url).toBe("/api/repos/will/flows/contents/src")
    const card = listCard(store, "files-will/flows-src")
    expect(card).toBeDefined()
    expect(card?.payload.path).toBe("src")
    expect(card?.payload.entries).toEqual([
      { name: "lib", kind: "dir" },
      { name: "app.ts", kind: "file" }
    ])
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("an empty directory surfaces an empty-entries card, not an error", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src/lib")
    expect(outcome.status).toBe("executed")
    expect(listCard(store, "files-will/flows-src/lib")?.payload.entries).toEqual([])
  })

  test("an un-imported repository's namespace 404 answers the /repos.import hint", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src acme/ghost")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("acme/ghost isn't imported yet — run /repos.import acme/ghost first")
    }
    expect(listCard(store, "files-acme/ghost-src")).toBeUndefined()
  })
})

describe("files seam — files.read", () => {
  test("reads a base64 file into the file card, UTF-8 decoded, untruncated", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "README.md")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toEqual([{ method: "GET", url: "/api/repos/will/flows/contents/README.md" }])
    const card = fileCard(store, "file-will/flows-README.md")
    expect(card).toBeDefined()
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.path).toBe("README.md")
    // The em-dash proves base64 bytes went back through UTF-8, not latin1.
    expect(card?.payload.content).toBe(README_TEXT)
    expect(card?.payload.truncated).toBe(false)
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("a plain (non-base64) wire answer passes through as-is", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "plain.txt")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-plain.txt")?.payload.content).toBe("hello, plain wire\n")
  })

  test("a file beyond 16 KB is cut at the cap with truncated: true", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "big.txt")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-big.txt")
    expect(card?.payload.content.length).toBe(16 * 1024)
    expect(card?.payload.truncated).toBe(true)
  })

  /*
   * §8.27: the read SUCCEEDED — the file is simply not text. That is an
   * answer about the file, so it is a card, and the card states it instead of
   * printing 42 000 pixels of base64 the reader can neither use nor reach.
   */
  test("binary base64 content (NUL bytes) renders a card that says so, never the bytes", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "logo.png")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-logo.png")
    expect(card?.payload.binary).toBe(true)
    expect(card?.payload.content).toBe("")
  })

  test("binary plain content (a NUL byte in the string) is stated the same way", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "raw.bin")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-raw.bin")?.payload.binary).toBe(true)
  })

  /*
   * The platform answers `encoding: "utf-8"` for a file whose content is
   * plainly base64-encoded bytes, so the declared encoding is not trusted on
   * its own. The byte size distinguishes encoded bytes from plain text,
   * even when the text uses only characters from the base64 alphabet.
   */
  test("base64 bytes mislabelled as utf-8 are still recognised as binary", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "mislabelled.bin")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-mislabelled.bin")?.payload.binary).toBe(true)
  })

  test("a long plain-text file is not mistaken for base64", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "long.md")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-long.md")
    expect(card?.payload.binary ?? false).toBe(false)
    expect(card?.payload.content).toContain("Smithers")
  })

  test.each([
    ["words.txt", WORD_LIST],
    ["SHA256SUMS", SHA256SUMS]
  ])("utf-8 %s stays text even when it uses only the base64 alphabet", async (path, content) => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", path)
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, `file-will/flows-${path}`)
    expect(card?.payload.binary ?? false).toBe(false)
    expect(card?.payload.content).toBe(content)
  })

  test("a missing path inside an imported repo answers the platform's path message, not the import hint", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "missing.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Path not found: missing.txt")
  })

  test("an un-imported repository's namespace 404 answers the /repos.import hint", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "README.md acme/ghost")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("acme/ghost isn't imported yet — run /repos.import acme/ghost first")
    }
  })
})

describe("files seam — honest failures", () => {
  test("a 500 answers the platform's message, never a throw", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "boom.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform fell over")
    expect(fileCard(store, "file-will/flows-boom.txt")).toBeUndefined()
  })

  test("a network throw answers an honest string naming the path and repo", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "net.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "Could not reach the backend to read net.txt in will/flows: socket hang up"
      )
    }
  })

  test("an inventory-less signed-in session answers the repo-resolution error before any request", async () => {
    const backend = filesBackend()
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableRepositories,
      unavailableAgent,
      backend.services
    )
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    await settled()
    const outcome = await controller.commands.run("files.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"
      )
    }
    expect(backend.requests).toHaveLength(0)
  })
})


/*
 * A repository opened in the LOCAL app (LOCAL-APP.md): the same two commands
 * read it through POST /api/repo/files and render the same two cards. The
 * active open repository is the bare target; its owner/repo name or folder
 * name routes locally; any other name is still a Cloud read. 2026-09-01: with
 * ~/smithers open, "show me the README" had no path at all — the files flows
 * were Cloud-only and filtered out of the local catalog.
 */
const localRepo = (id: string, name: string, path: string): Repo => ({
  id,
  path,
  name,
  git: { branch: "main", remote: `git@github.com:${name}.git` },
  warnings: [],
  smithers: { detected: true, workspaceFile: "WORKSPACE.ts", declarationFiles: [], reason: "1 workspace detected", workspaces: [{ path: ".", title: name }] }
})
const SMITHERS = localRepo("repo-smithers", "smithersai/smithers", "/Users/will/smithers")

const localFilesBackend = () => {
  const requests: Array<{ readonly url: string; readonly body?: unknown }> = []
  const answers: Record<string, () => Response> = {
    "": () =>
      json(200, {
        kind: "dir",
        path: "",
        entries: [{ name: "zeta.txt", kind: "file" }, { name: "src", kind: "dir" }, { name: "README.md", kind: "file" }]
      }),
    "src": () => json(200, { kind: "dir", path: "src", entries: [] }),
    "node_modules": () =>
      json(200, {
        kind: "dir",
        path: "node_modules",
        entries: Array.from({ length: 1000 }, (_entry, index) => ({ name: `pkg-${String(index).padStart(4, "0")}`, kind: "dir" as const }))
      }),
    "README.md": () =>
      json(200, { kind: "file", path: "README.md", size: 14, content: "# Local — hi\n", truncated: false, binary: false }),
    "big.txt": () =>
      json(200, { kind: "file", path: "big.txt", size: 999_999, content: "y".repeat(2000), truncated: true, binary: false }),
    "logo.png": () => json(200, { kind: "file", path: "logo.png", size: 7, content: "", truncated: false, binary: true }),
    "missing.txt": () => json(404, { error: { code: "path_not_found", message: "Path not found: missing.txt" } })
  }
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      if (path === "/api/repo/files") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { repoId?: string; path?: string }
        requests.push({ url: path, body })
        const answer = answers[body.path ?? ""]
        return answer === undefined
          ? json(404, { error: { code: "path_not_found", message: `Path not found: ${body.path}` } })
          : answer()
      }
      // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this seam's request.
      if (url.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
      requests.push({ url })
      if (url.includes("/contents")) return json(404, { code: "not_found", message: "repository not found" })
      return json(404, { status: "error", message: `no stub for ${url}` })
    }
  }
  return { services, requests }
}

const localController = async (repos: ReadonlyArray<Repo>) => {
  const backend = localFilesBackend()
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, backend.services)
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [...repos] })
  await settled()
  return { store, controller, requests: backend.requests }
}

describe("files seam — a repository open in the local app", () => {
  test("a bare /files.read reads the active open repository through the local route and renders the file card, signed out", async () => {
    const { store, controller, requests } = await localController([SMITHERS])
    const outcome = await controller.commands.run("files.read", "README.md")
    expect(outcome.status).toBe("executed")
    // The model reads the value: the same text the card shows, never a bare "executed".
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe("README.md in smithersai/smithers:\n# Local — hi\n")
    expect(requests).toEqual([{ url: "/api/repo/files", body: { repoId: "repo-smithers", path: "README.md" } }])
    const card = fileCard(store, "file-repo-smithers-README.md")
    expect(card?.payload).toEqual({
      repo: "smithersai/smithers",
      localRepoId: "repo-smithers",
      path: "README.md",
      content: "# Local — hi\n",
      truncated: false,
      address: "/smithersai/smithers/README.md"
    })
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("a bare /files.list renders the file-list card, dirs first, whose rows name the local repository", async () => {
    const { store, controller } = await localController([SMITHERS])
    const listed = await controller.commands.run("files.list", "")
    expect(listed.status).toBe("executed")
    expect(listed.status === "executed" ? listed.value : undefined).toBe("/ in smithersai/smithers:\nsrc/\nREADME.md\nzeta.txt")
    const card = listCard(store, "files-repo-smithers-/")
    expect(card?.payload).toEqual({
      repo: "smithersai/smithers",
      localRepoId: "repo-smithers",
      path: "",
      entries: [{ name: "src", kind: "dir" }, { name: "README.md", kind: "file" }, { name: "zeta.txt", kind: "file" }],
      address: "/smithersai/smithers/"
    })
  })

  test("the model's copy of a huge listing is bounded while the card keeps every entry", async () => {
    const { store, controller } = await localController([SMITHERS])
    const listed = await controller.commands.run("files.list", "node_modules")
    expect(listed.status).toBe("executed")
    const value = listed.status === "executed" ? listed.value ?? "" : ""
    expect(value.split("\n").length).toBe(1 + 400 + 1)
    expect(value.endsWith("… and 600 more (the card lists them all)")).toBe(true)
    expect(listCard(store, "files-repo-smithers-node_modules")?.payload.entries).toHaveLength(1000)
  })

  test("the repository's owner/repo name or folder name routes locally; any other name is still a Cloud read", async () => {
    const { store, controller, requests } = await localController([SMITHERS])
    expect((await controller.commands.run("files.read", "README.md smithersai/smithers")).status).toBe("executed")
    expect((await controller.commands.run("files.read", "README.md smithers")).status).toBe("executed")
    expect(requests.filter((request) => request.url === "/api/repo/files")).toHaveLength(2)
    expect(fileCard(store, "file-repo-smithers-README.md")?.payload.content).toBe("# Local — hi\n")
    const cloud = await controller.commands.run("files.read", "README.md will/flows")
    expect(cloud.status).toBe("failed")
    expect(requests.some((request) => request.url.includes("/api/repos/will/flows/contents/README.md"))).toBe(true)
  })

  test("global paths use the same local copy in the helper, listing and reading", async () => {
    const other = localRepo("repo-other", "aa/other", "/Users/will/other")
    const { store, controller, requests } = await localController([other, SMITHERS])
    await ready(store)
    store.dispatch({ type: "repo.selected", actor: "user", id: repoKeyOf(other.path) })
    await settled()
    for (const [command, path] of [["files.list", "src"], ["files.read", "README.md"]] as const) {
      const globalPath = `/smithersai/smithers/${path}`
      const target = resolveFileTarget(store, globalPath, undefined)
      expect(target).toMatchObject({ kind: "local", repo: SMITHERS, path })
      expect((await controller.commands.run(command, globalPath)).status).toBe("executed")
      expect(requests.at(-1)).toEqual({
        url: "/api/repo/files", body: { repoId: SMITHERS.id, path }
      })
    }
    expect(listCard(store, "files-repo-smithers-src")?.payload.localRepoId).toBe(SMITHERS.id)
    expect(fileCard(store, "file-repo-smithers-README.md")?.payload.localRepoId).toBe(SMITHERS.id)
  })

  test("a bounded read states truncation, a binary file is stated not printed, and a missing path is the honest string", async () => {
    const { store, controller } = await localController([SMITHERS])
    expect((await controller.commands.run("files.read", "big.txt")).status).toBe("executed")
    expect(fileCard(store, "file-repo-smithers-big.txt")?.payload.truncated).toBe(true)
    const binary = await controller.commands.run("files.read", "logo.png")
    expect(binary.status).toBe("executed")
    expect(binary.status === "executed" ? binary.value : undefined).toBe("logo.png in smithersai/smithers is a binary file; its bytes are not shown.")
    expect(fileCard(store, "file-repo-smithers-logo.png")?.payload).toEqual({
      repo: "smithersai/smithers",
      localRepoId: "repo-smithers",
      path: "logo.png",
      content: "",
      truncated: false,
      binary: true,
      address: "/smithersai/smithers/logo.png"
    })
    const missing = await controller.commands.run("files.read", "missing.txt")
    expect(missing.status).toBe("failed")
    // The local app's own message (its `{ error: { code, message } }` envelope), never the seam's fallback.
    expect(JSON.stringify(missing)).toContain("Path not found: missing.txt")
    expect(JSON.stringify(missing)).not.toContain("missing.txt in smithersai/smithers")
    expect((await controller.commands.run("files.read", "src")).status).toBe("failed")
    expect((await controller.commands.run("files.list", "README.md")).status).toBe("failed")
  })

  test("with several repositories open, a bare call reads the active one — the store names the first by name until one is selected", async () => {
    const zeta = localRepo("repo-zeta", "zz/zeta", "/Users/will/zeta")
    const alpha = localRepo("repo-alpha", "aa/alpha", "/Users/will/alpha")
    const { store, controller, requests } = await localController([zeta, alpha])
    expect((await controller.commands.run("files.read", "README.md")).status).toBe("executed")
    expect(requests[0]?.body).toEqual({ repoId: "repo-alpha", path: "README.md" })
    store.dispatch({ type: "repo.selected", actor: "user", id: repoKeyOf(zeta.path) })
    await settled()
    expect((await controller.commands.run("files.read", "README.md")).status).toBe("executed")
    expect(requests[1]?.body).toEqual({ repoId: "repo-zeta", path: "README.md" })
  })
})

describe("files seam — the model's copy of a Cloud read", () => {
  test("a Cloud files.read answers the file's text as its value, so the model quotes the file and never invents one", async () => {
    const { controller } = await freshController()
    await ready(controller.store ?? (await createAppStore({ kind: "localStorage", storage: memoryStorage() })))
    const outcome = await controller.commands.run("files.read", "README.md")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(`README.md in will/flows:\n${README_TEXT}`)
  })
})

/*
 * The line anchor (docs/code-intel/PLAN.md §1): `files.read <path>:<line>[:<col>]`
 * reads the same file through the same route and records the anchor on the
 * card, which scrolls to and marks the line. The card id stays
 * `file-<repo>-<path>` (the dedupe every definition jump relies on), and a
 * re-read without an anchor clears it: the card states where it stands.
 */
describe("files seam — the line anchor", () => {
  test("a local read carries the bare path to the route and the line and column on the card", async () => {
    const { store, controller, requests } = await localController([SMITHERS])
    const outcome = await controller.commands.run("files.read", "README.md:2:3")
    expect(outcome.status).toBe("executed")
    expect(requests).toEqual([{ url: "/api/repo/files", body: { repoId: "repo-smithers", path: "README.md" } }])
    const card = fileCard(store, "file-repo-smithers-README.md")
    expect(card?.payload.line).toBe(2)
    expect(card?.payload.column).toBe(3)
    expect(card?.payload.content).toBe("# Local — hi\n")
    expect(CardSchema.safeParse(card).success).toBe(true)
    await controller.commands.run("files.read", "README.md:1")
    expect(fileCard(store, "file-repo-smithers-README.md")?.payload).toMatchObject({ line: 1 })
    expect(fileCard(store, "file-repo-smithers-README.md")?.payload.column).toBeUndefined()
    await controller.commands.run("files.read", "README.md")
    expect(fileCard(store, "file-repo-smithers-README.md")?.payload.line).toBeUndefined()
  })

  test("a Cloud read anchors the same way, and the model's copy is the file", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "README.md:1")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(`README.md in will/flows:\n${README_TEXT}`)
    expect(requests.map((request) => request.url)).toEqual(["/api/repos/will/flows/contents/README.md"])
    expect(fileCard(store, "file-will/flows-README.md")?.payload).toMatchObject({ path: "README.md", line: 1 })
  })
})
