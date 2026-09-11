import type { StorageApi } from "@tanstack/db"
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { CardSchema } from "@smthrs/rpc/Cards"
import { CLOUD_LSP_ROOT_URI, RepoSchema } from "@smthrs/rpc/LocalApp"
import type { Repo } from "@smthrs/rpc/LocalApp"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { resolveServer, TYPESCRIPT_SERVER } from "../../../bun/lsp/LanguageServers"
import { emptyLookup, writeFixtureProject } from "../../../bun/lsp/LspFixture"
import { createLspHost, defaultServerLookup } from "../../../bun/lsp/LspHost"
import { findNode } from "../../../bun/Node"
import { startLocalServer } from "../../../bun/server"
import type { LocalServer, LocalServerOptions } from "../../../bun/server"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppFetch } from "../../runtime/LocalSession"
import { createAppController } from "../AppController"
import type { AppController, AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createLspClient } from "../LspClient"
import { createCodeIntelSeam } from "./CodeIntelSeam"

/*
 * The code-intel seam (CodeIntelSeam.ts, LspClient.ts) through the real
 * command path against a REAL local origin running the REAL
 * typescript-language-server (code-intel PLAN.md §4, §6): `/code.hover`,
 * `/code.definition` and `/code.diagnostics` answer `{ value }` for the model
 * and patch the human's FILE card; the definition opens its target through
 * files.read's line anchor; a diagnostics publication on `/ws` (`lsp:<repoId>`)
 * patches the card with no request; the missing-server door states the
 * install line on the card and to the model. Absent a language server or a
 * Node sidecar, the spawning tests skip and say why; nothing stands in for
 * the server. The refusal doors (missing server, unsupported file, a Cloud
 * target without a workspace) need no server and always run.
 *
 * Lane L6: a file card of a CLOUD repository with a running workspace asks
 * the language server plue relays inside it (CloudLspClient.ts) through the
 * REAL Bun tunnel (`/api/cloud-ws/…/lsp`) to a plue double on the loopback
 * that speaks the recorded wire (docs/code-intel/PLAN.md "Live"): the session
 * POST, the `lsp` subprotocol, initialize with the guest root, didOpen with
 * the card's text, then hover / diagnostics / definition, and the 409
 * `language_server_missing` and close paths in plue's own words.
 */

const node = await findNode()
const resolved = resolveServer(TYPESCRIPT_SERVER, defaultServerLookup(), node)
const skipReason = node === null
  ? "no Node.js >= 22.19 on this machine to run the language server"
  : "missing" in resolved
  ? `no typescript-language-server on this machine (install: ${resolved.missing})`
  : undefined
if (skipReason !== undefined) console.warn(`code-intel seam tests skipped: ${skipReason}`)

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

/** The native host with every door, `local.lsp` among them. */
const NATIVE: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: [...RuntimeCapabilitySchema.options],
  authFlow: "both",
  sandbox: null
}

const INSTALL = "npm i -g typescript-language-server typescript"

let dist = ""
let repoDir = ""
const disposers: Array<() => Promise<void> | void> = []

/** One real local origin, the fixture repository opened on it, and the whole app pointed at it. */
const app = async (options: Partial<LocalServerOptions> = {}, services: Partial<AppServices> = {}) => {
  const server: LocalServer = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    allowManualRepositoryPaths: true,
    node,
    home: tmpdir(),
    log: () => {},
    ...options
  })
  disposers.push(() => server.stop())
  const opened = await fetch(`${server.origin}/api/repo/open`, {
    method: "POST",
    headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: server.sessionToken },
    body: JSON.stringify({ path: repoDir })
  })
  expect(opened.status).toBe(200)
  const repo: Repo = RepoSchema.parse(((await opened.json()) as { repo: unknown }).repo)
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    bootstrap: NATIVE,
    baseUrl: server.origin,
    // The page's transport: the per-launch token rides same-origin /api calls and the /ws subprotocol.
    fetchImpl: createAppFetch({ token: server.sessionToken, location: { href: `${server.origin}/`, origin: server.origin } }),
    socketUrl: () => `${server.origin.replace(/^http/, "ws")}/ws`,
    socketProtocols: () => [server.websocketProtocol],
    ...services
  })
  disposers.push(() => controller.dispose())
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { server, repo, store, controller }
}

