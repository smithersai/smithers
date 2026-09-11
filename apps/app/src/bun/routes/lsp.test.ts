import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LSP_DEFINITION_PATH,
  LSP_DIAGNOSTICS_PATH,
  LSP_HOVER_PATH,
  LSP_LANGUAGE_SERVER_MISSING,
  LSP_REQUEST_BODY_CAP_BYTES,
  LSP_SERVERS_PATH,
  LspDefinitionResponseSchema,
  LspDiagnosticsMessageSchema,
  LspDiagnosticsResponseSchema,
  LspErrorResponseSchema,
  LspHoverResponseSchema,
  LspServersResponseSchema,
  lspTopic
} from "@smthrs/rpc/LocalApp"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { resolveServer, TYPESCRIPT_SERVER } from "../lsp/LanguageServers"
import { emptyLookup, writeFixtureProject } from "../lsp/LspFixture"
import { createLspHost, defaultServerLookup } from "../lsp/LspHost"
import { findNode } from "../Node"
import { startLocalServer } from "../server"
import type { LocalServer } from "../server"

/*
 * `/api/lsp/*` over a real local origin against the real
 * typescript-language-server: the fixture repository is opened through
 * `/api/repo/open`, hover and definition answer their typed bodies,
 * diagnostics answer and ride `/ws` on `lsp:<repoId>`, and closing the
 * repository ends its server. The missing-server door runs against a host
 * whose lookup finds nothing (no process is spawned for it).
 */

const node = await findNode()
const resolved = resolveServer(TYPESCRIPT_SERVER, defaultServerLookup(), node)
const skipReason = node === null
  ? "no Node.js >= 22.19 on this machine to run the language server"
  : "missing" in resolved
  ? `no typescript-language-server on this machine (install: ${resolved.missing})`
  : undefined
if (skipReason !== undefined) console.warn(`lsp route tests skipped: ${skipReason}`)

let dist = ""
let repoDir = ""
let readOnlyDir = ""
let server: LocalServer
let repoId = ""

const post = (path: string, body: unknown, init: RequestInit = {}): Promise<Response> =>
  fetch(`${server.origin}${path}`, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: server.sessionToken, ...(init.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

const get = (path: string): Promise<Response> =>
  fetch(`${server.origin}${path}`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-lsp-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  repoDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-repo-")))
  await writeFixtureProject(repoDir)
  readOnlyDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-readonly-")))
  await cp(repoDir, readOnlyDir, { recursive: true, force: true })
  // The picker grant (the native door) inspects a Git repository; the manual path door above does not.
  expect(await Bun.spawn(["git", "init", "-q", readOnlyDir]).exited).toBe(0)
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    allowManualRepositoryPaths: true,
    node,
    home: tmpdir(),
    log: () => {}
  })
  const opened = await post("/api/repo/open", { path: repoDir })
  expect(opened.status).toBe(200)
  repoId = ((await opened.json()) as { repo: { id: string } }).repo.id
})

