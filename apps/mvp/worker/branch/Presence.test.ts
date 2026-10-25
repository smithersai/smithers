// `GET /api/branches/<id>/room` (worker/branch/Presence.ts, decision 0013 §4) through the branch workspace's real routes
// (worker/test/branch.ts) on this file's schema of the compose Postgres (`pnpm db:up`). The branch's room is a test
// `Rooms` that records who joined, standing in for the Cloudflare Durable Object (worker/BranchRooms.ts).
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { roomRoute } from "../../src/features/branch/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "../Actor.ts"
import { branchHarness, type BranchHarness, resetBranches, shared, tracked } from "../test/branch.ts"
import { recorded, testFile } from "../test/harness.ts"
import { BranchRoles } from "./Access.ts"
import * as Presence from "./Presence.ts"

const runtime = testFile("presence")
beforeEach(() => resetBranches(runtime))

const REPO = "github/octocat/spoon-knife"

const maya: Actor = { subject: { kind: "person", id: "person-maya" }, role: "member", login: "maya" }
const gus: Actor = { subject: { kind: "person", id: "person-gus" }, role: "guest" }

const open = (actor: Actor | null = maya, options: Parameters<typeof branchHarness>[1] = {}) =>
  branchHarness(runtime, { ...(actor === null ? {} : { actor }), ...options })

const json = async (response: Response) => [response.status, await response.json()]

/** The socket request the app's own page sends, with `headers` over its own. */
const join = (h: BranchHarness, branchId: string, headers: Record<string, string> = {}, method = "GET") =>
  h.fetch(roomRoute(branchId), {
    method,
    headers: { upgrade: "websocket", connection: "Upgrade", origin: "http://chat.test", ...headers },
  })

describe("GET /api/branches/<id>/room", () => {
  test("joins with the role on the branch's repository, which the room re-checks shares with (decision 0079)", async () => {
    const branch = await tracked(runtime, REPO, "feature/elsewhere", "open")
    await shared(runtime, branch.branchId, "person-gus", "edit")
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO github_repositories (repo_id, installation_id) VALUES (${REPO}, 7)`))
    try {
      // The deployment's Guest, a Maintainer on the repository: joins to edit, as its Maintainer.
      const roles = Layer.succeed(BranchRoles, BranchRoles.of({ roleOn: () => Effect.succeed("maintainer") }))
      const h = await open(gus, { branchRoles: roles })
      expect(await json(await join(h, branch.branchId))).toEqual([
        200,
        { joined: { principal: "person-gus", name: "person-gus", role: "maintainer", access: "edit" } },
      ])
    } finally {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE github_repositories`))
    }
  })

  test("joins the owner, and someone it is shared with, as the session says, with what they may do", async () => {
    const branch = await tracked(runtime, REPO, "feature/room", "open", "person-maya")
    await shared(runtime, branch.branchId, "person-gus", "edit")
    const owner = await open()
    expect(await json(await join(owner, branch.branchId.toUpperCase()))).toEqual([
      200,
      { joined: { principal: "person-maya", name: "maya", role: "member", access: "owner" } },
    ])
    // A Guest shared to edit joins to view; with no login the room names them by their id.
    const guest = await open(gus)
    expect(await json(await join(guest, branch.branchId, { upgrade: "WebSocket" }))).toEqual([
      200,
      { joined: { principal: "person-gus", name: "person-gus", role: "guest", access: "view" } },
    ])
    expect(owner.rooms.joined).toEqual([
      {
        branchId: branch.branchId,
        member: { principal: "person-maya", name: "maya", role: "member", access: "owner" },
      },
    ])
    expect(owner.only("branch.room")).toMatchObject({
      level: "INFO",
      annotations: { branchId: branch.branchId, access: "owner", outcome: "joined", status: 200 },
    })
    expect(owner.count(Presence.joins, { outcome: "joined" })).toBe(1)
    expect(owner.span("branch.room")).toHaveLength(1)
    expect(recorded(owner)).not.toContain("maya\"")
  })

  test("refuses who may not view: 401 signed out, 403 for a Member it isn't shared with, 404 for no branch", async () => {
    const branch = await tracked(runtime, REPO, "feature/room", "open", "person-owner")
    expect(await json(await join(await open(null), branch.branchId))).toEqual([401, { code: "authentication" }])
    const stranger = await open()
    expect(await json(await join(stranger, branch.branchId))).toEqual([403, { code: "forbidden" }])
    expect(await json(await join(stranger, crypto.randomUUID()))).toEqual([404, { code: "not_found" }])
    expect(await json(await join(stranger, "not-a-branch"))).toEqual([404, { code: "not_found" }])
    expect(stranger.rooms.joined).toEqual([])
    expect(stranger.line("branch.room").map((line) => line.annotations.outcome)).toEqual([
      "forbidden",
      "not_found",
      "not_found",
    ])
  })

  test("only this app's own page, asking for a socket with GET: 403 origin, 426 upgrade, 405", async () => {
    const branch = await tracked(runtime, REPO, "feature/room", "open", "person-maya")
    const h = await open()
    expect(await json(await join(h, branch.branchId, { origin: "http://evil.test" }))).toEqual([403, { code: "origin" }])
    const plain = await h.fetch(roomRoute(branch.branchId), { headers: { origin: "http://chat.test" } })
    expect(await json(plain)).toEqual([426, { code: "upgrade" }])
    const post = await join(h, branch.branchId, {}, "POST")
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"])
    expect(h.rooms.joined).toEqual([])
    expect(h.line("branch.room").map((line) => line.annotations.outcome)).toEqual(["origin", "upgrade", "method"])
  })

  test("sessions, Postgres or a room that fail are 503 unavailable, logged by the failure's code", async () => {
    const branch = await tracked(runtime, REPO, "feature/room", "open", "person-maya")
    const sessions = await open(null, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })
    expect(await json(await join(sessions, branch.branchId))).toEqual([503, { code: "unavailable" }])
    expect(sessions.only("branch.room")).toMatchObject({
      level: "ERROR",
      annotations: { errorCode: "@smthrs/mvp/auth/SessionsUnavailable", outcome: "unavailable" },
    })
    const down = await open(maya, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect(await json(await join(down, branch.branchId))).toEqual([503, { code: "unavailable" }])
    expect(down.only("branch.room").annotations.errorCode).toMatch(/^sql:/)
  })
})