type FileCard = Extract<Card, { kind: "file" }>

const fileCard = (store: AppStore, id: string): FileCard | undefined => {
  const card = store.collections.cards.get(id)
  return card?.kind === "file" ? card : undefined
}

const valueOf = (outcome: Awaited<ReturnType<AppController["commands"]["run"]>>): string => {
  expect(outcome.status).toBe("executed")
  return outcome.status === "executed" ? outcome.value ?? "" : ""
}

const until = async (predicate: () => boolean, what: string, deadlineMs = 10_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-code-intel-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  repoDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-code-intel-repo-")))
  await writeFixtureProject(repoDir)
})

afterAll(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  await rm(dist, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

describe("code-intel seam — refusals that need no language server", () => {
  test("a missing language server states the install line on the card and to the model, and starts nothing", async () => {
    const { server, repo, store, controller } = await app({
      lsp: (deps) => createLspHost({ ...deps, lookup: emptyLookup(tmpdir()) })
    })
    const outcome = await controller.commands.run("code.hover", "src/index.ts:3:7")
    expect(outcome).toEqual({ status: "failed", error: `No TypeScript language server on this machine. Install: ${INSTALL}` })
    const card = fileCard(store, `file-${repo.id}-src/index.ts`)
    // The file card rendered (the human sees the file at the position) and states the door honestly.
    expect(card?.payload).toMatchObject({ path: "src/index.ts", line: 3, column: 7, intel: { state: "missing", note: INSTALL } })
    expect(card?.payload.hover).toBeUndefined()
    expect(CardSchema.safeParse(card).success).toBe(true)
    const servers = await fetch(`${server.origin}/api/lsp/servers`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })
    expect(await servers.json()).toEqual({ servers: [] })
    // The agent door reads the same sentence.
    const previous = new Set(store.collections.transitions.keys())
    const agent = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "code.diagnostics", args: "src/index.ts" })
    })
    expect(agent).toBe(`failed: No TypeScript language server on this machine. Install: ${INSTALL}`)
    const edits = [...store.collections.transitions.values()].filter((row) => !previous.has(row.id) && row.type.startsWith("card."))
    expect(edits.length).toBeGreaterThan(0)
    expect(edits.every((row) => row.actor === "smithers")).toBe(true)
  }, 30_000)

  test("a file no server handles answers the host's typed refusal, stated on the card as unavailable", async () => {
    const { repo, store, controller } = await app()
    const outcome = await controller.commands.run("code.diagnostics", "README.md")
    expect(outcome).toEqual({ status: "failed", error: "No language server handles .md files." })
    expect(fileCard(store, `file-${repo.id}-README.md`)?.payload.intel).toEqual({
      state: "unavailable",
      note: "No language server handles .md files."
    })
  }, 30_000)

  test("a definition keeps its location and reports the target file read refusal", async () => {
    const { repo, store, controller } = await app()
    valueOf(await controller.commands.run("files.read", "src/index.ts"))
    const http = async () => Response.json({
      locations: [{ path: "src/greet.ts", line: 6, character: 14, endLine: 6, endCharacter: 19 }],
      total: 1,
      omitted: 0,
      digest: "fixture-digest"
    })
    const lsp = createLspClient({ http, baseUrl: "", socketUrl: () => undefined })
    const refusal = "Could not read src/greet.ts: the local app is unreachable."
    const readFile = mock(async () => refusal)
    const seam = createCodeIntelSeam({
      http,
      baseUrl: "",
      store,
      dispatch: store.dispatch,
      actor: () => "user",
      nextOrdinal: () => 2
    }, { lsp, readFile })
    disposers.push(() => lsp.dispose(), () => seam.dispose())

    const result = await seam.definition("src/index.ts", 3, 17, repo.id)
    expect(readFile).toHaveBeenCalledWith("src/greet.ts", repo.id, { line: 6, column: 14 })
    expect(fileCard(store, `file-${repo.id}-src/greet.ts`)).toBeUndefined()
    expect(result).toEqual({
      value: `src/index.ts:3:17 in ${repo.name} is defined at:\nsrc/greet.ts:6:14; the target could not be opened: ${refusal}`
    })
  }, 30_000)

  test("a traversal is refused before any host is asked", async () => {
    const { controller } = await app()
    expect(await controller.commands.run("code.definition", "../etc/passwd:1:1")).toEqual({
      status: "failed",
      error: "File paths must stay inside the repository."
    })
  }, 30_000)
})

