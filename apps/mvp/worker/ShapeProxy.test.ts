// GET /api/shapes/messages (`ShapeProxy` from @smthrs/effect-electric, mounted in worker/Chat.ts) through ChatApi's
// handler, against the compose Electric (`pnpm db:up`) replicating this file's own schema of the compose Postgres.
// ChatApi asks Electric for `messages`;
// the fetch it calls Electric with names this file's schema in `table`, the one place the schema shows.
import { Effect, Layer } from "effect"
import { beforeAll, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { SHAPE_ROUTE } from "../src/features/chat/contract.ts"
import { FLOW_DRAFTS_SHAPE_ROUTE, FLOWS_SHAPE_ROUTE } from "../src/features/flows-ui/contract.ts"
import { RUNS_SHAPE_ROUTE } from "../src/features/status/contract.ts"
import { VIEWS_SHAPE_ROUTE } from "../src/features/views/contract.ts"
import * as Conversations from "./branch/Conversations.ts"
import * as ChatMetrics from "./ChatMetrics.ts"
import { type Actor, Sessions, SessionsUnavailable } from "./Actor.ts"
import { answers, eventually, harness, testFile } from "./test/harness.ts"

/** The columns a device syncs: every column of `messages` but who asked (worker/Chat.ts). */
const SYNCED = [
  "id",
  "conversation_id",
  "role",
  "text",
  "status",
  "question_id",
  "failure",
  "model_id",
  "stop_reason",
  "input_tokens",
  "output_tokens",
  "position",
  "created_at",
  "updated_at",
  "parts",
  "summary",
  "summary_revision",
]

const runtime = testFile("shapes")

/** The conversation of a team branch, which every Member may view (worker/branch/Access.ts): its id. */
const teamConversation = (name: string) =>
  runtime.runPromise(
    Effect.map(Conversations.track("github/octo/shapes", name, "open", "b".repeat(40)), (tracked) =>
      tracked.branch.conversationId),
  )

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

/**
 * ChatApi's handler with Electric reached through this file's schema: `upstream` holds each URL ChatApi asked for, and
 * `hold` keeps Electric's responses back until the function it returns is called.
 */
const proxy = async (
  config: Record<string, string> = {},
  actor?: Actor,
  more: Pick<Parameters<typeof harness>[2] & {}, "sessions" | "database"> = {},
) => {
  const { name } = await runtime.runPromise(Effect.gen(function* () {
    return yield* TestDatabase.Scratch
  }))
  const upstream: Array<URL> = []
  let held: Promise<void> | undefined
  const h = await harness(runtime, answers("never"), {
    config,
    ...more,
    ...(actor === undefined ? {} : { actor }),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      upstream.push(new URL(url))
      const table = url.searchParams.get("table")
      if (table === "messages" || table === "views") url.searchParams.set("table", `${name}.${table}`)
      if (held !== undefined) await held
      return fetch(url, init)
    },
  })
  return {
    ...h,
    upstream,
    hold: () => {
      let release = () => {}
      held = new Promise<void>((resolve) => (release = resolve))
      return () => {
        held = undefined
        release()
      }
    },
  }
}

// Each shape's rows depend on who asks, by the session's `where` or a session check, and the browser's URL doesn't
// name the person: a response a browser or CDN kept would answer the next person, or anyone after sign-out.
test.each([SHAPE_ROUTE, VIEWS_SHAPE_ROUTE, RUNS_SHAPE_ROUTE, FLOWS_SHAPE_ROUTE, FLOW_DRAFTS_SHAPE_ROUTE])(
  "GET %s is never kept by a browser or CDN",
  async (route) => {
    const h = await proxy({}, { subject: { kind: "person", id: "person-cache" }, role: "member" })
    const response = await h.fetch(`${route}?offset=-1`)
    await response.text()
    expect(h.upstream).toHaveLength(1)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("etag")).toBeNull()
  },
)

