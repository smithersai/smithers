/**
 * Assertions ported from OpenCode's own server tests.
 *
 * `packages/opencode/test/server/**` in OpenCode main (5a83358) builds
 * OpenCode's layers in process, so none of those tests can run against this
 * server. What is portable is what they assert: the header set on an event
 * stream, the CORS answer, the cursor headers on a message page, the error
 * body the SDK reads. Each case below keeps its upstream file and name, so
 * a reader can find the original.
 *
 * Deliberately not ported, and why, in one line each:
 * `session-select.test.ts`, `httpapi-pty.test.ts`, `httpapi-mcp*.test.ts`,
 * `httpapi-mdns.test.ts`, `httpapi-sync.test.ts`, `httpapi-workspace*.test.ts`,
 * `httpapi-instance*.test.ts`, `workspace-proxy.test.ts`, `proxy-util.test.ts`,
 * `project-copy.test.ts`, `worktree-endpoint-repro.test.ts` — routes and a
 * workspace/instance tier this server does not have.
 * `httpapi-schema-error-body.test.ts`, `httpapi-query-schema-drift.test.ts`,
 * `httpapi-public-openapi.test.ts` — they assert the wire shape an HttpApi
 * schema derives; these routes are hand written and derive no schema, so the
 * only portable case is the 400 on an unknown cursor, which is here.
 * `httpapi-error-middleware.test.ts` — no error middleware here; a route
 * defect answers a typed 500, which `Routes.test.ts` already covers.
 * `sdk-error-shape.test.ts` — it asserts that the v2 SDK's own
 * `wrapClientError` turns a 404 body into a real `Error`; that is the
 * client's behaviour, not the server's. The server half of it, the
 * NamedError-shaped body, is asserted below.
 * `httpapi-compression.test.ts`, `httpapi-listen.test.ts`,
 * `negative-tokens-regression.test.ts` — behaviour of OpenCode's own server
 * process, not of the protocol it answers.
 */
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Ids from "../src/Ids.ts"
import * as Protocol from "../src/Protocol.ts"
import * as Serve from "../src/Serve.ts"
import * as Store from "../src/Store.ts"
import { dataOf, serve, type Served, until } from "./Harness.ts"
import * as OpenApi from "./OpenApi.ts"

let served: Served
beforeAll(() => {
  served = serve()
})
afterAll(() => served.dispose())

const ask = (path: string, init?: RequestInit): Promise<Response> =>
  served.handler(new Request(`http://test${path}`, init))

// Upstream's own cases use `http://localhost:3000`, because upstream allows
// every loopback origin. This server does not: a page on any loopback port is
// a page the operator never chose, and it would have read files and driven
// the agent with no password and no gesture (`Cors`, and `Security.test.ts`).
// What these cases are actually about is the preflight's header set and its
// `Vary`, so they ask as the hosted app, which is the origin this server is
// for. A loopback build names itself with `--cors`.
const PREFLIGHT_HEADERS = {
  origin: "https://app.opencode.ai",
  "access-control-request-method": "POST",
  "access-control-request-headers": "content-type, x-opencode-directory"
}

const newSession = async (): Promise<string> =>
  ((await (await ask("/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
    .json()) as { id: string }).id

/** `count` user messages in one session, oldest first, written straight to the store. */
const fill = async (sessionID: string, count: number): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* Store.Store
      const ids: Array<string> = []
      for (let index = 0; index < count; index += 1) {
        const id = Ids.make("message")
        yield* store.putMessage({
          id,
          sessionID,
          role: "user",
          time: { created: Date.now() + index },
          agent: "smithers",
          model: { providerID: "scripted", modelID: "demo" }
        } as Protocol.UserMessage)
        ids.push(id)
      }
      return ids as ReadonlyArray<string>
    }).pipe(Effect.provide(Store.layerSqlite(Serve.databasePath(served.directory))))
  )