/*
 * Lane L6: the cloud half. plue is a double on the loopback — its session
 * POST in its own shape behind the real `/api/cloud/` proxy, its lsp socket
 * behind the real `/api/cloud-ws/` tunnel — and the language server it
 * "relays" speaks the recorded transcript. Nothing about the tunnel, the
 * client or the seam is faked.
 */
interface PlueOptions {
  /** Refuse the lsp upgrade (and its status re-read) with this status and body, as plue's pre-upgrade checks do. */
  readonly refuseUpgrade?: { readonly status: number; readonly body: unknown }
}

const startPlue = (options: PlueOptions = {}) => {
  const received: Array<Record<string, unknown>> = []
  const posts: Array<unknown> = []
  const protocols: Array<string | null> = []
  const sockets = new Set<{ close: (code?: number, reason?: string) => void; terminate: () => void }>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, self) => {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/api/repos/will/flows/workspace/sessions") {
        posts.push(await request.json())
        return Response.json({ id: "lsps-1", workspace_id: "ws-1", status: "running", kind: "lsp", language: "typescript", idle_timeout_secs: 600 }, { status: 201 })
      }
      if (url.pathname === "/api/repos/will/flows/workspace/sessions/lsps-1/lsp") {
        if (options.refuseUpgrade !== undefined) return Response.json(options.refuseUpgrade.body, { status: options.refuseUpgrade.status })
        protocols.push(request.headers.get("sec-websocket-protocol"))
        if (self.upgrade(request, { headers: { "sec-websocket-protocol": "lsp" } })) return undefined
      }
      return Response.json({ message: `no route ${request.method} ${url.pathname}` }, { status: 404 })
    },
    websocket: {
      open: (socket) => void sockets.add(socket),
      close: (socket) => void sockets.delete(socket),
      message: (socket, raw) => {
        const message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as Record<string, unknown>
        received.push(message)
        const reply = (result: unknown): void => void socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
        switch (message.method) {
          case "initialize":
            reply({ capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true }, serverInfo: { name: "typescript-language-server" } })
            return
          case "textDocument/didOpen": {
            const { uri } = (message.params as { textDocument: { uri: string } }).textDocument
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              method: "textDocument/publishDiagnostics",
              params: {
                uri,
                version: 1,
                diagnostics: [{ range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } }, severity: 2, code: 6133, source: "typescript", message: "'greet' is declared but its value is never read." }]
              }
            }))
            return
          }
          case "textDocument/hover":
            reply({ contents: { kind: "markdown", value: "```typescript\nconst greet: (name: string) => string\n```" }, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } } })
            return
          case "textDocument/definition":
            reply([{ uri: `${CLOUD_LSP_ROOT_URI}/src/greet.ts`, range: { start: { line: 5, character: 13 }, end: { line: 5, character: 18 } } }])
            return
          default:
            return
        }
      }
    }
  })
  /*
   * The double outlives the tunnel it served, so it hangs up before it stops:
   * `stop(true)` waits on every live connection, and a relayed lsp socket is
   * still open here — the app half of the tunnel is torn down by the earlier
   * disposers without a close frame ever reaching this side. Leaving one open
   * parks the file's afterAll past bun's 5s hook budget on CI's bun (1.3.14),
   * and the failure has no test to name. `terminate` drops each connection
   * with no handshake, which is what a stopped double owes a gone peer.
   */
  disposers.push(async () => {
    for (const socket of [...sockets]) socket.terminate()
    sockets.clear()
    await server.stop(true)
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    received,
    posts,
    protocols,
    closeAll: (code: number, reason: string) => {
      for (const socket of sockets) socket.close(code, reason)
    }
  }
}

