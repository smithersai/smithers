// `GET /api/conversations/<conversationId>/access` (worker/branch/ConversationApi.vibe, docs/features/conversations.md):
// whether the signed-in person may read a conversation now, through the branch workspace's real routes
// (worker/test/branch.ts) against the compose Postgres and Electric, in this file's own schema (worker/test/harness.ts).
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { sharesRoute } from "../../src/features/branch/contract.ts"
import { accessPath, ARCHIVE_ROUTE, MY_CONVERSATIONS_SHAPE_ROUTE } from "../../src/features/conversations/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "../Actor.vibe"
import * as RepoRoles from "../github/RepoRoles.vibe"
import { branchHarness, type BranchHarness, resetBranches, shared, tracked } from "../test/branch.ts"
import { recorded, testFile } from "../test/harness.ts"
import { BranchRoles } from "./Access.vibe"
import * as Api from "./ConversationApi.vibe"
import * as People from "./ConversationPeople.vibe"

const runtime = testFile("conversation_access")
beforeEach(() => resetBranches(runtime))

const REPO = "github/octocat/spoon-knife"
const BRANCH = "feature/access-check"

const maya: Actor = { subject: { kind: "person", id: "person-maya" }, role: "member", login: "maya" }
const ben: Actor = { subject: { kind: "person", id: "person-ben" }, role: "member", login: "ben" }
const gus: Actor = { subject: { kind: "person", id: "person-gus" }, role: "guest", login: "gus" }

/** A UUID no conversation has. */
const UNKNOWN = "00000000-0000-4000-8000-000000000000"

const open = (actor?: Actor, options: Parameters<typeof branchHarness>[1] = {}) =>
  branchHarness(runtime, { ...(actor === undefined ? {} : { actor }), ...options })

/** Maya's own branch, private until she shares it. */
const mine = () => tracked(runtime, REPO, BRANCH, "open", maya.subject.id)

/** The status, `cache-control` and body of the access check of `conversationId`. */
const check = async (h: BranchHarness, conversationId: string, init?: RequestInit) => {
  const response = await h.fetch(accessPath(conversationId), init)
  const text = await response.text()
  return [response.status, response.headers.get("cache-control"), text === "" ? null : JSON.parse(text)]
}