// ── httpapi-event.test.ts ────────────────────────────────────────────────
describe("event HttpApi (httpapi-event.test.ts)", () => {
  /**
   * One open `/global/event` stream, drained continuously in the background
   * the way upstream forks `Stream.runForEach` into a queue. The drain must
   * be continuous: the hub subscribes a consumer when it pulls past the
   * replay prologue, so a reader that stops after the first frame is not yet
   * subscribed and misses what is published next.
   */
  const open = async (): Promise<{
    readonly response: Response
    readonly next: (withinMs?: number) => Promise<{ type: string; properties: Record<string, unknown> } | undefined>
    readonly close: () => Promise<void>
  }> => {
    const response = await ask("/global/event")
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const frames: Array<string> = []
    let buffered = ""
    let ended = false
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
        if (done === true) {
          ended = true
          return
        }
        buffered += decoder.decode(value)
        const parts = buffered.split("\n\n")
        buffered = parts.pop() ?? ""
        // 1.18.31 frames data alone; this server names the event id above
        // it as well, so a browser can ask for the gap after a reconnect
        // (`Events.frame`). The data line is read by name, not by position.
        for (const part of parts) {
          const data = dataOf(part)
          if (data !== undefined) frames.push(data)
        }
      }
    })()
    return {
      response,
      next: async (withinMs = 5000) => {
        const deadline = Date.now() + withinMs
        while (frames.length === 0 && !ended && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        if (frames.length === 0) return undefined
        return (JSON.parse(frames.shift()!) as { payload: { type: string; properties: Record<string, unknown> } })
          .payload
      },
      close: () => reader.cancel()
    }
  }

  it("serves event stream", async () => {
    const stream = await open()
    try {
      expect(stream.response.status).toBe(200)
      expect(stream.response.headers.get("content-type")).toContain("text/event-stream")
      expect(stream.response.headers.get("cache-control")).toBe("no-cache, no-transform")
      expect(stream.response.headers.get("x-accel-buffering")).toBe("no")
      expect(stream.response.headers.get("x-content-type-options")).toBe("nosniff")
      const first = await stream.next()
      expect(first).toMatchObject({ type: "server.connected", properties: {} })
      expect(OpenApi.violations("EventServerConnected", { ...first, id: Ids.make("event") })).toEqual([])
    } finally {
      await stream.close()
    }
  })

  it("keeps the event stream open after the initial event", async () => {
    const stream = await open()
    try {
      expect(await stream.next()).toMatchObject({ type: "server.connected" })
      // No second event within 250 ms means the stream is still open, not ended.
      expect(await stream.next(250)).toBeUndefined()
      expect(stream.response.body!.locked).toBe(true)
    } finally {
      await stream.close()
    }
  })

  it("delivers instance events after the initial event", async () => {
    const stream = await open()
    try {
      expect(await stream.next()).toMatchObject({ type: "server.connected" })
      // The subscription registers on the pull past the greeting, and nothing
      // outside the stream can observe that pull, so a session is created
      // until one of them is announced rather than once with a stopwatch on
      // the answer: under load the drain had not pulled yet and the one
      // announcement went to no subscriber.
      const ids: Array<string> = []
      let created: { type: string; properties: Record<string, unknown> } | undefined
      for (let attempt = 0; attempt < 20 && created === undefined; attempt++) {
        ids.push(await newSession())
        created = await stream.next(250)
      }
      expect(created).toMatchObject({ type: "session.created" })
      expect(ids).toContain(
        ((created!.properties["info"]) as { readonly id: string }).id
      )
    } finally {
      await stream.close()
    }
  })
})

// ── httpapi-cors.test.ts ─────────────────────────────────────────────────
describe("HttpApi CORS (httpapi-cors.test.ts)", () => {
  it("allows browser preflight requests without credentials", async () => {
    const response = await ask("/path", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.opencode.ai",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization"
      }
    })
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization")
  })

  it("adds CORS headers to unauthorized responses", async () => {
    const scratch = serve({ bind: { credentials: { username: "opencode", password: "secret" } } })
    try {
      const response = await scratch.handler(
        new Request("http://test/global/config", { headers: { origin: "https://app.opencode.ai" } })
      )
      expect(response.status).toBe(401)
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    } finally {
      await scratch.dispose()
    }
  })

  it("refuses an origin the server was not told about", async () => {
    const response = await ask("/path", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" }
    })
    expect(response.headers.get("access-control-allow-origin")).not.toBe("https://evil.example")
    // Upstream declines to mark the answer. This server also refuses it,
    // because declining leaves the route to run for a CORS-simple request.
    expect(response.status).toBe(403)
  })
})

// ── httpapi-cors-vary.test.ts ────────────────────────────────────────────
// A preflight answer echoes both the origin and the requested headers, so a
// shared cache that keyed only on the origin would serve one origin's
// preflight to another. Upstream repairs this with `corsVaryFixLayer`.
describe("CORS preflight Vary header (httpapi-cors-vary.test.ts)", () => {
  it("HTTP API backend preflight Vary contains Origin", async () => {
    const response = await ask("/global/config", { method: "OPTIONS", headers: PREFLIGHT_HEADERS })
    expect([200, 204]).toContain(response.status)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    expect((response.headers.get("vary") ?? "").toLowerCase()).toContain("origin")
  })

  it("HTTP API backend preflight Vary still preserves Access-Control-Request-Headers", async () => {
    const response = await ask("/global/config", { method: "OPTIONS", headers: PREFLIGHT_HEADERS })
    const vary = (response.headers.get("vary") ?? "").toLowerCase()
    expect(vary).toContain("origin")
    expect(vary).toContain("access-control-request-headers")
  })

  it("HTTP API backend does not duplicate Origin in Vary", async () => {
    const response = await ask("/global/config", { method: "OPTIONS", headers: PREFLIGHT_HEADERS })
    const names = (response.headers.get("vary") ?? "").split(",").map((name) => name.trim().toLowerCase())
    expect(names.filter((name) => name === "origin").length).toBe(1)
  })
})

