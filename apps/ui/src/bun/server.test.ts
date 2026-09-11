import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { REPO_FILE_READ_CAP_BYTES, REPO_LISTING_CAP_ENTRIES } from "@smthrs/rpc/LocalApp"
import { decodeAgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { LOCAL_SESSION_HEADER, LOCAL_SESSION_META } from "@smthrs/rpc/LocalSession"
import { createPtyManager } from "./Pty"
import { defaultDistDir, describeCookie, rescopeCookie, startLocalServer } from "./server"
import type { LocalServer } from "./server"

let dist = ""
let server: LocalServer
const logs: Array<string> = []

const apiFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set(LOCAL_SESSION_HEADER, server.sessionToken)
  return fetch(`${server.origin}${path}`, { ...init, headers })
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-dist-"))
  await mkdir(join(dist, "assets"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title><div id=\"root\"></div>")
  await writeFile(join(dist, "assets", "app.js"), "console.log('hi')")
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    node: { path: "/fake/node", version: "v22.19.0" },
    home: "/fake/home",
    harnesses: async () => [
      {
        id: "claude",
        displayName: "Claude Code",
        binary: "/opt/homebrew/bin/claude",
        version: "2.1.0",
        status: "signed-in",
        account: { email: "will@codeplane.app" },
        launch: { argv: ["claude"] }
      }
    ],
    pty: (deps) =>
      createPtyManager({
        ...deps,
        // A plain shell with the sandbox off: the seatbelt profile is Sandbox.test.ts's subject.
        shell: "/bin/sh",
        home: dist,
        env: {},
        sandboxHost: { platform: "linux", disabled: true, log: () => {} },
        killGraceMs: 300,
        log: () => {}
      }),
    log: (line) => logs.push(line),
    allowManualRepositoryPaths: true
  })
})

afterAll(async () => {
  await server.stop()
  await rm(dist, { recursive: true, force: true })
})

const readFrames = async (response: Response): Promise<Array<AgentTurnFrame>> => {
  const text = await response.text()
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const parsed: unknown = JSON.parse(line)
    const frame = decodeAgentTurnFrame(parsed)
    if (frame === null) throw new Error(`not a frame: ${line}`)
    return frame
  })
}