// A device holds the shape's handle and offset. Served another `where` under them, Electric answers `409
// must-refetch` and the device empties its copy, so a request the server can't decide is refused, never narrowed.
describe("a shape request the server can't decide", () => {
  const member: Actor = { subject: { kind: "person", id: "person-blip" }, role: "member" }

  test("while sessions can't be read is 503, and Electric never sees another scope under the device's handle", async () => {
    let down = false
    const sessions = Layer.succeed(
      Sessions,
      Sessions.of({
        resolve: Effect.suspend(() => (down ? Effect.fail(new SessionsUnavailable()) : Effect.succeedSome(member))),
      }),
    )
    const h = await proxy({}, undefined, { sessions })
    const conversation = await teamConversation("blip")
    const first = await h.fetch(`${SHAPE_ROUTE}?conversation=${conversation}&offset=-1`)
    expect(first.status).toBe(200)
    await first.text()
    const at = `conversation=${conversation}&offset=${first.headers.get("electric-offset")}` +
      `&handle=${first.headers.get("electric-handle")}`

    down = true
    const blip = await h.fetch(`${SHAPE_ROUTE}?${at}`)
    expect({
      status: blip.status,
      retryAfter: blip.headers.get("retry-after"),
      cacheControl: blip.headers.get("cache-control"),
    }).toEqual({ status: 503, retryAfter: "5", cacheControl: "private, no-store" })

    down = false
    const after = await h.fetch(`${SHAPE_ROUTE}?${at}`)
    expect(after.status).toBe(200)
    await after.text()
    expect(h.upstream.map((url) => url.searchParams.get("params[1]"))).toEqual([conversation, conversation])
    await eventually(() => h.line("chat.shape").length === 3)
    expect(h.line("chat.shape").map((line) => [line.level, line.annotations.status])).toEqual([
      ["INFO", 200],
      ["ERROR", 503],
      ["INFO", 200],
    ])
  })

  test("while the home conversation or sessions can't be read is 503 for every conversation's shape", async () => {
    const offline = await proxy({}, member, { database: Layer.unwrap(Effect.fail(new Error("database unreachable"))) })
    const sessionsDown = await proxy({}, undefined, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })
    const statuses = []
    // A named conversation's branch can't be read either: whose rows to serve is undecided.
    const named = crypto.randomUUID()
    for (const h of [offline, sessionsDown]) {
      for (const route of [SHAPE_ROUTE, VIEWS_SHAPE_ROUTE]) {
        for (const search of ["", `&conversation=${named}`]) {
          const response = await h.fetch(`${route}?offset=-1&handle=h-1${search}`)
          statuses.push([route, response.status, response.headers.get("retry-after")])
        }
      }
    }
    expect(statuses).toEqual(
      [SHAPE_ROUTE, SHAPE_ROUTE, VIEWS_SHAPE_ROUTE, VIEWS_SHAPE_ROUTE, SHAPE_ROUTE, SHAPE_ROUTE, VIEWS_SHAPE_ROUTE,
        VIEWS_SHAPE_ROUTE].map((route) => [route, 503, "5"]),
    )
    expect([...offline.upstream, ...sessionsDown.upstream]).toEqual([])
  })
})