afterAll(async () => {
  await server?.stop()
  await rm(dist, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  await rm(readOnlyDir, { recursive: true, force: true })
})

describe("/api/lsp refusals that never reach a server", () => {
  test("the session header gates every route", async () => {
    expect((await fetch(`${server.origin}${LSP_SERVERS_PATH}`)).status).toBe(401)
  })

  test("a malformed body, an unknown repository, a traversal and a file no server handles are refused with typed codes", async () => {
    const malformed = await post(LSP_HOVER_PATH, { repoId, path: "src/index.ts", line: 0, character: 1 })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe("invalid_request")
    const extra = await post(LSP_HOVER_PATH, { repoId, path: "src/index.ts", line: 1, character: 1, content: "x" })
    expect(extra.status).toBe(400)
    const unknown = await post(LSP_HOVER_PATH, { repoId: "nope", path: "src/index.ts", line: 1, character: 1 })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("repo_not_found")
    const unsupported = await post(LSP_DIAGNOSTICS_PATH, { repoId, path: "README.md" })
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toEqual({ error: { code: "language_unsupported", message: "No language server handles .md files." } })
    const notJson = await post(LSP_HOVER_PATH, "{", { headers: { "content-type": "text/plain" } })
    expect(notJson.status).toBe(415)
  })

  test("a body past the cap answers 413", async () => {
    const body = JSON.stringify({ repoId, path: "x".repeat(LSP_REQUEST_BODY_CAP_BYTES) })
    const large = await post(LSP_DIAGNOSTICS_PATH, body)
    expect(large.status).toBe(413)
    expect(((await large.json()) as { error: { code: string } }).error.code).toBe("body_too_large")
  })

  test("a missing language server answers 409 with the install line verbatim, and starts nothing", async () => {
    const bare = await startLocalServer({
      port: 0,
      distDir: dist,
      chatStub: true,
      allowManualRepositoryPaths: true,
      node,
      home: tmpdir(),
      lsp: (deps) => createLspHost({ ...deps, lookup: emptyLookup(tmpdir()) }),
      log: () => {}
    })
    try {
      const headers = { "content-type": "application/json", [LOCAL_SESSION_HEADER]: bare.sessionToken }
      const opened = await fetch(`${bare.origin}/api/repo/open`, { method: "POST", headers, body: JSON.stringify({ path: repoDir }) })
      const bareRepoId = ((await opened.json()) as { repo: { id: string } }).repo.id
      const refused = await fetch(`${bare.origin}${LSP_HOVER_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ repoId: bareRepoId, path: "src/index.ts", line: 3, character: 7 })
      })
      expect(refused.status).toBe(409)
      const body = LspErrorResponseSchema.parse(await refused.json())
      expect(body.error).toEqual({
        code: LSP_LANGUAGE_SERVER_MISSING,
        message: "No TypeScript language server on this machine.",
        install: "npm i -g typescript-language-server typescript"
      })
      const servers = await fetch(`${bare.origin}${LSP_SERVERS_PATH}`, { headers })
      expect(await servers.json()).toEqual({ servers: [] })
    } finally {
      await bare.stop()
    }
  })
})

describe.skipIf(skipReason !== undefined)("/api/lsp against the real typescript-language-server", () => {
  test("POST /api/lsp/hover answers the type at a 1-based position", async () => {
    const response = await post(LSP_HOVER_PATH, { repoId, path: "src/index.ts", line: 3, character: 7 })
    expect(response.status).toBe(200)
    const body = LspHoverResponseSchema.parse(await response.json())
    expect(body.hover?.contents).toContain("const message: string")
    expect(body.hover?.range).toEqual({ line: 3, character: 7, endLine: 3, endCharacter: 14 })
    const servers = LspServersResponseSchema.parse(await (await get(LSP_SERVERS_PATH)).json())
    expect(servers.servers).toEqual([{ repoId, language: "typescript", state: "ready" }])
  }, 20_000)

  test("POST /api/lsp/definition answers repository-relative locations", async () => {
    const response = await post(LSP_DEFINITION_PATH, { repoId, path: "src/index.ts", line: 3, character: 17 })
    expect(response.status).toBe(200)
    const body = LspDefinitionResponseSchema.parse(await response.json())
    expect(body.locations).toEqual([{ path: "src/greet.ts", line: 6, character: 14, endLine: 6, endCharacter: 19 }])
  }, 20_000)

  test("POST /api/lsp/diagnostics answers the publication, and /ws carries the same frame on lsp:<repoId>", async () => {
    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("ws failed"))
    })
    const frames: Array<unknown> = []
    socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)))
    socket.send(JSON.stringify({ type: "subscribe", topic: lspTopic(repoId) }))
    while (!frames.some((frame) => (frame as { type?: string }).type === "subscribed")) await Bun.sleep(10)
    try {
      // Touch the file so the server publishes again for a subscriber that arrived after the first publication.
      await writeFile(join(repoDir, "src", "index.ts"), `${await Bun.file(join(repoDir, "src", "index.ts")).text()}\n`)
      const response = await post(LSP_DIAGNOSTICS_PATH, { repoId, path: "src/index.ts" })
      expect(response.status).toBe(200)
      const body = LspDiagnosticsResponseSchema.parse(await response.json())
      expect(body.path).toBe("src/index.ts")
      const deadline = Date.now() + 5000
      const published = () => frames.map((frame) => LspDiagnosticsMessageSchema.safeParse(frame)).filter((parsed) => parsed.success).map((parsed) => parsed.data)
      // The server publishes syntax, semantic and suggestion results as they
      // arrive. The first publication can be empty; await the semantic result
      // for this exact revision before checking the route's latest cache.
      const semantic = () => published().find((frame) => frame.path === body.path && frame.digest === body.digest && frame.items.some((item) => item.code === "2551"))
      while (semantic() === undefined) {
        if (Date.now() > deadline) throw new Error(`no semantic lsp.diagnostics frame: ${JSON.stringify(frames)}`)
        await Bun.sleep(25)
      }
      const latest = LspDiagnosticsResponseSchema.parse(await (await post(LSP_DIAGNOSTICS_PATH, { repoId, path: body.path })).json())
      expect(latest.items?.map((item) => item.code)).toEqual(["2551"])
      expect(semantic()).toMatchObject({ type: "lsp.diagnostics", repoId, path: body.path, digest: latest.digest, items: latest.items })
    } finally {
      socket.close()
    }
  }, 20_000)

  test("read access suffices: a repository opened read-only answers hover", async () => {
    const selected = await server.authorizeRepository(readOnlyDir, "read")
    expect(selected.status).toBe("connected")
    if (selected.status !== "connected") return
    const opened = await post("/api/repo/open", { authorizationId: selected.repository.authorizationId })
    expect(opened.status).toBe(200)
    const readOnlyId = ((await opened.json()) as { repo: { id: string } }).repo.id
    const response = await post(LSP_HOVER_PATH, { repoId: readOnlyId, path: "src/index.ts", line: 3, character: 7 })
    expect(response.status).toBe(200)
    expect(LspHoverResponseSchema.parse(await response.json()).hover?.contents).toContain("const message: string")
    const servers = LspServersResponseSchema.parse(await (await get(LSP_SERVERS_PATH)).json())
    expect(servers.servers.map((row) => row.repoId).sort()).toEqual([repoId, readOnlyId].sort())
    // Closing the repository ends its server and only its server.
    expect((await post("/api/repo/close", { repoId: readOnlyId })).status).toBe(200)
    const after = LspServersResponseSchema.parse(await (await get(LSP_SERVERS_PATH)).json())
    expect(after.servers).toEqual([{ repoId, language: "typescript", state: "ready" }])
  }, 30_000)
})