describe("the local origin", () => {
  test("prints SMITHERS_LOCAL_ORIGIN when listening and binds 127.0.0.1", () => {
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`)
    expect(logs).toContain(`SMITHERS_LOCAL_ORIGIN=${server.origin}`)
  })

  test("the request trail elides the Linear setup key from its path", async () => {
    /* Sync review finding 8: the one-time setup key rode the trail line on every connect. */
    const response = await apiFetch("/api/cloud/api/linear/setup/sk-secret-123")
    await response.text()
    expect(logs.some((line) => line.includes("GET /api/cloud/api/linear/setup/<setup-key> ->"))).toBe(true)
    expect(logs.some((line) => line.includes("sk-secret-123"))).toBe(false)
  })

  test("GET /api/health reports node and sandbox", async () => {
    const response = await fetch(`${server.origin}/api/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.pid).toBe(process.pid)
    expect(body.node).toEqual({ path: "/fake/node", version: "v22.19.0" })
    expect(body.home).toBe("/fake/home")
    expect(body.sandbox).toEqual({
      platform: process.platform,
      enforced: process.platform === "darwin" && Bun.env.SMITHERS_SANDBOX !== "off"
    })
  })

  test("the bootstrap reports per-policy enforcement: a non-darwin host enforces neither the loader nor target runs", async () => {
    /* ui-bun-host/security/4: "trusted-only" alone read as if the loader policy applied. */
    const linux = await startLocalServer({
      port: 0,
      distDir: dist,
      chatStub: true,
      node: { path: "/fake/node", version: "v22.19.0" },
      home: "/fake/home",
      harnesses: async () => [],
      sandboxHost: { platform: "linux", disabled: false, log: () => {} },
      log: () => {}
    })
    try {
      const bootstrap = (await (await fetch(`${linux.origin}/api/bootstrap`, {
        headers: { [LOCAL_SESSION_HEADER]: linux.sessionToken }
      })).json()) as { sandbox: unknown }
      expect(bootstrap.sandbox).toEqual({
        platform: process.platform,
        mode: "trusted-only",
        policies: { loader: "unenforced", targetRun: "unenforced" }
      })
    } finally {
      await linux.stop()
    }
  })

  test("serves the SPA with an index.html fallback and hashed assets", async () => {
    const root = await fetch(`${server.origin}/`)
    expect(root.status).toBe(200)
    const html = await root.text()
    expect(html).toContain("<div id=\"root\">")
    expect(html).toContain(`<meta name="${LOCAL_SESSION_META}" content="${server.sessionToken}">`)
    const deep = await fetch(`${server.origin}/some/client/route`)
    expect(deep.status).toBe(200)
    expect(deep.headers.get("content-type")).toContain("text/html")
    const asset = await fetch(`${server.origin}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(await asset.text()).toBe("console.log('hi')")
  })

  test("refuses path traversal out of dist", async () => {
    const response = await fetch(`${server.origin}/assets/..%2F..%2F..%2Fetc%2Fpasswd`)
    // Either the fallback document or nothing: never a file outside dist.
    expect(await response.text()).not.toContain("root:")
  })

  test("a malformed percent-encoding answers the envelope with a trail line, and a dotted directory falls back to the SPA", async () => {
    const staticPath = await fetch(`${server.origin}/%E0%A4%A`)
    expect(staticPath.status).toBe(400)
    expect(staticPath.headers.get("content-type")).toContain("application/json")
    expect(await staticPath.json()).toEqual({
      error: { code: "invalid_path", message: "Request path is not valid percent-encoded UTF-8." }
    })
    const before = logs.length
    const routed = await apiFetch("/api/agents/%E0%A4%A", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}"
    })
    expect(routed.status).toBe(400)
    expect(((await routed.json()) as { error: { code: string } }).error.code).toBe("invalid_path")
    // A path that never reaches a handler still leaves its line.
    expect(logs.slice(before).some((line) => /^PUT \/api\/agents\/%E0%A4%A -> 400 in \d+ms$/.test(line))).toBe(true)
    // `Bun.file(<directory>)` throws EISDIR, and a dotted name looks like a file.
    await mkdir(join(dist, "docs.d"), { recursive: true })
    const dotted = await fetch(`${server.origin}/docs.d/`)
    expect(dotted.status).toBe(200)
    expect(dotted.headers.get("content-type")).toContain("text/html")
  })

  test("unknown /api paths answer a JSON 404, method mismatches a 405", async () => {
    const missing = await apiFetch("/api/nope")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "No route for GET /api/nope." } })
    const wrongMethod = await apiFetch("/api/health", { method: "POST" })
    expect(wrongMethod.status).toBe(405)
  })

  test("privileged HTTP rejects missing capabilities, foreign origins, bad hosts, and non-JSON writes", async () => {
    expect((await fetch(`${server.origin}/api/repos`)).status).toBe(401)
    expect((await apiFetch("/api/repos", { headers: { origin: "https://evil.test" } })).status).toBe(403)
    expect((await fetch(`${server.origin}/`, { headers: { host: "evil.test" } })).status).toBe(421)
    const plain = await apiFetch("/api/repo/open", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ path: "/tmp" })
    })
    expect(plain.status).toBe(415)
  })

  test("GET /api/harnesses answers the detector's table", async () => {
    const body = (await (await apiFetch("/api/harnesses")).json()) as { harnesses: Array<{ id: string; status: string }> }
    expect(body.harnesses).toHaveLength(1)
    expect(body.harnesses[0]).toMatchObject({ id: "claude", status: "signed-in", account: { email: "will@codeplane.app" } })
  })

  test("both lanes' real routes replaced every placeholder: repos answers its empty state", async () => {
    expect(await (await apiFetch("/api/repos")).json()).toEqual({ repos: [] })
  })

  test("a lane replaces a placeholder by registering the same route", async () => {
    server.router.add("GET", "/api/repos", () => Response.json({ repos: [{ id: "force" }] }))
    expect(await (await apiFetch("/api/repos")).json()).toEqual({ repos: [{ id: "force" }] })
    server.router.add("GET", "/api/repos", () => Response.json({ repos: [] }))
  })

  test("the PTY routes open, list, resize, echo over /ws, and delete a session", async () => {
    const bad = await apiFetch("/api/pty", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "terminal" }) })
    expect(bad.status).toBe(400)
    const missingHarness = await apiFetch("/api/pty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "harness", cols: 80, rows: 24 })
    })
    expect(missingHarness.status).toBe(400)

    const created = await apiFetch("/api/pty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "terminal", cols: 80, rows: 24 })
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    expect(sessionId).toMatch(/^pty-/)
    const listed = (await (await apiFetch("/api/pty")).json()) as { sessions: Array<Record<string, unknown>> }
    expect(listed.sessions.map((session) => session.sessionId)).toEqual([sessionId])
    expect(listed.sessions[0]).toMatchObject({ kind: "terminal", alive: true, cwd: dist })

    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("ws failed"))
    })
    const output: Array<string> = []
    let exit: unknown
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; data?: string }
      if (frame.type === "pty.output") output.push(frame.data ?? "")
      if (frame.type === "pty.exit") exit = frame
    }
    socket.send(JSON.stringify({ type: "subscribe", topic: `pty:${sessionId}` }))
    socket.send(JSON.stringify({ type: "pty.input", sessionId, data: "echo hi-from-pty\n" }))
    const deadline = Date.now() + 5000
    while (!/hi-from-pty\r?\n/.test(output.join("").replace(/echo hi-from-pty/g, ""))) {
      if (Date.now() > deadline) throw new Error(`no echo: ${JSON.stringify(output)}`)
      await Bun.sleep(25)
    }

    // tab.read's seam: the tail of the session's scrollback as plain text.
    const read = await apiFetch(`/api/pty/${sessionId}/output?tail=4096`)
    expect(read.status).toBe(200)
    const tail = (await read.json()) as { sessionId: string; alive: boolean; output: string; truncated: boolean }
    expect(tail.sessionId).toBe(sessionId)
    expect(tail.alive).toBe(true)
    expect(tail.output).toContain("hi-from-pty")
    expect(tail.output).not.toContain("\u001b")
    expect((await apiFetch(`/api/pty/${sessionId}/output?tail=-1`)).status).toBe(400)
    expect((await apiFetch(`/api/pty/${sessionId}/output?tail=9007199254740992`)).status).toBe(400)
    expect((await apiFetch("/api/pty/nope/output")).status).toBe(404)

    const resized = await apiFetch(`/api/pty/${sessionId}/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 120, rows: 40 })
    })
    expect(await resized.json()).toEqual({ ok: true })
    expect((await apiFetch("/api/pty/nope/resize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 1, rows: 1 })
    })).status).toBe(404)

    const deleted = await apiFetch(`/api/pty/${sessionId}`, { method: "DELETE" })
    expect(await deleted.json()).toEqual({ ok: true })
    const exitDeadline = Date.now() + 5000
    while (exit === undefined) {
      if (Date.now() > exitDeadline) throw new Error("no exit frame")
      await Bun.sleep(25)
    }
    expect(exit).toMatchObject({ type: "pty.exit", sessionId })
    expect(((await (await apiFetch("/api/pty")).json()) as { sessions: Array<unknown> }).sessions).toEqual([])
    expect((await apiFetch(`/api/pty/${sessionId}`, { method: "DELETE" })).status).toBe(404)
    socket.close()
  })

  test("the OAuth legs are navigations: no session header, yet never 401", async () => {
    // A top-level navigation (window.location, the system browser from the
    // native handoff) cannot carry the local-session header; gating these
    // two on it answered 401 to every sign-in attempt from this origin.
    for (const path of ["/api/auth/github/start?handoff=abc", "/api/auth/github/callback?code=1&state=2"]) {
      const response = await fetch(`${server.origin}${path}`, { redirect: "manual" })
      expect(response.status).not.toBe(401)
      expect(response.status).toBe(501) // the stub seam: reached, and honest about being stubbed
    }
    // Everything else under /api/ still needs the capability.
    expect((await fetch(`${server.origin}/api/auth/session`)).status).toBe(401)
    expect((await fetch(`${server.origin}/api/auth/github/start`, { method: "POST" })).status).toBe(401)
  })

  test("a proxied ready claim re-scopes the session cookie and the trail says the cookie was there", async () => {
    // A fake identity upstream: the claim answers ready with a Domain-scoped session cookie.
    const upstreamHeaders: Array<Headers> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (upstreamHeaders.push(request.headers), new URL(request.url).pathname === "/api/auth/native/claim")
          ? new Response(JSON.stringify({ status: "ready" }), {
            headers: {
              "content-type": "application/json",
              "set-cookie": "smithers_session=sealed; Domain=identity.test; Path=/; HttpOnly; Secure; SameSite=Lax"
            }
          })
          : new Response("{}", { status: 404, headers: { "content-type": "application/json" } })
    })
    const proxyLogs: Array<string> = []
    const proxied = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      identityUpstream: `http://127.0.0.1:${upstream.port}`,
      node: { path: "/fake/node", version: "v22.19.0" },
      home: "/fake/home",
      harnesses: async () => [],
      log: (line) => proxyLogs.push(line)
    })
    try {
      const response = await fetch(`${proxied.origin}/api/auth/native/claim`, {
        method: "POST",
        headers: {
          [LOCAL_SESSION_HEADER]: proxied.sessionToken,
          origin: proxied.origin,
          "content-type": "application/json"
        },
        body: JSON.stringify({ handoffId: "h", pollSecret: "s" })
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "ready" })
      const cookie = response.headers.getSetCookie()[0] ?? ""
      expect(cookie.startsWith("smithers_session=sealed")).toBe(true)
      expect(cookie.toLowerCase()).not.toContain("domain=")
      // WebKit refuses a Secure cookie set over http://127.0.0.1; every other attribute survives.
      expect(cookie.toLowerCase()).not.toContain("secure")
      expect(cookie).toContain("Path=/")
      expect(cookie).toContain("HttpOnly")
      expect(cookie).toContain("SameSite=Lax")
      // The trail names the attributes the WebView was handed, never the value.
      expect(proxyLogs).toContain(
        "/api/auth/native/claim -> 200, set-cookie present: smithers_session=<redacted>; Path=/; HttpOnly; SameSite=Lax"
      )
      expect(proxyLogs.join("\n")).not.toContain("sealed")
      // The local session capability authorizes this origin only; the seam never receives it.
      expect(upstreamHeaders).toHaveLength(1)
      expect(upstreamHeaders[0]?.get(LOCAL_SESSION_HEADER)).toBeNull()
      expect(upstreamHeaders[0]?.get("origin")).toBe(`http://127.0.0.1:${upstream.port}`)
    } finally {
      await proxied.stop()
      upstream.stop(true)
    }
  })

  test("rescopeCookie drops Domain and Secure wherever they sit and leaves the rest", () => {
    expect(rescopeCookie("s=v; Domain=identity.test; Path=/; HttpOnly; Secure; SameSite=Lax"))
      .toBe("s=v; Path=/; HttpOnly; SameSite=Lax")
    expect(rescopeCookie("s=v; Path=/; secure")).toBe("s=v; Path=/")
    expect(rescopeCookie("s=v; Secure; Path=/")).toBe("s=v; Path=/")
    // Only the attribute goes: a name or value that merely contains the word stays.
    expect(rescopeCookie("secure_id=insecure; Path=/; SecureFlag=1")).toBe("secure_id=insecure; Path=/; SecureFlag=1")
    expect(describeCookie("smithers_session=sealed-secret; Path=/; HttpOnly")).toBe(
      "smithers_session=<redacted>; Path=/; HttpOnly"
    )
  })

  test("every / and /api request leaves a status-and-duration trail line", async () => {
    const before = logs.length
    const response = await fetch(`${server.origin}/api/health`)
    expect(response.status).toBe(200)
    expect(logs.slice(before).some((line) => /^GET \/api\/health -> 200 in \d+ms$/.test(line))).toBe(true)
  })

  test("an opened repository is remembered and reopened by the next launch with the same access; closing forgets it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "smithers-state-"))
    const repoDir = await mkdtemp(join(tmpdir(), "smithers-remembered-repo-"))
    await writeFile(join(repoDir, "README.md"), "# remembered\n")
    const boot = () =>
      startLocalServer({
        port: 0,
        distDir: dist,
        chatStub: true,
        stateDir,
        node: { path: "/fake/node", version: "v22.19.0" },
        home: "/fake/home",
        harnesses: async () => [],
        log: () => {},
        allowManualRepositoryPaths: true
      })
    const first = await boot()
    let second: LocalServer | undefined
    try {
      const opened = await fetch(`${first.origin}/api/repo/open`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: first.sessionToken, "content-type": "application/json" },
        body: JSON.stringify({ path: repoDir })
      })
      expect(opened.status).toBe(200)
      const { repo } = (await opened.json()) as { repo: { id: string; path: string } }
      await first.stop()
      // The next launch lists it before it serves anything.
      second = await boot()
      const listed = (await (await fetch(`${second.origin}/api/repos`, { headers: { [LOCAL_SESSION_HEADER]: second.sessionToken } })).json()) as { repos: Array<{ id: string; path: string }> }
      expect(listed.repos.map((entry) => entry.path)).toEqual([repo.path])
      // The remembered grant carries its access: a read of the reopened repository works.
      const files = await fetch(`${second.origin}/api/repo/files`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: second.sessionToken, "content-type": "application/json" },
        body: JSON.stringify({ repoId: listed.repos[0]!.id, path: "README.md" })
      })
      expect(files.status).toBe(200)
      // Closing forgets it for the launch after.
      const closed = await fetch(`${second.origin}/api/repo/close`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: second.sessionToken, "content-type": "application/json" },
        body: JSON.stringify({ repoId: listed.repos[0]!.id })
      })
      expect(closed.status).toBe(200)
      await second.stop()
      second = await boot()
      const after = (await (await fetch(`${second.origin}/api/repos`, { headers: { [LOCAL_SESSION_HEADER]: second.sessionToken } })).json()) as { repos: Array<unknown> }
      expect(after.repos).toEqual([])
    } finally {
      await second?.stop()
      await rm(stateDir, { recursive: true, force: true })
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("a remembered path that no longer exists is dropped, not an error", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "smithers-state-"))
    await writeFile(join(stateDir, "repositories.json"), JSON.stringify({ repositories: [{ path: join(stateDir, "gone"), access: "read-write" }] }))
    const booted = await startLocalServer({
      port: 0,
      distDir: dist,
      chatStub: true,
      stateDir,
      node: { path: "/fake/node", version: "v22.19.0" },
      home: "/fake/home",
      harnesses: async () => [],
      log: () => {}
    })
    try {
      const listed = (await (await fetch(`${booted.origin}/api/repos`, { headers: { [LOCAL_SESSION_HEADER]: booted.sessionToken } })).json()) as { repos: Array<unknown> }
      expect(listed.repos).toEqual([])
      expect(JSON.parse(await Bun.file(join(stateDir, "repositories.json")).text())).toEqual({ repositories: [] })
    } finally {
      await booted.stop()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test("the product-API families forward to the Worker with the session cookie; unknown /api paths still 404 locally", async () => {
    const seen: Array<{ path: string; cookie: string | null; origin: string | null }> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seen.push({ path: new URL(request.url).pathname, cookie: request.headers.get("cookie"), origin: request.headers.get("origin") })
        return new Response(JSON.stringify([{ number: 7, title: "an issue" }]), { headers: { "content-type": "application/json" } })
      }
    })
    const proxied = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      identityUpstream: `http://127.0.0.1:${upstream.port}`,
      node: { path: "/fake/node", version: "v22.19.0" },
      home: "/fake/home",
      harnesses: async () => [],
      log: () => {}
    })
    try {
      const headers = { [LOCAL_SESSION_HEADER]: proxied.sessionToken, origin: proxied.origin, cookie: "smithers_identity=sealed" }
      for (const path of ["/api/repos/smithersai/smithers/issues?state=open", "/api/user/github-repos/smithersai/smithers/issues", "/api/billing/balance", "/api/notifications/unread", "/api/workflow/provision", "/api/integrations/linear", "/api/linear/7/ops?limit=20"]) {
        const response = await fetch(`${proxied.origin}${path}`, { headers })
        expect(response.status).toBe(200)
      }
      expect(seen.map((entry) => entry.path)).toEqual([
        "/api/repos/smithersai/smithers/issues",
        "/api/user/github-repos/smithersai/smithers/issues",
        "/api/billing/balance",
        "/api/notifications/unread",
        "/api/workflow/provision",
        "/api/integrations/linear",
        "/api/linear/7/ops"
      ])
      // The Worker authenticates by the identity session cookie; the Origin follows the upstream like every identity call.
      expect(seen.every((entry) => entry.cookie === "smithers_identity=sealed")).toBe(true)
      expect(seen.every((entry) => entry.origin === `http://127.0.0.1:${upstream.port}`)).toBe(true)
      const unknown = await fetch(`${proxied.origin}/api/nothing/here`, { headers })
      expect(unknown.status).toBe(404)
      expect(seen).toHaveLength(7)
    } finally {
      await proxied.stop()
      upstream.stop(true)
    }
  })

  test("offline, the product-API families answer 501 instead of a misleading 404", async () => {
    const response = await apiFetch("/api/repos/smithersai/smithers/issues")
    expect(response.status).toBe(501)
  })

  test("the stub identity seam answers signed-out and nothing else", async () => {
    const session = await apiFetch("/api/auth/session")
    expect(await session.json()).toEqual({ status: "signed-out" })
    expect((await apiFetch("/api/auth/native/start", { method: "POST" })).status).toBe(501)
  })
})