describe("GET /api/shapes/views and /api/shapes/messages", () => {
  test("are one conversation's: the one named, the home conversation's when none is, and none for anyone who may not watch", async () => {
    const h = await proxy({}, { subject: { kind: "person", id: "person-views" }, role: "member" })
    const named = await teamConversation("views")
    // Someone else's branch, never shared, and a conversation no branch has: neither is this person's.
    const theirs = await runtime.runPromise(
      Effect.map(Conversations.track("github/octo/shapes", "theirs", "open", "a".repeat(40), "person-other"), (t) =>
        t.branch.conversationId),
    )
    for (const route of [VIEWS_SHAPE_ROUTE, SHAPE_ROUTE]) {
      for (
        const search of [
          `&conversation=${named.toUpperCase()}`,
          "&conversation=not-a-conversation",
          "",
          `&conversation=${theirs}`,
          `&conversation=${crypto.randomUUID()}`,
        ]
      ) {
        const response = await h.fetch(`${route}?offset=-1${search}`)
        expect(response.status).toBe(200)
        await response.text()
      }
    }
    const signedOut = await proxy()
    await (await signedOut.fetch(`${VIEWS_SHAPE_ROUTE}?offset=-1&conversation=${named}`)).text()

    const home = await runtime.runPromise(Conversations.home)
    const none = "00000000-0000-0000-0000-000000000000"
    expect([...h.upstream, ...signedOut.upstream].map((url) => [
      url.searchParams.get("table"),
      url.searchParams.get("where"),
      url.searchParams.get("params[1]"),
    ])).toEqual([
      ["views", "conversation_id = $1", named],
      ["views", "conversation_id = $1", none],
      ["views", "conversation_id = $1", home],
      ["views", "conversation_id = $1", none],
      ["views", "conversation_id = $1", none],
      ["messages", "conversation_id = $1", named],
      ["messages", "conversation_id = $1", none],
      ["messages", "conversation_id = $1", home],
      ["messages", "conversation_id = $1", none],
      ["messages", "conversation_id = $1", none],
      ["views", "conversation_id = $1", none],
    ])
  })
})

