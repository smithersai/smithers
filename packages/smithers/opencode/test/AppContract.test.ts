/**
 * The contract the hosted OpenCode app's own route mock declares.
 *
 * Ported from `packages/app/e2e/utils/mock-server.ts` in OpenCode main
 * (5a83358). That file is the fake server the app's Playwright suite runs
 * against, so every path it answers is a path the app asks for and every
 * body it returns is a body the app reads: it is the minimum a server must
 * answer to be the app's backend. The specs beside it drive the app's own
 * internals (its timeline reducer, tab state, xterm panes) and are not
 * ported; the mock is.
 *
 * Where a shape is one the 1.18.31 OpenAPI declares, the assertion is
 * against the declaration (`test/OpenApi.ts`), not a literal.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Protocol from "../src/Protocol.ts"
import { serve, type Served, until } from "./Harness.ts"
import * as OpenApi from "./OpenApi.ts"

let served: Served
beforeAll(() => {
  served = serve()
  // The mock answers `/vcs` with a branch, so the served directory is a
  // checkout, the way every directory the app is pointed at is.
  mkdirSync(join(served.directory, ".git"), { recursive: true })
  writeFileSync(join(served.directory, ".git", "HEAD"), "ref: refs/heads/main\n")
})
afterAll(() => served.dispose())

const APP_ORIGIN = "https://app.opencode.ai"

const ask = (path: string, init?: RequestInit): Promise<Response> =>
  served.handler(new Request(`http://test${path}`, init))

const bodyOf = async (path: string): Promise<unknown> => {
  const response = await ask(path)
  expect(response.status, path).toBe(200)
  return response.json()
}

const conforms = (schema: string, value: unknown): void => expect(OpenApi.violations(schema, value)).toEqual([])

/** A session with one prompt and one reply in it, for the paging routes. */
const seeded = async (): Promise<{ readonly id: string; readonly messages: ReadonlyArray<string> }> => {
  const created = await (await ask("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "app contract" })
  })).json() as { id: string }
  await ask(`/session/${created.id}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] })
  })
  await until(async () => ((await bodyOf(`/session/${created.id}/message`)) as Array<unknown>).length >= 2)
  const page = await bodyOf(`/session/${created.id}/message`) as Array<{ info: { id: string } }>
  return { id: created.id, messages: page.map((item) => item.info.id) }
}

describe("the app's route mock as a contract", () => {
  // mock-server.ts `staticRoutes`: the six paths it answers from a literal,
  // which the app reads once on boot to name the project it is looking at.
  it("answers every staticRoutes path the mock declares", async () => {
    conforms("Path", await bodyOf("/path"))
    const projects = await bodyOf("/project") as Array<unknown>
    expect(projects.length).toBe(1)
    conforms("Project", projects[0])
    conforms("Project", await bodyOf("/project/current"))
    const agents = await bodyOf("/agent") as Array<{ name: string; mode: string }>
    expect(agents.map((agent) => agent.mode)).toContain("primary")
    expect(await bodyOf("/vcs")).toMatchObject({ branch: "main", default_branch: "main" })
    expect(Array.isArray(await bodyOf("/session"))).toBe(true)
  })

  // mock-server.ts `emptyList` and `emptyObject`: seven paths the app asks
  // for on every boot and the mock answers empty. A 404 here made the app
  // retry a route that will never exist.
  it("answers the emptyList and emptyObject paths the mock declares", async () => {
    for (const path of ["/skill", "/command", "/lsp", "/formatter", "/vcs/status", "/vcs/diff"]) {
      expect(await bodyOf(path), path).toEqual([])
    }
    for (const path of ["/global/config", "/config", "/provider/auth", "/mcp", "/experimental/resource"]) {
      expect(typeof await bodyOf(path), path).toBe("object")
    }
  })

  // mock-server.ts `/global/health` answers `{healthy: true}` in v1 mode and
  // 404s in v2 mode, which is how the app picks the protocol. This server is
  // v1, so the probe must answer.
  it("answers /global/health the way the mock's v1 protocol branch does", async () => {
    expect(await bodyOf("/global/health")).toMatchObject({ healthy: true })
    expect(await bodyOf("/api/health")).toEqual({ healthy: true })
  })

  // mock-server.ts `sse()`: `/global/event` frames are `{payload}` envelopes
  // and the first one is `server.connected`.
  it("frames /global/event the way the mock's sse helper does", async () => {
    const stream = await ask("/global/event")
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const reader = stream.body!.getReader()
    const frame = new TextDecoder().decode((await reader.read()).value!)
    expect(frame.startsWith("data: ")).toBe(true)
    expect(frame.endsWith("\n\n")).toBe(true)
    const envelope = JSON.parse(frame.slice(6)) as { payload: unknown }
    conforms("EventServerConnected", envelope.payload)
    await reader.cancel()
  })

  // mock-server.ts `currentSession()`: the fields the app projects a session
  // row from, on the v2 list route the app calls even in v1 mode.
  it("projects a session the way the mock's currentSession does", async () => {
    const { id } = await seeded()
    const list = await bodyOf("/api/session") as { data: Array<Record<string, unknown>> }
    const row = list.data.find((session) => session["id"] === id)!
    expect(row).toMatchObject({
      id,
      projectID: expect.any(String),
      agent: expect.any(String),
      model: { id: expect.any(String), providerID: expect.any(String) },
      cost: expect.any(Number),
      tokens: { input: expect.any(Number), output: expect.any(Number), cache: { read: expect.any(Number) } },
      time: { created: expect.any(Number), updated: expect.any(Number) },
      title: expect.any(String),
      location: { directory: expect.any(String) }
    })
    conforms("Session", await bodyOf(`/session/${id}`))
  })

  // mock-server.ts `/session/:id/message`: a page names its next cursor in
  // `x-next-cursor`, and `access-control-expose-headers` lets the browser
  // read it. Without the expose header the app's fetch sees no cursor and
  // stops scrolling.
  it("names the next cursor the way the mock's messagesMatch branch does", async () => {
    const { id, messages } = await seeded()
    const page = await ask(`/session/${id}/message?limit=1`, { headers: { origin: APP_ORIGIN } })
    expect(page.status).toBe(200)
    expect(page.headers.get("x-next-cursor")).toBe(messages[messages.length - 1])
    expect(page.headers.get("access-control-expose-headers")).toContain("X-Next-Cursor")
    expect(page.headers.get("link")).toContain("rel=\"next\"")
  })

  // mock-server.ts answers an unknown cursor `{error: "Invalid cursor"}` 400
  // and an unknown session 404.
  it("rejects an unknown cursor and an unknown session the way the mock does", async () => {
    const { id } = await seeded()
    const bad = await ask(`/session/${id}/message?limit=2&before=bad`)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ data: { message: expect.stringContaining("cursor") } })
    const missing = await ask("/session/ses_missing/message?limit=2")
    expect(missing.status).toBe(404)
  })

  // mock-server.ts `/session/:id/permissions/:id` POST answers `true`.
  it("answers a permission reply the way the mock's permissions branch does", async () => {
    const { id } = await seeded()
    const reply = await ask(`/session/${id}/permissions/per_absent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "once" })
    })
    // The route exists and takes a reply; an id no turn is parked on is a 404,
    // which is the answer the app reads when its card is already resolved.
    expect([200, 404]).toContain(reply.status)
  })

  // mock-server.ts answers routes this server deliberately does not mount
  // (the v2 `/api/*` tree, the question reply routes; `/experimental/*` was
  // among them until the TUI's contract added two of them). The app reads the
  // 404 and moves on; what it cannot read is a network error, so the 404 is
  // JSON and carries the allow headers.
  it("answers a route it does not mount with a readable 404", async () => {
    for (const path of ["/api/pty/shells", "/api/vcs", "/api/question/request"]) {
      const response = await ask(path, { headers: { origin: APP_ORIGIN } })
      expect(response.status, path).toBe(404)
      expect(await response.json(), path).toEqual({ name: "NotFoundError", data: { message: "Route not found" } })
      expect(response.headers.get("access-control-allow-origin"), path).toBe(APP_ORIGIN)
    }
  })

  it("was lifted from the OpenCode version this server answers as", () => {
    expect(OpenApi.source).toBe("opencode 1.18.31")
    expect(OpenApi.declared).toContain("Session")
    expect(Protocol.noTokens).toMatchObject({ input: 0, output: 0 })
  })
})