describe("the Smithers Cloud seam", () => {
  test("offline answers 501 like the identity stub, and the session is honestly signed-out", async () => {
    // Offline the host claims neither cloud door: the bootstrap is the shared
    // table (@smthrs/rpc/HostCapabilities) for a launch with no Smithers Cloud upstream.
    const bootstrap = (await (await apiFetch("/api/bootstrap")).json()) as { capabilities: Array<string> }
    expect(bootstrap.capabilities).toEqual(
      localCapabilities({ agent: true, identity: false, cloud: false, pathEntry: true })
    )
    expect((await apiFetch("/api/cloud/api/user/repos")).status).toBe(501)
    expect((await apiFetch("/api/cloud-auth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    })).status).toBe(501)
    expect((await apiFetch("/api/cloud-auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    })).status).toBe(501)
    const session = await apiFetch("/api/cloud-auth/session")
    expect(await session.json()).toEqual({ state: "signed-out", username: null, expiresAt: null })
  })

  test("/api/cloud/* refuses a scheme-relative path and never forwards the identity cookie", async () => {
    const seen: Array<{ path: string; cookie: string | null }> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seen.push({ path: new URL(request.url).pathname, cookie: request.headers.get("cookie") })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      }
    })
    const proxied = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      chatStub: true,
      cloudApi: `http://127.0.0.1:${upstream.port}`,
      cloudAuth: {
        token: () => "smithers_test_token",
        session: () => ({ state: "signed-in", username: "will", expiresAt: null }),
        start: async () => ({ error: "already signed in" }),
        signOut: async () => {},
        stop: async () => {}
      },
      node: { path: "/fake/node", version: "v22.19.0" },
      home: "/fake/home",
      harnesses: async () => [],
      log: () => {}
    })
    try {
      const headers = { [LOCAL_SESSION_HEADER]: proxied.sessionToken, cookie: "smithers_identity=sealed" }
      // `//evil.example/x` sliced naively is scheme-relative: the bearer would go to evil.example.
      for (const path of ["/api/cloud//evil.example/x", "/api/cloud/"]) {
        const refused = await fetch(`${proxied.origin}${path}`, { headers })
        expect(refused.status).toBe(400)
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid_cloud_path")
      }
      expect(seen).toEqual([])
      const ok = await fetch(`${proxied.origin}/api/cloud/api/user/repos`, { headers })
      expect(ok.status).toBe(200)
      expect(seen).toEqual([{ path: "/api/user/repos", cookie: null }])
      // A percent-encoded backslash stays a path segment on the upstream origin, never a host.
      const encoded = await fetch(`${proxied.origin}/api/cloud/%5C%5Cevil.example/x`, { headers })
      expect(encoded.status).toBe(200)
      expect(seen[1]?.path.startsWith("/%5C%5Cevil.example")).toBe(true)
    } finally {
      await proxied.stop()
      upstream.stop(true)
    }
  })

  test("/api/cloud/* forwards with the Bun-held bearer, the identity-proxy rewrites, and a trail line", async () => {
    const upstreamHeaders: Array<Headers> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        upstreamHeaders.push(request.headers)
        const { pathname } = new URL(request.url)
        return pathname === "/api/user/repos"
          ? new Response(JSON.stringify([{ full_name: "will/smithers" }]), {
            headers: {
              "content-type": "application/json",
              "set-cookie": "cloud_session=sealed; Domain=api.smithers-cloud.test; Path=/; Secure; HttpOnly"
            }
          })
          : new Response("not found", { status: 404 })
      }
    })
    const cloudLogs: Array<string> = []
    const proxied = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      chatStub: true,
      cloudApi: `http://127.0.0.1:${upstream.port}`,
      cloudAuth: {
        token: () => "smithers_test_token",
        session: () => ({ state: "signed-in", username: "will", expiresAt: null }),
        start: async () => ({ error: "already signed in" }),
        signOut: async () => {},
        stop: async () => {}
      },
      node: { path: "/fake/node", version: "v22.19.0" },
      home: "/fake/home",
      harnesses: async () => [],
      log: (line) => cloudLogs.push(line)
    })
    try {
      const bootstrap = (await (await fetch(`${proxied.origin}/api/bootstrap`, {
        headers: { [LOCAL_SESSION_HEADER]: proxied.sessionToken }
      })).json()) as { capabilities: Array<string> }
      // The same table the parity matrix reads: a Smithers Cloud upstream opens both cloud doors.
      expect(bootstrap.capabilities).toEqual(
        localCapabilities({ agent: true, identity: false, cloud: true, browser: true, pathEntry: false })
      )

      const response = await fetch(`${proxied.origin}/api/cloud/api/user/repos?per_page=1`, {
        headers: {
          [LOCAL_SESSION_HEADER]: proxied.sessionToken,
          origin: proxied.origin,
          // A renderer-supplied bearer is a forgery: the token never reaches the renderer.
          authorization: "Bearer renderer_forgery"
        }
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([{ full_name: "will/smithers" }])
      expect(upstreamHeaders).toHaveLength(1)
      const headers = upstreamHeaders[0]!
      expect(headers.get("authorization")).toBe("Bearer smithers_test_token")
      expect(headers.get(LOCAL_SESSION_HEADER)).toBeNull()
      expect(headers.get("host")).toBe(`127.0.0.1:${upstream.port}`)
      expect(headers.get("origin")).toBe(`http://127.0.0.1:${upstream.port}`)
      const cookie = response.headers.getSetCookie()[0] ?? ""
      expect(cookie.startsWith("cloud_session=sealed")).toBe(true)
      expect(cookie.toLowerCase()).not.toContain("domain=")
      expect(cookie.toLowerCase()).not.toContain("secure")
      expect(cloudLogs.some((line) => /^GET \/api\/cloud\/api\/user\/repos -> 200 in \d+ms$/.test(line))).toBe(true)
      // The sign-in routes answer through the injected manager.
      const session = await fetch(`${proxied.origin}/api/cloud-auth/session`, {
        headers: { [LOCAL_SESSION_HEADER]: proxied.sessionToken }
      })
      expect(await session.json()).toEqual({ state: "signed-in", username: "will", expiresAt: null })
      const started = await fetch(`${proxied.origin}/api/cloud-auth/start`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: proxied.sessionToken, "content-type": "application/json" },
        body: "{}"
      })
      expect(started.status).toBe(409)
    } finally {
      await proxied.stop()
      upstream.stop(true)
    }
  })
})

