// The terminal routes (worker/branch/Terminals.ts, decision 0013 §2-§3) and their router (worker/branch/BranchApi.ts)
// through the branch workspace's real routes (worker/test/branch.ts), on this file's schema of the compose Postgres and
// through the compose Electric (`pnpm db:up`). The branch's machine is a test `TerminalSockets`, standing in for the
// Cloudflare binding; `terminal/Open` itself runs in worker/flows/TerminalOpen.test.ts.
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { BRANCHES_ROUTE, SHARES_SHAPE_ROUTE } from "../../src/features/branch/contract.ts"
import {
  MAX_OPEN_BODY_BYTES,
  ADMIT_WAIT_SECONDS,
  OPEN_DEADLINE_SECONDS,
  openExecutionId,
  TERMINALS_ROUTE,
  TERMINALS_SHAPE_ROUTE,
} from "../../src/features/terminal/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "../Actor.ts"
import * as Flows from "../Flows.ts"
import {
  branchHarness,
  type BranchHarness,
  resetBranches,
  shared,
  terminal,
  terminalRows,
  tracked,
} from "../test/branch.ts"
import { eventually, recorded, testFile } from "../test/harness.ts"
import * as BranchApi from "./BranchApi.ts"
import * as Conversations from "./Conversations.ts"
import { TerminalSockets } from "./Sandboxes.ts"
import * as Terminals from "./Terminals.ts"

const runtime = testFile("terminals")
beforeEach(() => resetBranches(runtime))

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member", login: "mona" }
const other: Actor = { subject: { kind: "person", id: "person-other" }, role: "maintainer" }
const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }

const REPO = "github/octocat/spoon-knife"

const open = (actor: Actor | null = member, options: Parameters<typeof branchHarness>[1] = {}) =>
  branchHarness(runtime, { ...(actor === null ? {} : { actor }), ...options })

const json = async (response: Response) => [response.status, await response.json()]

const post = (h: BranchHarness, body: unknown) =>
  h.fetch(TERMINALS_ROUTE, {
    method: "POST",
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  })

const request = (branchId: string, terminalId: string = crypto.randomUUID()) => ({ terminalId, branchId, cols: 120, rows: 40 })

/** `GET /api/terminals/<id>` as the app's own page opens its socket, with `headers` over those. */
const connect = (h: BranchHarness, terminalId: string, headers: Record<string, string> = {}, method = "GET") =>
  h.fetch(`${TERMINALS_ROUTE}/${terminalId}`, {
    method,
    headers: { upgrade: "websocket", connection: "Upgrade", origin: "http://chat.test", ...headers },
  })

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id)

