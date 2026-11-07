// Sharing a branch (worker/branch/Shares.ts, decision 0013 §2 and §4) through the branch workspace's real routes
// (worker/test/branch.ts), on this file's schema of the compose Postgres and through the compose Electric (`pnpm
// db:up`). The branch's machine and room are test services that record what each change held them to.
import { Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { MAX_SHARE_BODY_BYTES, MAX_SHARES, SHARES_SHAPE_ROUTE, sharesRoute } from "../../src/features/branch/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "../Actor.vibe"
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
import { Directory, DirectoryUnavailable } from "./People.vibe"
import * as Shares from "./Shares.ts"
import * as Conversations from "./Conversations.ts"

const runtime = testFile("shares")
beforeEach(() => resetBranches(runtime))

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

const REPO = "github/octocat/spoon-knife"

const maya: Actor = { subject: { kind: "person", id: "person-maya" }, role: "member", login: "maya" }
const ben: Actor = { subject: { kind: "person", id: "person-ben" }, role: "member", login: "ben" }

/** A login no record may carry. */
const SENTINEL = "Sentinel-Login-7f3a"

/** The people the directory knows beside the file's `people`, as local development's are. */
const known = [
  { id: "person-ben", login: "ben" },
  { id: "person-sentinel", login: SENTINEL },
  { id: "person-gus", login: "gus" },
]

const open = (actor: Actor | null = maya, options: Parameters<typeof branchHarness>[1] = {}) =>
  branchHarness(runtime, { ...(actor === null ? {} : { actor }), known, ...options })

const json = async (response: Response) => [response.status, await response.json()]

const post = (h: BranchHarness, branchId: string, body: unknown) =>
  h.fetch(sharesRoute(branchId), {
    method: "POST",
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  })

/** Maya's own branch. */
const mine = () => tracked(runtime, REPO, "feature/share", "open", "person-maya")

/** Branch `branchId`'s permission list, as Postgres holds it. */
const grants = (branchId: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly grantee: string; readonly login: string | null; readonly access: string; readonly sharedBy: string | null }>`
      SELECT grantee, login, access, shared_by AS "sharedBy" FROM branch_shares WHERE branch_id = ${branchId}
      ORDER BY grantee`))