describe("POST /api/repo/files", () => {
  let repoDir = ""
  let outside = ""
  let repoId = ""
  const files = (body: unknown) =>
    apiFetch("/api/repo/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "smithers-repo-files-"))
    outside = await mkdtemp(join(tmpdir(), "smithers-repo-outside-"))
    await mkdir(join(repoDir, "src"))
    await writeFile(join(repoDir, "README.md"), "# Smithers — files\n")
    await writeFile(join(repoDir, "src", "app.ts"), "export const x = 1\n")
    await writeFile(join(repoDir, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]))
    await writeFile(join(repoDir, "big.txt"), "x".repeat(REPO_FILE_READ_CAP_BYTES + 10))
    await writeFile(join(outside, "secret.txt"), "top secret")
    await symlink(join(outside, "secret.txt"), join(repoDir, "escape.txt"))
    const opened = await apiFetch("/api/repo/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repoDir })
    })
    expect(opened.status).toBe(200)
    repoId = ((await opened.json()) as { repo: { id: string } }).repo.id
  })

  afterAll(async () => {
    await apiFetch("/api/repo/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId }) })
    await rm(repoDir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  test("lists a directory dirs-first then by name; a symlink lists as what it points at", async () => {
    const root = await files({ repoId })
    expect(root.status).toBe(200)
    expect(await root.json()).toEqual({
      kind: "dir",
      path: "",
      entries: [
        { name: "src", kind: "dir" },
        { name: "big.txt", kind: "file" },
        { name: "escape.txt", kind: "file" },
        { name: "logo.bin", kind: "file" },
        { name: "README.md", kind: "file" }
      ]
    })
    const src = await files({ repoId, path: "/src/" })
    expect(await src.json()).toEqual({ kind: "dir", path: "src", entries: [{ name: "app.ts", kind: "file" }] })
  })

  test("reads a text file whole, states its size, and keeps UTF-8 intact", async () => {
    const response = await files({ repoId, path: "README.md" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      kind: "file",
      path: "README.md",
      size: Buffer.byteLength("# Smithers — files\n"),
      content: "# Smithers — files\n",
      truncated: false,
      binary: false,
      // The digest of the bytes carried, so a language server's answer can say whether it is about this text.
      digest: createHash("sha256").update("# Smithers — files\n").digest("hex")
    })
  })

  test("bounds a large file at the read cap and says so", async () => {
    const body = (await (await files({ repoId, path: "big.txt" })).json()) as { content: string; truncated: boolean; size: number }
    expect(body.truncated).toBe(true)
    expect(body.content.length).toBe(REPO_FILE_READ_CAP_BYTES)
    expect(body.size).toBe(REPO_FILE_READ_CAP_BYTES + 10)
  })

  test("states a binary file instead of printing it", async () => {
    expect(await (await files({ repoId, path: "logo.bin" })).json()).toEqual({
      kind: "file",
      path: "logo.bin",
      size: 5,
      content: "",
      truncated: false,
      binary: true,
      digest: createHash("sha256").update(Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47])).digest("hex")
    })
  })

  test("refuses traversal, refuses a symlink out of the repository, and 404s a missing path", async () => {
    for (const path of ["../secret.txt", "src/../../x", String.raw`src\..\..\x`, "a/./b"]) {
      const refused = await files({ repoId, path })
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid_path")
    }
    const escape = await files({ repoId, path: "escape.txt" })
    expect(escape.status).toBe(403)
    expect(((await escape.json()) as { error: { code: string } }).error.code).toBe("path_outside_repository")
    // An absolute path is read relative to the root, never from the filesystem root.
    const absolute = await files({ repoId, path: "/etc/passwd" })
    expect(absolute.status).toBe(404)
    const missing = await files({ repoId, path: "missing.txt" })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { message: string } }).error.message).toBe("Path not found: missing.txt")
  })

  test("a directory past the listing cap answers its first page by name and says so", async () => {
    const crowded = join(repoDir, "crowded")
    await mkdir(crowded)
    await Promise.all(
      Array.from({ length: REPO_LISTING_CAP_ENTRIES + 3 }, (_entry, index) =>
        writeFile(join(crowded, `f${String(index).padStart(5, "0")}.txt`), "")
      )
    )
    const body = (await (await files({ repoId, path: "crowded" })).json()) as { entries: Array<{ name: string }>; truncated?: boolean }
    expect(body.truncated).toBe(true)
    expect(body.entries).toHaveLength(REPO_LISTING_CAP_ENTRIES)
    expect(body.entries[0]?.name).toBe("f00000.txt")
    // Errors never carry the checkout's absolute path.
    const missing = (await (await files({ repoId, path: "crowded/nope" })).json()) as { error: { message: string } }
    expect(missing.error.message).not.toContain(repoDir)
  })

  test("404s an unknown repository and 400s a malformed body", async () => {
    expect((await files({ repoId: "nope" })).status).toBe(404)
    expect((await files({ repoId, path: 3 })).status).toBe(400)
    expect((await files({ repoId, cwd: "/" })).status).toBe(400)
  })
})