describe("POST /api/terminals", () => {
  test("admits a Member's terminal on an open branch, 202, records it opening and starts terminal/Open", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const h = await open()
    const terminalId = crypto.randomUUID()

    const response = await post(h, { ...request(branch.branchId.toUpperCase(), terminalId.toUpperCase()) })

    expect(await json(response)).toEqual([202, { terminalId }])
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await terminalRows(runtime, branch.branchId)).toEqual([
      expect.objectContaining({ id: terminalId, ownerId: "person-member", ownerLogin: "mona", status: "opening" }),
    ])
    expect(h.starts).toEqual([{
      flow: "terminal/Open",
      executionId: openExecutionId(terminalId),
      payload: {
        terminalId,
        ownerId: "person-member",
        branch: { branchId: branch.branchId, owner: "octocat", name: "spoon-knife", branch: "feature/x" },
      },
    }])
    expect(h.only("terminal.open")).toMatchObject({
      level: "INFO",
      annotations: { terminalId, branchId: branch.branchId, outcome: "opening", status: 202, durationMs: expect.any(Number) },
    })
    expect(h.count(Terminals.requests, { route: "open", outcome: "opening" })).toBe(1)
    expect(h.span("terminal.open")).toHaveLength(1)
    // Ids only: never the branch's name or the person's login.
    expect(recorded(h)).not.toContain("feature/x")
    expect(recorded(h)).not.toContain("mona")
  })

  test("a resend answers the same terminal and starts the same execution; another id answers the live one", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const h = await open()
    const first = request(branch.branchId)

    expect((await post(h, first)).status).toBe(202)
    expect(await json(await post(h, first))).toEqual([200, { terminalId: first.terminalId }])
    expect(await json(await post(h, request(branch.branchId)))).toEqual([200, { terminalId: first.terminalId }])

    expect(h.starts.map((start) => start.executionId)).toEqual([
      openExecutionId(first.terminalId),
      openExecutionId(first.terminalId),
    ])
    expect(ids(await terminalRows(runtime, branch.branchId))).toEqual([first.terminalId])
    expect(h.line("terminal.open").map((line) => line.annotations.outcome)).toEqual(["opening", "existing", "existing"])
    expect(h.count(Terminals.requests, { route: "open", outcome: "existing" })).toBe(2)
  })

  test("each person has their own terminal; a new one drops only the person's ended and failed ones there", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const elsewhere = await tracked(runtime, REPO, "feature/y")
    const [ended, failed, theirs, mineElsewhere] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ]
    await terminal(runtime, { id: ended, branchId: branch.branchId, ownerId: "person-member", status: "ended" })
    await terminal(runtime, { id: failed, branchId: branch.branchId, ownerId: "person-member", status: "failed" })
    await terminal(runtime, { id: theirs, branchId: branch.branchId, ownerId: "person-other", status: "ended" })
    await terminal(runtime, { id: mineElsewhere, branchId: elsewhere.branchId, ownerId: "person-member", status: "ended" })

    const mine = request(branch.branchId)
    expect((await post(await open(), mine)).status).toBe(202)
    const row = (found: { readonly id: string; readonly ownerId: string; readonly ownerLogin: string; readonly status: string }) =>
      [found.id, found.ownerId, found.ownerLogin, found.status]
    expect((await terminalRows(runtime, branch.branchId)).map(row).sort()).toEqual([
      [mine.terminalId, "person-member", "mona", "opening"],
      [theirs, "person-other", "person-other", "ended"],
    ].sort())

    const otherOne = request(branch.branchId)
    expect(await json(await post(await open(other), otherOne))).toEqual([202, { terminalId: otherOne.terminalId }])
    expect((await terminalRows(runtime, branch.branchId)).map(row).sort()).toEqual([
      [mine.terminalId, "person-member", "mona", "opening"],
      // A person whose login sign-in doesn't know is recorded by their id.
      [otherOne.terminalId, "person-other", "person-other", "opening"],
    ].sort())
    expect(ids(await terminalRows(runtime, elsewhere.branchId))).toEqual([mineElsewhere])
  })

  test("an open stuck past its deadline is settled failed by the next open, which is admitted", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const stuck = crypto.randomUUID()
    await terminal(runtime, {
      id: stuck,
      branchId: branch.branchId,
      ownerId: "person-member",
      status: "opening",
      ageSeconds: OPEN_DEADLINE_SECONDS + 1,
    })
    const h = await open()
    const next = request(branch.branchId)

    expect(await json(await post(h, next))).toEqual([202, { terminalId: next.terminalId }])

    // Settled failed, then dropped with the person's other ended ones: only the new terminal is left.
    expect((await terminalRows(runtime, branch.branchId)).map((row) => [row.id, row.status])).toEqual([
      [next.terminalId, "opening"],
    ])
    expect(h.starts.map((start) => start.executionId)).toEqual([openExecutionId(next.terminalId)])
  })

  test("an open still inside its deadline keeps the person's place", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const slow = crypto.randomUUID()
    await terminal(runtime, {
      id: slow,
      branchId: branch.branchId,
      ownerId: "person-member",
      status: "opening",
      ageSeconds: OPEN_DEADLINE_SECONDS - 10,
    })
    const h = await open()
    expect(await json(await post(h, request(branch.branchId)))).toEqual([200, { terminalId: slow }])
    expect(h.starts).toEqual([])
    expect((await terminalRows(runtime, branch.branchId)).map((row) => [row.id, row.status])).toEqual([[slow, "opening"]])
  })

  test("an open waiting for a free machine keeps the person's place for the wait, then past it is settled failed", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const waiting = crypto.randomUUID()
    await terminal(runtime, {
      id: waiting,
      branchId: branch.branchId,
      ownerId: "person-member",
      status: "opening",
      ageSeconds: OPEN_DEADLINE_SECONDS + 600,
    })
    const markWaiting = (seconds: number) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          UPDATE terminal_sessions SET waiting = true, created_at = now() - make_interval(secs => ${seconds})
          WHERE id = ${waiting}`))
    await markWaiting(OPEN_DEADLINE_SECONDS + 600)
    const h = await open()
    expect(await json(await post(h, request(branch.branchId)))).toEqual([200, { terminalId: waiting }])
    expect(h.starts).toEqual([])

    // Past the wait and the open's own deadline, it can't hold the person out any longer.
    await markWaiting(ADMIT_WAIT_SECONDS + OPEN_DEADLINE_SECONDS + 1)
    const next = request(branch.branchId)
    expect(await json(await post(h, next))).toEqual([202, { terminalId: next.terminalId }])
  })

  test("an open admitted after a wait has its deadline from the admission", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const admitted = crypto.randomUUID()
    await terminal(runtime, {
      id: admitted,
      branchId: branch.branchId,
      ownerId: "person-member",
      status: "opening",
      ageSeconds: OPEN_DEADLINE_SECONDS + 600,
    })
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE terminal_sessions SET admitted_at = now() - interval '10 seconds' WHERE id = ${admitted}`))
    const h = await open()
    expect(await json(await post(h, request(branch.branchId)))).toEqual([200, { terminalId: admitted }])
  })

  test("an id another person's terminal holds is 409 id_taken, unless the person has a live terminal to answer", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const taken = crypto.randomUUID()
    await terminal(runtime, { id: taken, branchId: branch.branchId, ownerId: "person-other", status: "open" })
    const h = await open()

    expect(await json(await post(h, request(branch.branchId, taken)))).toEqual([409, { code: "id_taken" }])
    expect(h.line("terminal.open").at(-1)!.annotations).toMatchObject({ code: "id_taken", outcome: "id_taken" })
    const mine = request(branch.branchId)
    expect((await post(h, mine)).status).toBe(202)
    expect(await json(await post(h, request(branch.branchId, taken)))).toEqual([200, { terminalId: mine.terminalId }])
    expect(h.starts.map((start) => start.executionId)).toEqual([openExecutionId(mine.terminalId)])
  })

  test("only someone who may edit an open branch opens one: 401, 403 forbidden, 409 locked, 404 for no branch", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const main = await tracked(runtime, REPO, "main", "locked")
    const restricted = await tracked(runtime, REPO, "release", "restricted")
    // Someone else's branch: shared with the Member to view, they may not open a terminal on it.
    const viewOnly = await tracked(runtime, REPO, "theirs", "open", "person-owner")
    await shared(runtime, viewOnly.branchId, "person-member", "view")

    expect(await json(await post(await open(null), request(branch.branchId)))).toEqual([401, { code: "authentication" }])
    for (const actor of [guest, { ...member, role: null }]) {
      expect(await json(await post(await open(actor), request(branch.branchId)))).toEqual([403, { code: "forbidden" }])
    }
    expect(await json(await post(await open(), request(viewOnly.branchId)))).toEqual([403, { code: "forbidden" }])
    const h = await open()
    expect(await json(await post(h, request(main.branchId)))).toEqual([409, { code: "locked" }])
    expect(await json(await post(h, request(restricted.branchId)))).toEqual([409, { code: "locked" }])
    expect(await json(await post(h, request(crypto.randomUUID())))).toEqual([404, { code: "not_found" }])

    expect(h.line("terminal.open").map((line) => [line.level, line.annotations.outcome])).toEqual([
      ["WARN", "locked"],
      ["WARN", "locked"],
      ["WARN", "not_found"],
    ])
    expect(h.count(Terminals.requests, { route: "open", outcome: "locked" })).toBe(2)
    expect(h.starts).toEqual([])
    expect(await terminalRows(runtime, branch.branchId)).toEqual([])
  })

  test("refuses a body that isn't an open, or is too large, and any method but POST", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const h = await open()
    for (
      const body of [
        "not json",
        { ...request(branch.branchId), terminalId: "not-a-uuid" },
        { ...request("not-a-uuid") },
        { ...request(branch.branchId), cols: 0 },
        { ...request(branch.branchId), rows: 501 },
        { ...request(branch.branchId), cols: 80.5 },
        { terminalId: crypto.randomUUID(), branchId: branch.branchId },
      ]
    ) {
      expect(await json(await post(h, body))).toEqual([400, { code: "invalid" }])
    }
    expect(await json(await post(h, "x".repeat(MAX_OPEN_BODY_BYTES + 1)))).toEqual([413, { code: "invalid" }])
    expect(await json(await post(h, new Uint8Array([0x7b, 0xff, 0xfe])))).toEqual([400, { code: "invalid" }])
    const get = await h.fetch(TERMINALS_ROUTE)
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])
    expect(h.line("terminal.open").at(-1)!.annotations).toMatchObject({ status: 405, outcome: "refused" })
    expect(h.count(Terminals.requests, { route: "open", outcome: "invalid" })).toBe(9)
    expect(h.starts).toEqual([])
  })

  test("a start the remote host refuses is 503, and the terminal stays opening for the resend to start", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    let refuse = true
    const started: Array<string> = []
    const h = await open(member, {
      starter: Flows.FlowStarter.of({
        start: (_, { executionId }) =>
          refuse
            ? Effect.fail(new Flows.StartUnavailable({ errorCode: "rpc" }))
            : Effect.sync(() => void started.push(executionId)),
      }),
    })
    const body = request(branch.branchId)

    expect(await json(await post(h, body))).toEqual([503, { code: "unavailable" }])
    expect(h.only("terminal.open")).toMatchObject({
      level: "ERROR",
      annotations: { errorCode: "@smthrs/mvp/flows/StartUnavailable", status: 503, outcome: "unavailable" },
    })
    expect(h.count(Terminals.requests, { route: "open", outcome: "unavailable" })).toBe(1)
    expect((await terminalRows(runtime, branch.branchId)).map((row) => row.status)).toEqual(["opening"])

    refuse = false
    expect(await json(await post(h, body))).toEqual([200, { terminalId: body.terminalId }])
    expect(started).toEqual([openExecutionId(body.terminalId)])
  })

  test("sessions or Postgres that can't be read are 503 unavailable, logged by the failure's code", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const sessions = await open(null, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })
    expect(await json(await post(sessions, request(branch.branchId)))).toEqual([503, { code: "unavailable" }])
    expect(sessions.only("terminal.open").annotations).toMatchObject({
      errorCode: "@smthrs/mvp/auth/SessionsUnavailable",
    })
    const down = await open(member, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect(await json(await post(down, request(branch.branchId)))).toEqual([503, { code: "unavailable" }])
    expect(down.only("terminal.open").annotations).toMatchObject({ errorCode: expect.stringMatching(/^sql:/) })
  })
})