// ── session-messages.test.ts ─────────────────────────────────────────────
describe("session messages endpoint (session-messages.test.ts)", () => {
  it("returns cursor headers for older pages", async () => {
    const session = await newSession()
    const ids = await fill(session, 5)
    const first = await ask(`/session/${session}/message?limit=2`)
    expect(first.status).toBe(200)
    expect(((await first.json()) as Array<{ info: { id: string } }>).map((item) => item.info.id))
      .toEqual(ids.slice(-2))
    const cursor = first.headers.get("x-next-cursor")
    expect(cursor).toBeTruthy()
    expect(first.headers.get("link")).toContain("rel=\"next\"")
    const older = await ask(`/session/${session}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
    expect(older.status).toBe(200)
    expect(((await older.json()) as Array<{ info: { id: string } }>).map((item) => item.info.id))
      .toEqual(ids.slice(-4, -2))
  })

  it("keeps full-history responses when limit is omitted", async () => {
    const session = await newSession()
    const ids = await fill(session, 3)
    const response = await ask(`/session/${session}/message`)
    expect(response.status).toBe(200)
    expect(((await response.json()) as Array<{ info: { id: string } }>).map((item) => item.info.id)).toEqual(ids)
  })

  it("rejects invalid cursors and missing sessions", async () => {
    const session = await newSession()
    await fill(session, 2)
    const bad = await ask(`/session/${session}/message?limit=2&before=bad`)
    expect(bad.status).toBe(400)
    const other = await newSession()
    const ids = await fill(other, 1)
    // A real id, but of another session: still not a cursor into this page.
    const foreign = await ask(`/session/${session}/message?limit=2&before=${ids[0]}`)
    expect(foreign.status).toBe(400)
    const missing = await ask("/session/ses_missing/message?limit=2")
    expect(missing.status).toBe(404)
  })

  it("does not truncate large legacy limit requests", async () => {
    const session = await newSession()
    await fill(session, 520)
    const response = await ask(`/session/${session}/message?limit=510`)
    expect(response.status).toBe(200)
    expect((await response.json()) as Array<unknown>).toHaveLength(510)
  })

  it("accepts directory query used by workspace routing", async () => {
    const session = await newSession()
    await fill(session, 1)
    const response = await ask(
      `/session/${session}/message?limit=80&directory=${encodeURIComponent(served.directory)}`
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as Array<unknown>).toHaveLength(1)
  })
})

// ── sdk-v1-smoke.test.ts ─────────────────────────────────────────────────
describe("v1 SDK runtime smoke (sdk-v1-smoke.test.ts)", () => {
  const client = () =>
    createOpencodeClient({ baseUrl: "http://test", fetch: (request) => served.handler(request as Request) })

  it("session.list reaches the server and returns 200", async () => {
    const result = await client().session.list()
    expect(result.error).toBeUndefined()
    expect(Array.isArray(result.data)).toBe(true)
    for (const session of result.data as Array<unknown>) {
      expect(OpenApi.violations("Session", session)).toEqual([])
    }
  })

  it("path.get reaches the server and returns 200", async () => {
    const result = await client().path.get()
    expect(result.error).toBeUndefined()
    expect(OpenApi.violations("Path", result.data)).toEqual([])
  })

  it("config.get reaches the server and returns 200", async () => {
    const result = await client().config.get()
    expect(result.error).toBeUndefined()
    expect(result.data).toBeDefined()
  })

  it("session 404: result-tuple path returns the error body", async () => {
    const result = await client().session.get({ path: { id: "ses_no_such" } as never })
    expect(result.error).toBeDefined()
    // The wire body for a 404 is NamedError-shaped, which is what the app and
    // the SDK's throwing client both read the message out of.
    expect(result.error).toMatchObject({ name: "NotFoundError" })
  })
})

// ── global-session-list.test.ts and session-list.test.ts ─────────────────
describe("session list (session-list.test.ts)", () => {
  it("lists a created session and drops a deleted one", async () => {
    const id = await newSession()
    const listed = async () =>
      ((await (await ask("/session")).json()) as Array<{ id: string }>).some((session) => session.id === id)
    expect(await listed()).toBe(true)
    const deleted = await ask(`/session/${id}`, { method: "DELETE" })
    expect(deleted.status).toBe(200)
    await until(async () => !await listed())
  })

  it("answers a fresh directory with no sessions as an empty list", async () => {
    const empty = serve()
    try {
      expect(await (await empty.handler(new Request("http://test/session"))).json()).toEqual([])
    } finally {
      await empty.dispose()
    }
  })
})