describe("POST /api/chat/turn", () => {
  test("streams the stub's frames as NDJSON and ends on done", async () => {
    const response = await apiFetch("/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-1",
        messages: [{ role: "user", content: "say ok" }],
        instructions: "Be brief."
      })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(await readFrames(response)).toEqual([
      { runId: "run-1", type: "delta", kind: "reasoning", text: "stub: thinking" },
      { runId: "run-1", type: "delta", kind: "text", text: "stub: say ok" },
      { runId: "run-1", type: "done", reason: "stop" }
    ])
  })

  test("a malformed body answers 400 with the error envelope", async () => {
    const response = await apiFetch("/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "", messages: "no" })
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_request")
  })

  test("caps the body by bytes received, so a chunked turn past the cap answers 413", async () => {
    const declared = await apiFetch("/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(4 * 1024 * 1024) },
      body: "x".repeat(4 * 1024 * 1024)
    })
    expect(declared.status).toBe(413)
    // Chunked: no Content-Length on the wire, so only the received bytes bound it.
    const encoder = new TextEncoder()
    const chunk = encoder.encode("a".repeat(256 * 1024))
    const chunked = await apiFetch("/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("{\"runId\":\"chunked\",\"instructions\":\"x\",\"messages\":[{\"role\":\"user\",\"content\":\""))
          for (let index = 0; index < 8; index += 1) controller.enqueue(chunk)
          controller.enqueue(encoder.encode("\"}]}"))
          controller.close()
        }
      }),
      duplex: "half"
    } as RequestInit)
    expect(chunked.status).toBe(413)
    expect(((await chunked.json()) as { error: { code: string } }).error.code).toBe("body_too_large")
  })

  test("cancel answers ok and closes a live stream", async () => {
    const response = await apiFetch("/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3", messages: [{ role: "user", content: "x" }], instructions: "" })
    })
    const cancel = await apiFetch("/api/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3" })
    })
    expect(cancel.status).toBe(200)
    expect(((await cancel.json()) as { ok: boolean }).ok).toBe(true)
    // The stream ends (possibly with no done frame) instead of hanging.
    const frames = await readFrames(response)
    expect(frames.every((frame) => frame.runId === "run-3")).toBe(true)
    const late = await apiFetch("/api/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3" })
    })
    expect(await late.json()).toEqual({ ok: true, status: "not-found" })
  })
})