/** The app in hybrid cloud mode against the plue double, signed in, with one workspace row of will/flows as the test names it. */
const cloudApp = async (
  plue: ReturnType<typeof startPlue>,
  workspace: { readonly status: "running" | "suspended" | "pending"; readonly lspLanguages?: ReadonlyArray<string> | null } | null,
  signedIn = true
) => {
  const built = await app(
    {
      cloudMode: "hybrid",
      cloudApi: plue.origin,
      cloudAuth: {
        token: () => "smithers_test_token",
        session: () => ({ state: "signed-in" as const, username: "will", expiresAt: null }),
        start: async () => ({ error: "already signed in" }),
        signOut: async () => {},
        stop: async () => {}
      }
    },
    {
      cloudLspSocketUrl: (repo, sessionId, language) =>
        `${built.server.origin.replace(/^http/, "ws")}/api/cloud-ws/repos/${repo}/workspace/sessions/${sessionId}/lsp?language=${language}`
    }
  )
  built.store.dispatch({ type: "cloud.session.loaded", actor: "system", state: signedIn ? "signed-in" : "signed-out", username: signedIn ? "will" : null, expiresAt: null, scopes: null })
  if (workspace !== null) {
    built.store.dispatch({
      type: "workspace.updated",
      actor: "system",
      workspace: {
        id: "ws-1",
        repoId: "will/flows",
        name: "review",
        targetBookmark: "main",
        status: workspace.status,
        provisioningStage: null,
        suspendedAt: null,
        createdAt: null,
        lspLanguages: workspace.lspLanguages === undefined ? ["typescript"] : workspace.lspLanguages === null ? null : [...workspace.lspLanguages]
      }
    })
  }
  return built
}

const X_TS = "import { greet } from \"./greet\"\n"

/** A cloud file card already on screen (a files.read of will/flows answered it), so no contents route is needed. */
const seedCloudCard = (store: AppStore, path = "src/x.ts", content = X_TS): void => {
  store.dispatch({
    type: "card.upsert",
    actor: "smithers",
    card: {
      id: `file-will/flows-${path}`,
      kind: "file",
      title: `File · will/flows · ${path}`,
      status: "active",
      createdAt: 1,
      ordinal: 1,
      payload: { repo: "will/flows", path, content, truncated: false }
    }
  })
}