describe("GET /api/shapes/messages", () => {
  test("passes Electric's response through, sending Electric's protocol parameters and table=messages", async () => {
    const h = await proxy()
    const response = await h.fetch(
      "/api/shapes/messages?offset=-1&table=users&where=true&columns=text&params%5B1%5D=x&secret=stolen&replica=full",
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("electric-handle")).toEqual(expect.any(String))
    expect(response.headers.get("electric-offset")).toEqual(expect.any(String))
    expect(response.headers.get("content-type")).toContain("application/json")
    for (const name of ["content-encoding", "content-length", "access-control-allow-origin"]) {
      expect(response.headers.get(name)).toBeNull()
    }
    const body = await response.text()
    expect(JSON.parse(body)).toEqual(expect.any(Array))
    const [sent] = h.upstream
    expect(`${sent!.origin}${sent!.pathname}`).toBe(`${await runtime.runPromise(TestDatabase.electricUrl)}/v1/shape`)
    // Signed out, nobody may watch the branch, so the shape is no conversation's.
    expect([...sent!.searchParams]).toEqual([
      ["columns", SYNCED.join(",")],
      ["offset", "-1"],
      ["params[1]", "00000000-0000-0000-0000-000000000000"],
      ["table", "messages"],
      ["where", "conversation_id = $1"],
    ])
    // One line per request, once its body has ended, with the bytes it sent.
    await eventually(() => h.line("chat.shape").length === 1)
    expect(h.only("chat.shape")).toMatchObject({
      level: "INFO",
      annotations: {
        status: 200,
        route: "chat.shape",
        upstream: "electric",
        correlationId: expect.any(String),
        live: false,
        durationMs: expect.any(Number),
        bytes: new TextEncoder().encode(body).byteLength,
        outcome: "complete",
      },
    })
    expect(h.count(ChatMetrics.shapes, { status: "200", live: "false" })).toBe(1)
  })

  test("a request the browser abandons while Electric holds it records one line, aborted", async () => {
    const h = await proxy()
    const release = h.hold()
    const abort = new AbortController()
    const pending = h.fetch("/api/shapes/messages?offset=-1&live=true", { signal: abort.signal }).catch(() => null)
    await eventually(() => h.upstream.length === 1)
    abort.abort()
    // Effect's HttpClient sees the abort once Electric's fetch settles: 499 if before its response, else mid-body.
    release()
    await pending
    await eventually(() => h.line("chat.shape").length === 1)
    expect(h.only("chat.shape")).toMatchObject({
      level: "INFO",
      annotations: { live: true, bytes: 0, durationMs: expect.any(Number), outcome: "aborted" },
    })
  })

  test("forwards every Electric protocol parameter it gets, and drops a subset request's", async () => {
    const h = await proxy()
    await h.fetch(
      "/api/shapes/messages?offset=0_0&handle=h-1&live=true&cursor=7&live_sse=false&log=full&expired_handle=h-0" +
        "&subset__limit=50&subset__order_by=%22position%22%20DESC&subset__where=%22position%22%20%3C%20%241" +
        "&subset__params=%7B%221%22%3A%2210%22%7D&subset__offset=5",
    )
    expect(Object.fromEntries(h.upstream[0]!.searchParams)).toEqual({
      offset: "0_0",
      handle: "h-1",
      live: "true",
      cursor: "7",
      live_sse: "false",
      log: "full",
      expired_handle: "h-0",
      table: "messages",
      where: "conversation_id = $1",
      "params[1]": "00000000-0000-0000-0000-000000000000",
      columns: SYNCED.join(","),
    })
  })

  test("syncs every column of a message but who asked it", async () => {
    const member: Actor = { subject: { kind: "person", id: "person-sentinel-asker" }, role: "member" }
    const h = await proxy({}, member)
    expect((await h.ask({ id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Who asked?" })).status)
      .toBe(202)

    // Follow the shape's log from its start, as a device does: an earlier test may have opened the shape before this
    // ask, so the rows can arrive after its snapshot. Electric may still be replicating the ask, so read until both
    // rows are in. The truncate before each test may reach Electric only now: then it answers 409 must-refetch, and,
    // as a device does, the copy starts again from the shape's beginning.
    let body = ""
    const rows: Array<Record<string, unknown>> = []
    let at = "offset=-1"
    await eventually(async () => {
      const response = await h.fetch(`/api/shapes/messages?${at}`)
      const text = await response.text()
      // A retired Electric handle requires a fresh snapshot, not parsing its error object as rows.
      if (response.status === 409) {
        at = "offset=-1"
        rows.length = 0
        body = ""
        return false
      }
      expect(response.status, text).toBe(200)
      body += text
      if (response.status === 409) {
        rows.length = 0
        at = "offset=-1"
        return false
      }
      expect(response.status).toBe(200)
      for (const message of JSON.parse(text) as Array<{ readonly value?: Record<string, unknown> }>) {
        if (message.value !== undefined) rows.push(message.value)
      }
      at = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
      return rows.length === 2
    }, 10_000)

    for (const row of rows) expect(Object.keys(row).sort()).toEqual([...SYNCED].sort())
    expect(body).not.toContain("person-sentinel-asker")
  })

  test("adds ELECTRIC_SECRET as secret and ELECTRIC_SOURCE_ID as source_id, and never records the secret", async () => {
    const secret = "electric-secret-4b2d"
    const h = await proxy({ ELECTRIC_SECRET: secret, ELECTRIC_SOURCE_ID: "source-1" })
    await h.fetch("/api/shapes/messages?offset=-1&source_id=browser-choice")
    expect(h.upstream[0]!.searchParams.get("secret")).toBe(secret)
    expect(h.upstream[0]!.searchParams.getAll("source_id")).toEqual(["source-1"])
    await eventually(() => h.line("chat.shape").length === 1)
    expect(JSON.stringify(h.logs)).not.toContain(secret)
    for (const span of h.spans) expect(JSON.stringify([...span.attributes])).not.toContain(secret)
  })

  test("502 when Electric can't be reached", async () => {
    const h = await proxy({ ELECTRIC_URL: "http://127.0.0.1:9" })
    const response = await h.fetch("/api/shapes/messages?offset=-1")
    expect(response.status).toBe(502)
    expect(h.only("chat.shape")).toMatchObject({
      level: "ERROR",
      annotations: { status: 502, live: false, bytes: 0, durationMs: expect.any(Number), outcome: "complete" },
    })
  })

  test("405 for another method", async () => {
    const h = await proxy()
    const response = await h.fetch("/api/shapes/messages?offset=-1", { method: "POST" })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
    expect(h.upstream).toHaveLength(0)
    expect(h.only("chat.shape")).toMatchObject({ level: "WARN", annotations: { status: 405, bytes: 0 } })
  })
})