/** Every `conversation_people` row with its row version, which any write changes even to the same values. */
const people = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    SELECT xmin::text AS version, conversation_id, person_id, owner, repo, branch, opened_at, archived_at, changed_at
    FROM conversation_people ORDER BY conversation_id, person_id`))

describe("GET /api/conversations/<conversationId>/access", () => {
  test("answers each person by the branch's check, never cached, with one content-free span, log and count", async () => {
    const branch = await mine()
    const h = await open(maya)
    expect(await check(h, branch.conversationId)).toEqual([200, "no-store", { allowed: true }])
    // The id is read in lowercase, as the archive route reads it.
    expect(await check(h, branch.conversationId.toUpperCase())).toEqual([200, "no-store", { allowed: true }])
    expect(await check(h, UNKNOWN)).toEqual([404, "no-store", { code: "not_found" }])
    expect(await check(h, "not-a-uuid")).toEqual([404, "no-store", { code: "not_found" }])
    expect(await check(h, branch.conversationId, { method: "POST", body: "{}" })).toEqual([405, "no-store", null])
    const post = await h.fetch(accessPath(branch.conversationId), { method: "POST" })
    expect(post.headers.get("allow")).toBe("GET")

    const outsider = await open(ben)
    expect(await check(outsider, branch.conversationId)).toEqual([403, "no-store", { code: "forbidden" }])
    const signedOut = await open()
    expect(await check(signedOut, branch.conversationId)).toEqual([401, "no-store", { code: "sign_in" }])

    const fields = (line: ReturnType<BranchHarness["only"]>) => {
      const { conversationId, outcome, status, durationMs } = line.annotations
      return [line.level, conversationId, outcome, status, typeof durationMs]
    }
    expect(h.line("conversation.access").map(fields)).toEqual([
      ["INFO", branch.conversationId, "allowed", 200, "number"],
      ["INFO", branch.conversationId, "allowed", 200, "number"],
      ["WARN", UNKNOWN, "not_found", 404, "number"],
      // An id that is no UUID is not logged: it is whatever the request sent.
      ["WARN", undefined, "not_found", 404, "number"],
      ["WARN", undefined, "method", 405, "number"],
      ["WARN", undefined, "method", 405, "number"],
    ])
    expect(h.span("conversation.access")).toHaveLength(6)
    expect(h.span("conversation.access").map((span) => span.kind)).toEqual(Array(6).fill("server"))
    expect(h.count(Api.accessChecks, { outcome: "allowed" })).toBe(2)
    expect(h.count(Api.accessChecks, { outcome: "not_found" })).toBe(2)
    expect(h.count(Api.accessChecks, { outcome: "method" })).toBe(2)
    expect(outsider.only("conversation.access").annotations).toMatchObject({ outcome: "forbidden", status: 403 })
    expect(outsider.count(Api.accessChecks, { outcome: "forbidden" })).toBe(1)
    expect(signedOut.only("conversation.access").annotations).toMatchObject({ outcome: "sign_in", status: 401 })
    expect(signedOut.count(Api.accessChecks, { outcome: "sign_in" })).toBe(1)
    // Never a repository or a branch's name.
    for (const harness of [h, outsider, signedOut]) {
      const sent = recorded(harness).toLowerCase()
      expect(sent).not.toContain("spoon-knife")
      expect(sent).not.toContain("octocat")
      expect(sent).not.toContain("access-check")
    }
  })

  test("a guest shared by name may read until the share is removed; their list's row stays", async () => {
    const branch = await mine()
    await shared(runtime, branch.branchId, gus.subject.id, "view", "gus")
    await runtime.runPromise(People.opened(branch.conversationId, gus.subject.id, "octocat", "spoon-knife", BRANCH))
    const guest = await open(gus)
    expect(await check(guest, branch.conversationId)).toEqual([200, "no-store", { allowed: true }])

    const owner = await open(maya)
    const removed = await owner.fetch(sharesRoute(branch.branchId), {
      method: "POST",
      body: JSON.stringify({ grantee: gus.subject.id, access: null }),
    })
    expect(removed.status).toBe(200)
    expect(await check(guest, branch.conversationId)).toEqual([403, "no-store", { code: "forbidden" }])
    expect(await people()).toMatchObject([{ conversation_id: branch.conversationId, person_id: gus.subject.id }])
    expect(guest.line("conversation.access").map((line) => line.annotations.outcome)).toEqual(["allowed", "forbidden"])
  })

  test("reads only: the list's rows are the same, row versions included, after allowed and refused checks", async () => {
    const branch = await mine()
    await runtime.runPromise(People.opened(branch.conversationId, maya.subject.id, "octocat", "spoon-knife", BRANCH))
    await runtime.runPromise(People.archive(branch.conversationId, ben.subject.id, true, Date.now()))
    const before = await people()
    expect(before).toHaveLength(2)
    const [owner, outsider, stranger] = [await open(maya), await open(ben), await open(gus)]
    expect((await check(owner, branch.conversationId))[0]).toBe(200)
    expect((await check(outsider, branch.conversationId))[0]).toBe(403)
    expect((await check(stranger, branch.conversationId))[0]).toBe(403)
    // Nobody's first check of a conversation adds them to its list.
    const other = await tracked(runtime, REPO, "feature/team", "open")
    expect((await check(owner, other.conversationId))[0]).toBe(200)
    expect(await people()).toEqual(before)
  })

  test("sessions, the role on the repository or Postgres that can't be read are 503 unavailable", async () => {
    const branch = await mine()
    const sessions = await open(undefined, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })
    const refused = Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable" }))
    const roles = await open(maya, {
      branchRoles: Layer.succeed(BranchRoles, BranchRoles.of({ roleOn: () => refused, workUninstalled: () => refused })),
    })
    const down = await open(maya, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    for (const h of [sessions, roles, down]) {
      expect(await check(h, branch.conversationId)).toEqual([503, "no-store", { code: "unavailable" }])
      expect(h.span("conversation.access")).toHaveLength(1)
      expect(h.count(Api.accessChecks, { outcome: "unavailable" })).toBe(1)
      expect(h.only("conversation.access").level).toBe("ERROR")
    }
    expect(sessions.only("conversation.access").annotations).toMatchObject({
      errorCode: "@smthrs/mvp/auth/SessionsUnavailable",
      outcome: "unavailable",
      status: 503,
      durationMs: expect.any(Number),
    })
    expect(sessions.only("conversation.access").annotations).not.toHaveProperty("conversationId")
    expect(roles.only("conversation.access").annotations).toMatchObject({
      conversationId: branch.conversationId,
      errorCode: "@smthrs/mvp/github/RoleRefused",
    })
    expect(down.only("conversation.access").annotations.errorCode).toMatch(/^sql:/)
  })
})

test("handles names each access route, the archive route and the shape, and nothing else", () => {
  const id = crypto.randomUUID()
  expect(Api.handles(accessPath(id))).toBe(true)
  expect(Api.handles(ARCHIVE_ROUTE)).toBe(true)
  expect(Api.handles(MY_CONVERSATIONS_SHAPE_ROUTE)).toBe(true)
  for (const path of ["/api/conversations", "/api/conversations/x/y/access", "/api/conversations//access"]) {
    expect(Api.handles(path), path).toBe(false)
  }
})