describe("code-intel seam — a cloud repository (lane L6)", () => {
  test("a running workspace answers hover, diagnostics and definition through its relayed language server, and the card learns each", async () => {
    const plue = startPlue()
    const { store, controller } = await cloudApp(plue, { status: "running" })
    seedCloudCard(store)
    const hover = await controller.commands.run("code.hover", "src/x.ts:1:14 will/flows")
    expect(hover).toEqual({ status: "executed", value: "src/x.ts:1:14 in will/flows\n```typescript\nconst greet: (name: string) => string\n```" })
    const card = fileCard(store, "file-will/flows-src/x.ts")
    expect(card?.payload.intel).toEqual({ state: "ready" })
    expect(card?.payload.hover).toEqual({ line: 1, character: 14, contents: "```typescript\nconst greet: (name: string) => string\n```" })
    expect(CardSchema.safeParse(card).success).toBe(true)
    // plue saw the session POST in its shape, the `lsp` subprotocol, and the transcript: initialize with the guest root, initialized, didOpen with the CARD's text, the hover.
    expect(plue.posts).toEqual([{ workspace_id: "ws-1", kind: "lsp", language: "typescript" }])
    expect(plue.protocols).toEqual(["lsp"])
    expect(plue.received.map((message) => message.method)).toEqual(["initialize", "initialized", "textDocument/didOpen", "textDocument/hover"])
    expect(plue.received[0]!.params).toMatchObject({ rootUri: "file:///home/developer/workspace", workspaceFolders: [{ uri: "file:///home/developer/workspace", name: "workspace" }] })
    expect(plue.received[2]!.params).toEqual({ textDocument: { uri: "file:///home/developer/workspace/src/x.ts", languageId: "typescript", version: 1, text: X_TS } })
    // The publication that followed didOpen already patched the card with no request; diagnostics answers the latest.
    await until(() => (fileCard(store, "file-will/flows-src/x.ts")?.payload.diagnostics ?? []).length === 1, "the published diagnostics")
    const diagnostics = await controller.commands.run("code.diagnostics", "src/x.ts will/flows")
    expect(diagnostics).toEqual({ status: "executed", value: "src/x.ts in will/flows: 1 diagnostic\n1:14 warning 'greet' is declared but its value is never read. (typescript 6133)" })
    // The definition names the checkout-relative target and reports that this fixture's contents route is offline.
    const definition = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "code.definition", args: "src/x.ts:1:10 will/flows" })
    })
    expect(definition).toBe("src/x.ts:1:10 in will/flows is defined at:\nsrc/greet.ts:6:14; the target could not be opened: Smithers Cloud is not reachable from this build (offline mode).")
    expect(fileCard(store, "file-will/flows-src/greet.ts")).toBeUndefined()
    // A close plue sends afterwards is stated on the card, verbatim — never a silent close.
    plue.closeAll(1000, "language_server_idle")
    await until(() => fileCard(store, "file-will/flows-src/x.ts")?.payload.intel?.state === "unavailable", "the close on the card")
    expect(fileCard(store, "file-will/flows-src/x.ts")?.payload.intel).toEqual({ state: "unavailable", note: "the workspace language server closed: language_server_idle (1000)" })
  }, 30_000)

  test("a cloud repository without a running workspace names the act that gets one, on the card and to the model", async () => {
    const plue = startPlue()
    const none = await cloudApp(plue, null)
    seedCloudCard(none.store)
    expect(await none.controller.commands.run("code.hover", "src/x.ts:1:14 will/flows")).toEqual({
      status: "failed",
      error: "Hover and definitions need a running workspace of will/flows — /workspace.open will/flows first."
    })
    expect(fileCard(none.store, "file-will/flows-src/x.ts")?.payload.intel).toEqual({
      state: "unavailable",
      note: "Hover and definitions need a running workspace of will/flows — /workspace.open will/flows first."
    })
    const suspended = await cloudApp(plue, { status: "suspended" })
    seedCloudCard(suspended.store)
    expect(await suspended.controller.commands.run("code.diagnostics", "src/x.ts will/flows")).toEqual({
      status: "failed",
      error: "Hover and definitions need a running workspace of will/flows: \"review\" (ws-1) is suspended — /workspace.resume ws-1 first."
    })
    const pending = await cloudApp(plue, { status: "pending" })
    seedCloudCard(pending.store)
    expect(await pending.controller.commands.run("code.hover", "src/x.ts:1:14 will/flows")).toEqual({
      status: "failed",
      error: "Hover and definitions need a running workspace of will/flows: \"review\" (ws-1) is pending — wait for it to settle (the card tracks it)."
    })
    expect(plue.posts).toEqual([])
  }, 30_000)

  test("a file no relayed language handles is told the DTO's lsp.languages; signed out, the sign-in step", async () => {
    const plue = startPlue()
    const { store, controller } = await cloudApp(plue, { status: "running" })
    seedCloudCard(store, "README.md", "# flows\n")
    expect(await controller.commands.run("code.diagnostics", "README.md will/flows")).toEqual({
      status: "failed",
      error: "No workspace language server handles .md files — \"review\" (ws-1) serves typescript."
    })
    expect(fileCard(store, "file-will/flows-README.md")?.payload.intel).toEqual({
      state: "unavailable",
      note: "No workspace language server handles .md files — \"review\" (ws-1) serves typescript."
    })
    const rustOnly = await cloudApp(plue, { status: "running", lspLanguages: ["rust"] })
    seedCloudCard(rustOnly.store)
    expect(await rustOnly.controller.commands.run("code.hover", "src/x.ts:1:14 will/flows")).toEqual({
      status: "failed",
      error: "No workspace language server handles .ts files — \"review\" (ws-1) serves rust."
    })
    const signedOut = await cloudApp(plue, { status: "running" }, false)
    seedCloudCard(signedOut.store)
    expect(await signedOut.controller.commands.run("code.hover", "src/x.ts:1:14 will/flows")).toEqual({
      status: "failed",
      error: "Sign in to Smithers Cloud first — /cloud.sign-in."
    })
    expect(plue.posts).toEqual([])
  }, 30_000)

  test("plue's 409 language_server_missing reaches the card and the model with the install line verbatim, and nothing redials", async () => {
    const plue = startPlue({ refuseUpgrade: { status: 409, body: { code: "language_server_missing", message: INSTALL, details: { language: "typescript", bin: "typescript-language-server", install: INSTALL, searched: ["/usr/bin"] } } } })
    const { store, controller } = await cloudApp(plue, { status: "running" })
    seedCloudCard(store)
    expect(await controller.commands.run("code.hover", "src/x.ts:1:14 will/flows")).toEqual({
      status: "failed",
      error: `Workspace "review" (ws-1) has no typescript language server. Install: ${INSTALL}`
    })
    expect(fileCard(store, "file-will/flows-src/x.ts")?.payload.intel).toEqual({
      state: "unavailable",
      note: `no typescript language server in workspace "review" (ws-1) — install: ${INSTALL}`
    })
    expect(plue.posts).toHaveLength(1)
  }, 30_000)

  test("a card cut at the cap is refused: the server would see a partial file", async () => {
    const plue = startPlue()
    const { store, controller } = await cloudApp(plue, { status: "running" })
    store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: {
        id: "file-will/flows-src/big.ts",
        kind: "file",
        title: "File · will/flows · src/big.ts",
        status: "active",
        createdAt: 1,
        ordinal: 1,
        payload: { repo: "will/flows", path: "src/big.ts", content: "export {}\n", truncated: true }
      }
    })
    expect(await controller.commands.run("code.hover", "src/big.ts:1:1 will/flows")).toEqual({
      status: "failed",
      error: "src/big.ts in will/flows is larger than the card cap; hover, definitions and diagnostics need the whole file."
    })
    expect(plue.posts).toEqual([])
  }, 30_000)
})