describe("GET /api/terminals/<id>: the socket", () => {
  /** An open terminal of `person-member` on their own branch, which they shared with `person-other` to view. */
  const opened = async (status: "opening" | "open" | "ended" | "failed" = "open") => {
    const branch = await tracked(runtime, REPO, "feature/x", "open", "person-member")
    await shared(runtime, branch.branchId, "person-other", "view")
    const terminalId = crypto.randomUUID()
    await terminal(runtime, { id: terminalId, branchId: branch.branchId, ownerId: "person-member", status })
    return { branchId: branch.branchId, terminalId }
  }

  /** What the socket attaches as, for `actor`. */
  const as = (terminalId: string, actor: Actor, access: "write" | "read") => ({
    terminalId,
    ownerId: "person-member",
    access,
    principal: actor.subject.id,
    role: actor.role,
  })

  test("attaches the owner to type and someone the branch is shared with to view to watch", async () => {
    const { branchId, terminalId } = await opened()
    const owner = await open()
    const watcher = await open(other)

    expect(await json(await connect(owner, terminalId.toUpperCase()))).toEqual([
      200,
      { attached: as(terminalId, member, "write") },
    ])
    expect(await json(await connect(watcher, terminalId, { origin: "http://chat.test", upgrade: "WebSocket" }))).toEqual([
      200,
      { attached: as(terminalId, other, "read") },
    ])

    expect(owner.sockets.attached).toEqual([{ branchId, attachment: as(terminalId, member, "write") }])
    expect(watcher.sockets.attached).toEqual([{ branchId, attachment: as(terminalId, other, "read") }])
    expect(owner.sockets.checked).toEqual([{ branchId, terminalId, ownerId: "person-member" }])
    expect(owner.only("terminal.connect")).toMatchObject({
      level: "INFO",
      annotations: { terminalId, access: "write", outcome: "attached", status: 200 },
    })
    expect(watcher.only("terminal.connect").annotations).toMatchObject({ access: "read", outcome: "attached" })
    expect(owner.count(Terminals.requests, { route: "connect", outcome: "attached" })).toBe(1)
    expect(owner.span("terminal.connect")).toHaveLength(1)
  })

  test("someone it is shared with to edit types into the owner's terminal; a viewer reads; anyone else is refused", async () => {
    const { branchId, terminalId } = await opened()
    await shared(runtime, branchId, "person-other", "edit")
    const editor = await open(other)
    expect(await json(await connect(editor, terminalId))).toEqual([200, { attached: as(terminalId, other, "write") }])
    // A Guest shared to edit only reads: GitHub gives them no write.
    await shared(runtime, branchId, "person-guest", "edit")
    const guestViewer = await open(guest)
    expect(await json(await connect(guestViewer, terminalId))).toEqual([200, { attached: as(terminalId, guest, "read") }])
    // A Member it isn't shared with may not even watch.
    const stranger = await open({ subject: { kind: "person", id: "person-stranger" }, role: "admin" })
    expect(await json(await connect(stranger, terminalId))).toEqual([403, { code: "forbidden" }])
    expect(stranger.sockets.checked).toEqual([])
  })

  test("only this app's own page may attach: another origin or none is 403 origin, before anything is read", async () => {
    const { terminalId } = await opened()
    const h = await open()
    expect(await json(await connect(h, terminalId, { origin: "http://evil.test" }))).toEqual([403, { code: "origin" }])
    expect(await json(await connect(h, terminalId, { origin: "https://chat.test" }))).toEqual([403, { code: "origin" }])
    const bare = await h.fetch(`${TERMINALS_ROUTE}/${terminalId}`, { headers: { upgrade: "websocket" } })
    expect(await json(bare)).toEqual([403, { code: "origin" }])
    expect(h.sockets.checked).toEqual([])
    expect(h.sockets.attached).toEqual([])
    expect(h.count(Terminals.requests, { route: "connect", outcome: "origin" })).toBe(3)
  })

  test("refuses what isn't a socket for a terminal: 405, 426 upgrade, 404 not_found", async () => {
    const { terminalId } = await opened()
    const h = await open()
    const post = await connect(h, terminalId, {}, "POST")
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"])
    const plain = await h.fetch(`${TERMINALS_ROUTE}/${terminalId}`, { headers: { origin: "http://chat.test" } })
    expect(await json(plain)).toEqual([426, { code: "upgrade" }])
    expect(await json(await connect(h, "not-a-uuid"))).toEqual([404, { code: "not_found" }])
    expect(await json(await connect(h, `${terminalId}/again`))).toEqual([404, { code: "not_found" }])
    expect(await json(await connect(h, crypto.randomUUID()))).toEqual([404, { code: "not_found" }])
    expect(h.line("terminal.connect").map((line) => line.annotations.outcome)).toEqual([
      "refused",
      "upgrade",
      "not_found",
      "not_found",
      "not_found",
    ])
    expect(h.sockets.attached).toEqual([])
  })

  test("signed out is 401; a Guest, the owner included once a Guest, is 403", async () => {
    const { terminalId } = await opened()
    expect(await json(await connect(await open(null), terminalId))).toEqual([401, { code: "authentication" }])
    expect(await json(await connect(await open(guest), terminalId))).toEqual([403, { code: "forbidden" }])
    const demoted = await open({ ...member, role: "guest" })
    expect(await json(await connect(demoted, terminalId))).toEqual([403, { code: "forbidden" }])
    expect(demoted.sockets.checked).toEqual([])
  })

  test("a terminal that isn't open is 409 with its status, and one whose session is gone is 410 and ends lost", async () => {
    const h = await open()
    for (const status of ["opening", "ended", "failed"] as const) {
      const { terminalId } = await opened(status)
      expect(await json(await connect(h, terminalId))).toEqual([409, { code: status }])
      await resetBranches(runtime)
    }
    expect(h.sockets.checked).toEqual([])

    const { branchId, terminalId } = await opened()
    const lost = await open()
    lost.sockets.alive = false
    expect(await json(await connect(lost, terminalId))).toEqual([410, { code: "lost" }])
    expect(await terminalRows(runtime, branchId)).toEqual([
      expect.objectContaining({ id: terminalId, status: "ended", endedReason: "lost", ended: true }),
    ])
    expect(lost.sockets.attached).toEqual([])
    expect(lost.only("terminal.connect")).toMatchObject({ level: "WARN", annotations: { outcome: "lost", status: 410 } })
  })

  test("a machine or Postgres that fails is 503 unavailable, logged by the failure's code", async () => {
    const { terminalId } = await opened()
    const broken = await open(member, {
      sockets: TerminalSockets.of({
        attach: () => Effect.die(new Error("the machine went away")),
        alive: () => Effect.succeed(true),
        enforce: () => Effect.void,
      }),
    })
    expect(await json(await connect(broken, terminalId))).toEqual([503, { code: "unavailable" }])
    expect(broken.only("terminal.connect")).toMatchObject({
      level: "ERROR",
      annotations: { errorCode: "unknown", outcome: "unavailable", status: 503 },
    })
    const down = await open(member, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect(await json(await connect(down, terminalId))).toEqual([503, { code: "unavailable" }])
    expect(down.only("terminal.connect").annotations).toMatchObject({ errorCode: expect.stringMatching(/^sql:/) })
  })
})

describe("GET /api/shapes/terminals", () => {
  /** Reads the shape from its start until `count` rows are in: Electric may still be replicating them. */
  const values = async (h: BranchHarness, query: string, count: number) => {
    const rows: Array<Record<string, unknown>> = []
    let at = "offset=-1"
    await eventually(async () => {
      const response = await h.fetch(`${TERMINALS_SHAPE_ROUTE}?${query}&${at}`)
      expect(response.status).toBe(200)
      for (const message of (await response.json()) as Array<{ readonly value?: Record<string, unknown> }>) {
        if (message.value !== undefined) rows.push(message.value)
      }
      at = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
      return rows.length >= count
    }, 10_000)
    return rows
  }

  test("someone who may view a branch syncs its terminals, by the branch's id", async () => {
    const branch = await tracked(runtime, REPO, "feature/x", "open", "person-owner")
    await shared(runtime, branch.branchId, "person-member", "view")
    const elsewhere = await tracked(runtime, REPO, "feature/y")
    const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()]
    await terminal(runtime, { id: mine, branchId: branch.branchId, ownerId: "person-member", status: "open" })
    await terminal(runtime, { id: theirs, branchId: elsewhere.branchId, ownerId: "person-member", status: "open" })
    const h = await open()

    const rows = await values(h, `branch=${branch.branchId.toUpperCase()}`, 1)

    expect(rows.map((row) => row.id)).toEqual([mine])
    expect(rows[0]).toMatchObject({ branch_id: branch.branchId, owner_id: "person-member", status: "open" })
    expect(Object.fromEntries(h.electric[0]!.searchParams)).toEqual({
      offset: "-1",
      table: "terminal_sessions",
      where: "branch_id = $1",
      "params[1]": branch.branchId,
    })
    await eventually(() => h.line("terminal.shape").length >= 1)
    expect(h.count(Terminals.shapes, { status: "200", live: "false" })).toBeGreaterThanOrEqual(1)
  })

  test("anyone who may not view, or names no branch, gets a shape with no branch's rows", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const private_ = await tracked(runtime, REPO, "feature/private", "open", "person-owner")
    await terminal(runtime, { id: crypto.randomUUID(), branchId: branch.branchId, ownerId: "person-member", status: "open" })
    const cases: ReadonlyArray<[BranchHarness, string]> = [
      [await open(null), `branch=${branch.branchId}`],
      [await open(guest), `branch=${branch.branchId}`],
      [await open(), `branch=${private_.branchId}`],
      [await open(), `branch=${crypto.randomUUID()}`],
      [await open(), "branch=not-a-uuid"],
      [await open(), "where=true"],
    ]
    for (const [h, query] of cases) {
      const response = await h.fetch(`${TERMINALS_SHAPE_ROUTE}?offset=-1&${query}`)
      expect(response.status).toBe(200)
      const rows = (await response.json()) as Array<{ readonly value?: unknown }>
      expect(rows.filter((row) => row.value !== undefined)).toEqual([])
      expect(h.electric[0]!.searchParams.get("params[1]")).toBe("00000000-0000-0000-0000-000000000000")
      expect(h.electric[0]!.searchParams.get("where")).toBe("branch_id = $1")
    }
  })

  test("while sessions or Postgres can't be read, the request is refused 503 and Electric is never asked", async () => {
    const branch = await tracked(runtime, REPO, "feature/x")
    const unreadable = Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) }))
    const h = await open(null, { sessions: unreadable })
    const response = await h.fetch(`${TERMINALS_SHAPE_ROUTE}?offset=-1&handle=h-1&branch=${branch.branchId}`)
    expect([response.status, response.headers.get("retry-after")]).toEqual([503, "5"])
    expect(h.electric).toEqual([])
    const down = await open(member, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect((await down.fetch(`${TERMINALS_SHAPE_ROUTE}?offset=-1&branch=${branch.branchId}`)).status).toBe(503)
    expect(down.electric).toEqual([])
  })
})