describe("POST /api/branches/<id>/shares", () => {
  test("sharing and revocation invalidate repository refs after their new access is persisted", async () => {
    const { branch } = await runtime.runPromise(Conversations.track(REPO, "private", "open", "a".repeat(40), maya.subject.id, undefined, "ephemeral"))
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO repositories (id, owner, name, status, refs_changed_at)
        VALUES (${REPO}, 'octocat', 'spoon-knife', 'cloning', '2000-01-01')`
      yield* sql`CREATE TABLE share_ref_visibility (access text)`
      yield* sql.unsafe(`CREATE FUNCTION record_share_ref_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO share_ref_visibility SELECT s.access FROM branches b
            LEFT JOIN branch_shares s ON s.branch_id = b.id AND s.grantee = 'repository'
            WHERE b.repo_id = NEW.id AND b.name = 'private';
          RETURN NEW;
        END $$`)
      yield* sql`CREATE TRIGGER record_share_ref_visibility AFTER UPDATE OF refs_changed_at ON repositories
        FOR EACH ROW EXECUTE FUNCTION record_share_ref_visibility()`
    }))
    try {
      const h = await open()
      const changes = ["view", "view", "edit", null, null] as const
      for (const access of changes) expect((await post(h, branch.branchId, { grantee: "repository", access })).status).toBe(200)
      expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT access FROM share_ref_visibility`)))
        .toEqual([{ access: "view" }, { access: "edit" }, { access: null }])
    } finally {
      await runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP TRIGGER record_share_ref_visibility ON repositories`
        yield* sql`DROP FUNCTION record_share_ref_visibility()`
        yield* sql`DROP TABLE share_ref_visibility`
        yield* sql`DELETE FROM repositories WHERE id = ${REPO}`
      }))
    }
  })

  test("the owner shares with a person by login, to view; again changes nothing; the sessions open are held to it", async () => {
    const branch = await mine()
    const h = await open()

    const first = await post(h, branch.branchId.toUpperCase(), { login: "BEN", access: "view" })
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toBe("no-store")
    expect(await first.json()).toEqual({ txid: expect.any(Number) })
    expect(await grants(branch.branchId)).toEqual([
      { grantee: "person-ben", login: "ben", access: "view", sharedBy: "person-maya" },
    ])
    const policy = { createdBy: "person-maya", grants: { "person-ben": "view" } }
    expect(h.sockets.enforced).toEqual([{ branchId: branch.branchId, policy, revoked: [] }])
    expect(h.rooms.enforced).toEqual([{ branchId: branch.branchId, policy }])

    expect(await json(await post(h, branch.branchId, { login: "ben", access: "view" }))).toEqual([200, { txid: null }])
    expect(h.sockets.enforced).toHaveLength(2)
    expect(h.line("branch.share").map((line) => [line.level, line.annotations])).toEqual([
      ["INFO", expect.objectContaining({ branchId: branch.branchId, change: "person", outcome: "changed", status: 200 })],
      ["INFO", expect.objectContaining({ change: "person", outcome: "unchanged", revoked: 0 })],
    ])
    expect(h.count(Shares.changes, { change: "person", outcome: "changed" })).toBe(1)
    expect(h.span("branch.share")).toHaveLength(2)
  })

  test("a person who signed in is found in people, by their login in any case", async () => {
    const branch = await mine()
    const personId = crypto.randomUUID()
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}, 9001, 'Octo-Cat')`))
    const h = await open()
    expect(await json(await post(h, branch.branchId, { login: "octo-cat", access: "edit" }))).toEqual([
      200,
      { txid: expect.any(Number) },
    ])
    expect(await grants(branch.branchId)).toEqual([
      { grantee: personId, login: "Octo-Cat", access: "edit", sharedBy: "person-maya" },
    ])
  })

  test("sharing again with a new access, or a person's new login, updates the one row", async () => {
    const branch = await mine()
    const h = await open()
    await post(h, branch.branchId, { login: "ben", access: "view" })
    expect(await json(await post(h, branch.branchId, { login: "ben", access: "edit" }))).toEqual([
      200,
      { txid: expect.any(Number) },
    ])
    expect(await grants(branch.branchId)).toEqual([
      expect.objectContaining({ grantee: "person-ben", login: "ben", access: "edit" }),
    ])
  })

  test("changes and removes a grant by its grantee; changing it to what it is changes nothing", async () => {
    const branch = await mine()
    await shared(runtime, branch.branchId, "person-ben", "view", "ben")
    const h = await open()
    expect(await json(await post(h, branch.branchId, { grantee: "person-ben", access: "edit" }))).toEqual([
      200,
      { txid: expect.any(Number) },
    ])
    expect(await json(await post(h, branch.branchId, { grantee: "person-ben", access: "edit" }))).toEqual([
      200,
      { txid: null },
    ])
    expect(await json(await post(h, branch.branchId, { grantee: "person-ben", access: null }))).toEqual([
      200,
      { txid: expect.any(Number) },
    ])
    expect(await grants(branch.branchId)).toEqual([])
    expect(await json(await post(h, branch.branchId, { grantee: "person-ben", access: null }))).toEqual([
      200,
      { txid: null },
    ])
    expect(await json(await post(h, branch.branchId, { grantee: "person-nobody", access: "view" }))).toEqual([
      404,
      { code: "not_found" },
    ])
    expect(h.line("branch.share").map((line) => line.annotations.change)).toEqual([
      "access",
      "access",
      "remove",
      "remove",
      "access",
    ])
  })

  test("the link: anyone in the repository with it views, or edits, until the owner restricts it again", async () => {
    const branch = await mine()
    const h = await open()
    for (const access of ["view", "edit", "edit"] as const) {
      await post(h, branch.branchId, { grantee: "repository", access })
    }
    expect(await grants(branch.branchId)).toEqual([
      { grantee: "repository", login: null, access: "edit", sharedBy: "person-maya" },
    ])
    expect(h.line("branch.share").map((line) => line.annotations.outcome)).toEqual(["changed", "changed", "unchanged"])
    await post(h, branch.branchId, { grantee: "repository", access: null })
    expect(await grants(branch.branchId)).toEqual([])
    expect(h.rooms.enforced.at(-1)).toEqual({
      branchId: branch.branchId,
      policy: { createdBy: "person-maya", grants: {} },
    })
    expect(h.count(Shares.changes, { change: "link", outcome: "changed" })).toBe(3)
  })

  test("removing a person ends their terminals on the branch, revoked; a Member the link still reaches keeps theirs", async () => {
    const branch = await mine()
    await shared(runtime, branch.branchId, "person-ben", "edit", "ben")
    await shared(runtime, branch.branchId, "person-gus", "view", "gus")
    await shared(runtime, branch.branchId, "repository", "view")
    const [bens, guss, mayas] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    await terminal(runtime, { id: bens, branchId: branch.branchId, ownerId: "person-ben", status: "open" })
    await terminal(runtime, { id: guss, branchId: branch.branchId, ownerId: "person-gus", status: "opening", ownerRole: "guest" })
    await terminal(runtime, { id: mayas, branchId: branch.branchId, ownerId: "person-maya", status: "open" })
    const h = await open()

    // Ben, a Member, still views by the link: his terminal stays. Gus, a Guest, has nothing left: his ends.
    await post(h, branch.branchId, { grantee: "person-ben", access: null })
    await post(h, branch.branchId, { grantee: "person-gus", access: null })

    expect(h.sockets.enforced.map((call) => call.revoked)).toEqual([[], [{ terminalId: guss, ownerId: "person-gus" }]])
    const rows = Object.fromEntries((await terminalRows(runtime, branch.branchId)).map((row) => [row.id, row]))
    expect([rows[bens]!.status, rows[guss]!.status, rows[guss]!.endedReason, rows[mayas]!.status]).toEqual([
      "open",
      "ended",
      "revoked",
      "open",
    ])
    expect(h.line("branch.share").map((line) => line.annotations.revoked)).toEqual([0, 1])
    expect(h.count(Shares.revocations, {})).toBe(1)
  })

  test("a machine or room that can't be reached is 503; the change stands, and sending it again applies it", async () => {
    const branch = await mine()
    await shared(runtime, branch.branchId, "person-gus", "view", "gus")
    const terminalId = crypto.randomUUID()
    await terminal(runtime, { id: terminalId, branchId: branch.branchId, ownerId: "person-gus", status: "open", ownerRole: "guest" })
    const h = await open()
    h.sockets.failing = true
    expect(await json(await post(h, branch.branchId, { grantee: "person-gus", access: null }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(await grants(branch.branchId)).toEqual([])
    // The terminal ends only once its machine has been told.
    expect((await terminalRows(runtime, branch.branchId))[0]!.status).toBe("open")
    expect(h.only("branch.share")).toMatchObject({
      level: "ERROR",
      annotations: { errorCode: "@smthrs/mvp/branch/SandboxUnavailable", outcome: "unavailable", status: 503 },
    })

    h.sockets.failing = false
    h.rooms.failing = true
    expect(await json(await post(h, branch.branchId, { grantee: "person-gus", access: null }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(h.line("branch.share").at(-1)!.annotations.errorCode).toBe("@smthrs/mvp/branch/RoomUnavailable")

    h.rooms.failing = false
    expect(await json(await post(h, branch.branchId, { grantee: "person-gus", access: null }))).toEqual([
      200,
      { txid: null },
    ])
    expect(h.sockets.enforced.at(-1)!.revoked).toEqual([{ terminalId, ownerId: "person-gus" }])
    expect((await terminalRows(runtime, branch.branchId))[0]).toMatchObject({ status: "ended", endedReason: "revoked" })
  })

  test("only the owner shares: 401 signed out, 403 for an editor or a team branch, 404 for no branch", async () => {
    const branch = await mine()
    await shared(runtime, branch.branchId, "person-ben", "edit", "ben")
    const team = await tracked(runtime, REPO, "team")
    const body = { login: "gus", access: "view" }
    expect(await json(await post(await open(null), branch.branchId, body))).toEqual([401, { code: "authentication" }])
    expect(await json(await post(await open(ben), branch.branchId, body))).toEqual([403, { code: "forbidden" }])
    expect(await json(await post(await open(), team.branchId, body))).toEqual([403, { code: "forbidden" }])
    expect(await json(await post(await open(), crypto.randomUUID(), body))).toEqual([404, { code: "not_found" }])
    expect(await json(await post(await open(), "not-a-branch", body))).toEqual([404, { code: "not_found" }])
    expect(await grants(branch.branchId)).toEqual([expect.objectContaining({ grantee: "person-ben" })])
  })

  test("anyone it is shared with may remove their own access, and nothing else", async () => {
    const branch = await mine()
    await shared(runtime, branch.branchId, "person-ben", "edit", "ben")
    await shared(runtime, branch.branchId, "person-gus", "view", "gus")
    const h = await open(ben)
    expect(await json(await post(h, branch.branchId, { grantee: "person-gus", access: null }))).toEqual([
      403,
      { code: "forbidden" },
    ])
    expect(await json(await post(h, branch.branchId, { grantee: "person-ben", access: "view" }))).toEqual([
      403,
      { code: "forbidden" },
    ])
    expect(await json(await post(h, branch.branchId, { grantee: "person-ben", access: null }))).toEqual([
      200,
      { txid: expect.any(Number) },
    ])
    expect(await grants(branch.branchId)).toEqual([expect.objectContaining({ grantee: "person-gus" })])
    expect(h.rooms.enforced).toHaveLength(1)
  })

  test("a login no one signed in with is 404 no_person; sharing with yourself is 400; the 101st person is 409", async () => {
    const branch = await mine()
    const h = await open(maya, { known: [...known, { id: "person-maya", login: "maya" }] })
    expect(await json(await post(h, branch.branchId, { login: "nobody-here", access: "view" }))).toEqual([
      404,
      { code: "no_person" },
    ])
    expect(await json(await post(h, branch.branchId, { login: "maya", access: "edit" }))).toEqual([
      400,
      { code: "invalid" },
    ])
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`
        INSERT INTO branch_shares (branch_id, grantee, login, access)
        SELECT ${branch.branchId}, 'person-' || n, 'p' || n, 'view' FROM generate_series(1, ${MAX_SHARES}) AS n`))
    expect(await json(await post(h, branch.branchId, { login: "ben", access: "view" }))).toEqual([
      409,
      { code: "too_many" },
    ])
    // Someone already on the list can still be changed.
    expect(await json(await post(h, branch.branchId, { grantee: "person-1", access: "edit" }))).toEqual([
      200,
      { txid: expect.any(Number) },
    ])
  })

  test("refuses anything but a valid POST: 405, 400 invalid, 413", async () => {
    const branch = await mine()
    const h = await open()
    for (
      const body of [
        "not json",
        { login: "-ben", access: "view" },
        { login: "ben", access: "owner" },
        { login: "a".repeat(40), access: "view" },
        { grantee: "", access: "view" },
        { grantee: "x".repeat(101), access: null },
        { grantee: "person-ben" },
      ]
    ) {
      expect(await json(await post(h, branch.branchId, body))).toEqual([400, { code: "invalid" }])
    }
    expect(await json(await post(h, branch.branchId, "x".repeat(MAX_SHARE_BODY_BYTES + 1)))).toEqual([
      413,
      { code: "invalid" },
    ])
    expect(await json(await post(h, branch.branchId, new Uint8Array([0x7b, 0xff, 0xfe])))).toEqual([
      400,
      { code: "invalid" },
    ])
    const get = await h.fetch(sharesRoute(branch.branchId))
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])
    expect(h.count(Shares.changes, { change: "none", outcome: "invalid" })).toBe(9)
    expect(h.count(Shares.changes, { change: "none", outcome: "method" })).toBe(1)
  })

  test("sessions, people or Postgres that can't be read are 503 unavailable, logged by the failure's code", async () => {
    const branch = await mine()
    const sessions = await open(null, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })
    expect(await json(await post(sessions, branch.branchId, { login: "ben", access: "view" }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    const people = await open(maya, {
      directory: Directory.of({ find: () => Effect.fail(new DirectoryUnavailable()) }),
    })
    expect(await json(await post(people, branch.branchId, { login: "ben", access: "view" }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(people.only("branch.share").annotations.errorCode).toBe("@smthrs/mvp/branch/DirectoryUnavailable")
    const down = await open(maya, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect(await json(await post(down, branch.branchId, { login: "ben", access: "view" }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(down.only("branch.share").annotations.errorCode).toMatch(/^sql:/)
    // Postgres refusing the write itself: nothing is written, and nothing is held to it.
    const refusing = await open(maya, { known: [{ id: "p".repeat(101), login: "toolong" }] })
    expect(await json(await post(refusing, branch.branchId, { login: "toolong", access: "view" }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(await grants(branch.branchId)).toEqual([])
    expect(refusing.sockets.enforced).toEqual([])
  })

  test("no record carries a login", async () => {
    const branch = await mine()
    const h = await open()
    await post(h, branch.branchId, { login: SENTINEL, access: "view" })
    await post(h, branch.branchId, { login: "sentinel-login-7f3b", access: "view" })
    expect(await grants(branch.branchId)).toEqual([expect.objectContaining({ login: SENTINEL })])
    expect(recorded(h).toLowerCase()).not.toContain("sentinel-login")
  })
})

describe("GET /api/shapes/shares", () => {
  /** Reads the shape from its start until `count` rows are in: Electric may still be replicating them. */
  const values = async (h: BranchHarness, query: string, count: number) => {
    const rows: Array<Record<string, unknown>> = []
    let at = "offset=-1"
    await eventually(async () => {
      const response = await h.fetch(`${SHARES_SHAPE_ROUTE}?${query}&${at}`)
      expect(response.status).toBe(200)
      for (const message of (await response.json()) as Array<{ readonly value?: Record<string, unknown> }>) {
        if (message.value !== undefined) rows.push(message.value)
      }
      at = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
      return rows.length >= count
    }, 10_000)
    return rows
  }

  test("the owner syncs the branch's permission list", async () => {
    const branch = await mine()
    await shared(runtime, branch.branchId, "person-ben", "edit", "ben")
    await shared(runtime, branch.branchId, "repository", "view")
    const h = await open()
    const rows = await values(h, `branch=${branch.branchId.toUpperCase()}`, 2)
    expect(rows.map((row) => [row.grantee, row.login, row.access]).sort()).toEqual([
      ["person-ben", "ben", "edit"],
      ["repository", null, "view"],
    ])
    expect(Object.fromEntries(h.electric[0]!.searchParams)).toEqual({
      offset: "-1",
      table: "branch_shares",
      where: "branch_id = $1",
      "params[1]": branch.branchId,
    })
    await eventually(() => h.line("branch.shares.shape").length >= 1)
    expect(h.count(Shares.shapes, { status: "200", live: "false" })).toBeGreaterThanOrEqual(1)
  })

  test("anyone but the owner, or a request naming no branch, gets a shape with no branch's rows", async () => {
    const branch = await mine()
    await shared(runtime, branch.branchId, "person-ben", "edit", "ben")
    const cases: ReadonlyArray<[BranchHarness, string]> = [
      [await open(null), `branch=${branch.branchId}`],
      [await open(ben), `branch=${branch.branchId}`],
      [await open(), `branch=${crypto.randomUUID()}`],
      [await open(), "branch=not-a-uuid"],
      [await open(), "where=true"],
    ]
    for (const [h, query] of cases) {
      const response = await h.fetch(`${SHARES_SHAPE_ROUTE}?offset=-1&${query}`)
      expect(response.status).toBe(200)
      const rows = (await response.json()) as Array<{ readonly value?: unknown }>
      expect(rows.filter((row) => row.value !== undefined)).toEqual([])
      expect(h.electric[0]!.searchParams.get("params[1]")).toBe("00000000-0000-0000-0000-000000000000")
    }
  })

  test("while sessions or Postgres can't be read, the request is refused 503 and Electric is never asked", async () => {
    const branch = await mine()
    const unreadable = Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) }))
    const sessions = await open(null, { sessions: unreadable })
    const response = await sessions.fetch(`${SHARES_SHAPE_ROUTE}?offset=-1&handle=h-1&branch=${branch.branchId}`)
    expect([response.status, response.headers.get("retry-after")]).toEqual([503, "5"])
    expect(sessions.electric).toEqual([])
    const down = await open(maya, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect((await down.fetch(`${SHARES_SHAPE_ROUTE}?offset=-1&branch=${branch.branchId}`)).status).toBe(503)
    expect(down.electric).toEqual([])
  })
})

describe("Directory", () => {
  test("finds local people first, then people who signed in, ignoring case; nobody else", async () => {
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const directory = await runtime.runPromise(
      Effect.service(Directory).pipe(Effect.provide(Directory.layer(scratch.database, [{ id: "local", login: "Local" }]))),
    )
    const personId = crypto.randomUUID()
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}, 9002, 'Hubot')`))
    expect(await runtime.runPromise(directory.find("LOCAL"))).toEqual(Option.some({ id: "local", login: "Local" }))
    expect(await runtime.runPromise(directory.find("hubot"))).toEqual(Option.some({ id: personId, login: "Hubot" }))
    expect(await runtime.runPromise(directory.find("nobody"))).toEqual(Option.none())
  })

  test("people who can't be read fail as DirectoryUnavailable; local people are still found", async () => {
    const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const directory = await runtime.runPromise(
      Effect.service(Directory).pipe(Effect.provide(Directory.layer(down, [{ id: "local", login: "local" }]))),
    )
    expect(await runtime.runPromise(directory.find("local"))).toEqual(Option.some({ id: "local", login: "local" }))
    expect(await runtime.runPromise(Effect.flip(directory.find("hubot")))).toEqual(new DirectoryUnavailable())
  })
})