describe.skipIf(skipReason !== undefined)("code-intel seam — against the real typescript-language-server", () => {
  let repo: Repo
  let store: AppStore
  let controller: AppController
  const cardId = (path: string): string => `file-${repo.id}-${path}`

  beforeAll(async () => {
    ;({ repo, store, controller } = await app())
  })

  test("/code.hover answers the type as { value } and patches the open file card's hover", async () => {
    valueOf(await controller.commands.run("files.read", "src/index.ts"))
    const value = valueOf(await controller.commands.run("code.hover", "src/index.ts:3:7"))
    expect(value).toStartWith(`src/index.ts:3:7 in ${repo.name}\n`)
    expect(value).toContain("const message: string")
    const card = fileCard(store, cardId("src/index.ts"))
    expect(card?.payload.hover).toEqual({ line: 3, character: 7, contents: expect.stringContaining("const message: string") })
    expect(card?.payload.intel).toEqual({ state: "ready" })
    // The read's own fields survive the patch: the card is the same card.
    expect(card?.payload.content).toContain("message.lenght")
    expect(card?.payload.line).toBeUndefined()
    expect(CardSchema.safeParse(card).success).toBe(true)
  }, 30_000)

  test("a position the server has nothing for is stated, and the card's hover is cleared to null", async () => {
    const value = valueOf(await controller.commands.run("code.hover", "src/index.ts:2:1"))
    expect(value).toBe(`The language server has nothing at src/index.ts:2:1 in ${repo.name}.`)
    expect(fileCard(store, cardId("src/index.ts"))?.payload.hover).toBeNull()
  }, 30_000)

  test("hover on a file with no card renders the file card at the position first", async () => {
    expect(store.collections.cards.get(cardId("src/greet.ts"))).toBeUndefined()
    const value = valueOf(await controller.commands.run("code.hover", "src/greet.ts:6:14"))
    expect(value).toContain("const greet:")
    const card = fileCard(store, cardId("src/greet.ts"))
    expect(card?.payload).toMatchObject({ path: "src/greet.ts", line: 6, column: 14, intel: { state: "ready" } })
    expect(card?.payload.hover?.contents).toContain("const greet:")
  }, 30_000)

  test("/code.definition answers path:line:col and opens the target file card at its line", async () => {
    const value = valueOf(await controller.commands.run("code.definition", "src/index.ts:3:17"))
    expect(value).toBe(`src/index.ts:3:17 in ${repo.name} is defined at:\nsrc/greet.ts:6:14`)
    const target = fileCard(store, cardId("src/greet.ts"))
    expect(target?.payload).toMatchObject({ path: "src/greet.ts", line: 6, column: 14 })
    expect(target?.payload.content).toContain("export const greet")
    // A symbol with no definition is stated, not invented.
    expect(valueOf(await controller.commands.run("code.definition", "src/index.ts:2:1"))).toBe(
      `No definition found for src/index.ts:2:1 in ${repo.name}.`
    )
  }, 30_000)

  test("/code.diagnostics answers the rows and patches the card; a /ws publication then patches it with no request", async () => {
    /*
     * The route answers the server's latest publication for the file, and
     * tsserver publishes in passes (syntactic, semantic, suggestions), so the
     * deliberate error is awaited across calls rather than pinned to the
     * first answer; the shape of the answer is what is asserted.
     */
    let value = ""
    const deadline = Date.now() + 10_000
    while (!value.includes("2551")) {
      if (Date.now() > deadline) throw new Error(`the deliberate diagnostic never arrived; last answer: ${value}`)
      value = valueOf(await controller.commands.run("code.diagnostics", "src/index.ts"))
    }
    expect(value.split("\n")[0]).toMatch(/^src\/index\.ts in .+: \d+ diagnostics?$/)
    expect(value).toContain(` in ${repo.name}: `)
    expect(value).toContain("4:24 error Property 'lenght' does not exist on type 'string'. Did you mean 'length'? (typescript 2551)")
    const card = fileCard(store, cardId("src/index.ts"))
    expect(card?.payload.intel).toEqual({ state: "ready" })
    expect(card?.payload.diagnostics?.find((item) => item.code === "2551")).toMatchObject({ line: 4, character: 24, severity: "error" })
    // A second error lands on disk; a hover re-reads the file, the server publishes, and the
    // subscription on lsp:<repoId> patches the card's diagnostics — code.diagnostics never ran again.
    const indexPath = join(repoDir, "src", "index.ts")
    await writeFile(indexPath, `${await Bun.file(indexPath).text()}const other: number = "x"\n`)
    valueOf(await controller.commands.run("code.hover", "src/index.ts:3:7"))
    const codes = (): ReadonlyArray<string | undefined> => (fileCard(store, cardId("src/index.ts"))?.payload.diagnostics ?? []).map((item) => item.code)
    await until(() => codes().includes("2322"), "the published diagnostics")
    // The publication is what the server said, hints included ('other' is declared but never read), never a filtered copy.
    expect(codes()).toEqual(expect.arrayContaining(["2551", "2322"]))
    expect(fileCard(store, cardId("src/index.ts"))?.payload.diagnostics?.find((item) => item.code === "2322")).toMatchObject({ line: 8, severity: "error" })
    expect(CardSchema.safeParse(fileCard(store, cardId("src/index.ts"))).success).toBe(true)
  }, 30_000)

  test("an answer about newer text re-reads the card in place — same id, ordinal and anchor — before it lands", async () => {
    valueOf(await controller.commands.run("files.read", "src/greet.ts:6:14"))
    const before = fileCard(store, cardId("src/greet.ts"))
    if (before === undefined) throw new Error("no card")
    expect(before.payload.digest).toMatch(/^[0-9a-f]{64}$/)
    // The file changes on disk under the card (a harness tab edited it); the next act sees the new text.
    const greetPath = join(repoDir, "src", "greet.ts")
    await writeFile(greetPath, `${await Bun.file(greetPath).text()}// edited after the read\n`)
    const value = valueOf(await controller.commands.run("code.hover", "src/greet.ts:6:14"))
    expect(value).toContain("const greet:")
    const after = fileCard(store, cardId("src/greet.ts"))
    expect(after?.payload.content).toContain("// edited after the read")
    expect(after?.payload.digest).not.toBe(before.payload.digest)
    expect(after?.ordinal).toBe(before.ordinal)
    expect(after?.payload).toMatchObject({ line: 6, column: 14, hover: { line: 6, character: 14 } })
    expect(CardSchema.safeParse(after).success).toBe(true)
  }, 30_000)

  test("a definition the server found outside the repository is stated as that, on the card and to the model — never 'no definition found'", async () => {
    await writeFile(join(repoDir, "src", "len.ts"), "export const n = \"abc\".length\n")
    // `length` on a string literal lives in lib.es5.d.ts under the linked node_modules/typescript, outside the checkout.
    const value = valueOf(await controller.commands.run("code.definition", "src/len.ts:1:24"))
    expect(value).toMatch(/^src\/len\.ts:1:24 in .+ is defined outside the repository \(\d+ locations? not openable here\)\.$/)
    expect(value).not.toContain("No definition found")
    const card = fileCard(store, cardId("src/len.ts"))
    expect(card?.payload.intel?.state).toBe("ready")
    expect(card?.payload.intel?.note).toMatch(/^Definition of src\/len\.ts:1:24: outside the repository \(\d+ locations? not openable here\)$/)
    expect(CardSchema.safeParse(card).success).toBe(true)
  }, 30_000)

  test("a publication past the host's cap is stated as a count of the total, on the card and to the model", async () => {
    await writeFile(join(repoDir, "src", "many.ts"), Array.from({ length: 60 }, (_line, index) => `export const a${index}: number = "x"`).join("\n") + "\n")
    let value = ""
    const deadline = Date.now() + 15_000
    // tsserver publishes in passes; the semantic pass is the one with the 60 errors.
    while (!/60 diagnostics/.test(value)) {
      if (Date.now() > deadline) throw new Error(`the capped publication never arrived; last answer: ${value.split("\n")[0]}`)
      value = valueOf(await controller.commands.run("code.diagnostics", "src/many.ts"))
    }
    expect(value.split("\n")[0]).toBe(`src/many.ts in ${repo.name}: 60 diagnostics (first 50 shown)`)
    expect(value.split("\n")).toHaveLength(51)
    const card = fileCard(store, cardId("src/many.ts"))
    expect(card?.payload.diagnostics).toHaveLength(50)
    expect(card?.payload.diagnosticsTotal).toBe(60)
    expect(CardSchema.safeParse(card).success).toBe(true)
  }, 30_000)

  test("the agent door: the tool call answers the hover text, never a bare executed", async () => {
    const previous = new Set(store.collections.transitions.keys())
    const result = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "code.hover", args: "src/index.ts:3:7" })
    })
    expect(result).toContain("const message: string")
    expect(result).not.toStartWith("executed")
    expect(result).not.toStartWith("failed")
    const edits = [...store.collections.transitions.values()].filter((row) => !previous.has(row.id) && row.type.startsWith("card.") && row.actor !== "system")
    expect(edits.length).toBeGreaterThan(0)
    expect(edits.every((row) => row.actor === "smithers")).toBe(true)
  }, 30_000)
})