describe("BranchApi", () => {
  test("handles the branch, sharing, room and terminal routes and nothing else", () => {
    for (
      const path of [
        BRANCHES_ROUTE,
        `${BRANCHES_ROUTE}/x/shares`,
        `${BRANCHES_ROUTE}/x/room`,
        SHARES_SHAPE_ROUTE,
        TERMINALS_ROUTE,
        TERMINALS_SHAPE_ROUTE,
        `${TERMINALS_ROUTE}/x`,
      ]
    ) {
      expect([path, BranchApi.handles(path)]).toEqual([path, true])
    }
    for (const path of ["/api/branch", "/api/terminalsx", "/api/shapes/branches", "/api/questions"]) {
      expect([path, BranchApi.handles(path)]).toEqual([path, false])
    }
  })

  test("a path it doesn't handle is 404, a branch's other paths included", async () => {
    const h = await open()
    expect((await h.fetch("/api/nothing-here")).status).toBe(404)
    expect((await h.fetch(`${BRANCHES_ROUTE}/x/other`)).status).toBe(404)
    expect(h.logs).toEqual([])
  })
})



test("a failed launch keeps the persisted ephemeral namespace for retry", async () => {
  const { branch } = await runtime.runPromise(Conversations.track(REPO, "private-work", "open", "a".repeat(40), member.subject.id, undefined, "ephemeral"))
  const payloads: Array<unknown> = []
  const h = await open(member, { starter: { start: (_flow, options) => {
    payloads.push(options.payload)
    return Effect.fail(new Flows.StartUnavailable({ errorCode: "injected" }))
  } } })
  const body = request(branch.branchId)
  const response = await post(h, body)
  expect(response.status).toBe(503)
  expect((await post(h, body)).status).toBe(503)
  expect(payloads).toHaveLength(2)
  expect(payloads[0]).toMatchObject({ branch: { branchId: branch.branchId, namespace: "ephemeral" } })
  expect(payloads[1]).toEqual(payloads[0])
  expect(await terminalRows(runtime, branch.branchId)).toEqual([
    expect.objectContaining({ id: body.terminalId, status: "opening" }),
  ])
})

test("a failed launch keeps the persisted GitHub forge for retry", async () => {
  const { branch } = await runtime.runPromise(Conversations.track(REPO, "private-work", "open", "a".repeat(40), member.subject.id, undefined, "default", "github"))
  const payloads: Array<unknown> = []
  const h = await open(member, { starter: { start: (_flow, options) => {
    payloads.push(options.payload)
    return Effect.fail(new Flows.StartUnavailable({ errorCode: "injected" }))
  } } })
  const body = request(branch.branchId)
  const response = await post(h, body)
  expect(response.status).toBe(503)
  expect((await post(h, body)).status).toBe(503)
  expect(payloads).toHaveLength(2)
  expect(payloads[0]).toMatchObject({ branch: { branchId: branch.branchId, forge: "github" } })
  expect(payloads[1]).toEqual(payloads[0])
  expect(await terminalRows(runtime, branch.branchId)).toEqual([
    expect.objectContaining({ id: body.terminalId, status: "opening" }),
  ])
})