describe("/ws", () => {
  const connect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
      socket.onopen = () => resolve(socket)
      socket.onerror = () => reject(new Error("ws failed"))
    })

  const nextMessage = (socket: WebSocket): Promise<unknown> =>
    new Promise((resolve) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)))
    })

  test("subscribe receives published frames; unsubscribe stops them", async () => {
    const socket = await connect()
    const ack = nextMessage(socket)
    socket.send(JSON.stringify({ type: "subscribe", topic: "pty:abc" }))
    expect(await ack).toEqual({ type: "subscribed", topic: "pty:abc" })
    const frame = nextMessage(socket)
    server.publish("pty:abc", { type: "pty.output", sessionId: "abc", data: "hi" })
    expect(await frame).toEqual({ type: "pty.output", sessionId: "abc", data: "hi" })
    const unack = nextMessage(socket)
    socket.send(JSON.stringify({ type: "unsubscribe", topic: "pty:abc" }))
    expect(await unack).toEqual({ type: "unsubscribed", topic: "pty:abc" })
    socket.close()
  })

  test("a registered message handler receives client frames by type", async () => {
    const received: Array<unknown> = []
    const off = server.onMessage("probe.ping", (message, socket) => {
      received.push(message)
      socket.send(JSON.stringify({ type: "echo", data: message.data }))
    })
    const socket = await connect()
    const reply = nextMessage(socket)
    socket.send(JSON.stringify({ type: "probe.ping", data: "ls\n" }))
    expect(await reply).toEqual({ type: "echo", data: "ls\n" })
    expect(received).toEqual([{ type: "probe.ping", data: "ls\n" }])
    off()
    const error = nextMessage(socket)
    socket.send(JSON.stringify({ type: "probe.ping", data: "x" }))
    expect(await error).toEqual({ type: "error", message: "No handler for probe.ping." })
    socket.close()
  })

  test("pty.input for an unknown session answers an error frame", async () => {
    const socket = await connect()
    const error = nextMessage(socket)
    socket.send(JSON.stringify({ type: "pty.input", sessionId: "nope", data: "x" }))
    expect(await error).toEqual({ type: "error", message: "No live PTY session nope." })
    socket.close()
  })
})

describe("defaultDistDir", () => {
  test("SMITHERS_DIST_DIR wins, then the bundled views, then apps/ui/dist", async () => {
    expect(defaultDistDir("/x/bun", { SMITHERS_DIST_DIR: "/explicit" })).toBe("/explicit")
    const app = await mkdtemp(join(tmpdir(), "smithers-app-"))
    await mkdir(join(app, "views", "mainview"), { recursive: true })
    await writeFile(join(app, "views", "mainview", "index.html"), "<html>")
    expect(defaultDistDir(join(app, "bun"), {})).toBe(join(app, "views", "mainview"))
    expect(defaultDistDir("/nowhere/src/bun", {})).toBe("/nowhere/dist")
    await rm(app, { recursive: true, force: true })
  })
})
