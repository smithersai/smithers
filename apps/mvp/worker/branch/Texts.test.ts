// Co-editing's routes (worker/branch/Texts.ts, decision 0013 §4, docs/features/coedit.md) through the branch
// workspace's real routes (worker/test/branch.ts), on this file's schema of the compose Postgres and through the compose
// Electric (`pnpm db:up`). Updates are real Yjs updates from `@smthrs/sync`'s `SharedText`; the texts' rooms are a test
// `Rooms` that records who joined and what each change of sharing held them to.
import { SharedText } from "@smthrs/sync"
import { Effect, Layer, Option, Redacted, Result } from "effect"
import { Base64 } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { sharesRoute } from "../../src/features/branch/contract.ts"
import {
  HOME,
  MAX_TEXT_BODY_BYTES,
  type TextScope,
  textRoomRoute,
  textRoute,
  TEXTS_SHAPE_ROUTE,
} from "../../src/features/coedit/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "../Actor.ts"
import { branchHarness, type BranchHarness, resetBranches, shared, tracked } from "../test/branch.ts"
import { eventually, recorded, testFile } from "../test/harness.ts"
import * as Texts from "./Texts.ts"
import { BranchRoles } from "./Access.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import { repositoryOf } from "../github/Config.ts"
import { app } from "../github/test/harness.ts"
import { accountIdOf, appKey, INSTALLATION_ID, scriptedGitHub } from "../github/test/scriptedGitHub.ts"

const runtime = testFile("texts")
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
const gus: Actor = { subject: { kind: "person", id: "person-gus" }, role: "guest", login: "gus" }

/** Words no record may carry. */
const SENTINEL = "Sentinel-Draft-9c41"

const open = (actor: Actor | null = maya, options: Parameters<typeof branchHarness>[1] = {}) =>
  branchHarness(runtime, { ...(actor === null ? {} : { actor }), known: [{ id: "person-ben", login: "ben" }], ...options })

const json = async (response: Response) => [response.status, await response.json()]

/** An update that types `text` into a fresh replica. */
const typed = (text: string) =>
  Effect.runSync(Effect.scoped(Effect.flatMap(SharedText.make, (replica) => replica.replace(text))))!

const write = (
  h: BranchHarness,
  textId: string,
  scope: TextScope,
  update: Uint8Array | string,
  extra: { readonly id?: string; readonly seed?: boolean } = {},
) =>
  h.fetch(textRoute(textId), {
    method: "POST",
    body: JSON.stringify({
      scope,
      id: extra.id ?? crypto.randomUUID(),
      update: typeof update === "string" ? update : Base64.encode(update),
      ...(extra.seed === undefined ? {} : { seed: extra.seed }),
    }),
  })

/** Every update stored under `scope` for `textId`, oldest first. */
const stored = (scope: string, textId: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly data: string; readonly seed: boolean; readonly personId: string }>`
      SELECT id, data, seed, person_id AS "personId" FROM text_updates
      WHERE scope = ${scope} AND text_id = ${textId} ORDER BY created_at, id`))

/** A run of `launchedBy`, as `POST /api/runs/<id>` records one. */
const run = (launchedBy: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const id = crypto.randomUUID()
    return Effect.as(sql`INSERT INTO runs (id, flow, status, launched_by) VALUES (${id}, 'chat/Answer', 'working', ${launchedBy})`, id)
  }))

/** The text a replica that applied every stored update has. */
const textOf = (rows: ReadonlyArray<{ readonly data: string }>) =>
  Effect.runSync(Effect.scoped(Effect.gen(function* () {
    const replica = yield* SharedText.make
    for (const row of rows) yield* replica.apply(Result.getOrThrow(Base64.decode(row.data)))
    return yield* replica.text
  })))

describe("POST /api/texts/<id>", () => {
  test("someone who may edit adds an update once; a resend of it changes nothing; nothing records its words", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    const textId = crypto.randomUUID()
    const h = await open()
    const id = crypto.randomUUID()
    const update = typed(SENTINEL)
    const [status, body] = await json(await write(h, textId, { conversation: branch.conversationId }, update, { id }))
    expect(status).toBe(200)
    expect((body as { readonly txid: unknown }).txid).toEqual(expect.any(Number))
    expect(await json(await write(h, textId, { conversation: branch.conversationId }, update, { id }))).toEqual([
      200,
      { txid: null },
    ])
    const rows = await stored(`branch:${branch.branchId}`, textId)
    expect(rows.map((row) => [row.id, row.seed, row.personId])).toEqual([[id, false, "person-maya"]])
    expect(textOf(rows)).toBe(SENTINEL)
    expect(h.line("text.write").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ textId, scope: "conversation", bytes: update.byteLength, seed: false, outcome: "stored", status: 200 }),
      expect.objectContaining({ outcome: "existing", status: 200 }),
    ])
    expect(h.count(Texts.writes, { outcome: "stored" })).toBe(1)
    expect(h.count(Texts.writes, { outcome: "existing" })).toBe(1)
    expect(h.span("text.write")).toHaveLength(2)
    expect(recorded(h)).not.toContain(SENTINEL)
  })

  test("a viewer's update is refused before it is stored, and so is anyone's who may not see the text", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    await shared(runtime, branch.branchId, "person-gus", "edit")
    await shared(runtime, branch.branchId, "person-ben", "view")
    const textId = crypto.randomUUID()
    const scope = { conversation: branch.conversationId }
    expect(await json(await write(await open(ben), textId, scope, typed("ben")))).toEqual([403, { code: "view_only" }])
    // A Guest shared to edit may only view.
    expect(await json(await write(await open(gus), textId, scope, typed("gus")))).toEqual([403, { code: "view_only" }])
    const stranger: Actor = { subject: { kind: "person", id: "person-sue" }, role: "member", login: "sue" }
    const outside = await open(stranger)
    expect(await json(await write(outside, textId, scope, typed("sue")))).toEqual([403, { code: "forbidden" }])
    expect(await json(await write(await open(null), textId, scope, typed("x")))).toEqual([401, { code: "authentication" }])
    expect(await stored(`branch:${branch.branchId}`, textId)).toEqual([])
    expect(outside.only("text.write").annotations).toMatchObject({ scope: "conversation", outcome: "forbidden", status: 403 })
  })

  test("the home conversation's prompt is the team's: any Member edits it", async () => {
    const textId = crypto.randomUUID()
    const h = await open(ben)
    expect((await write(h, textId, { conversation: HOME }, typed("team"))).status).toBe(200)
    const home = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly scope: string }>`SELECT scope FROM text_updates WHERE text_id = ${textId}`))
    expect(home).toEqual([{ scope: expect.stringMatching(/^branch:[0-9a-f-]{36}$/) }])
  })

  test("a deployment without its home conversation has no home prompt: 404", async () => {
    const h = await open(maya, { config: { GITHUB_REPOSITORY: "nobody/nothing" } })
    expect(await json(await write(h, crypto.randomUUID(), { conversation: HOME }, typed("x")))).toEqual([
      404,
      { code: "not_found" },
    ])
  })

  test("a run's answer box is its person's alone", async () => {
    const runId = await run("person-maya")
    const textId = crypto.randomUUID()
    const h = await open()
    expect((await write(h, textId, { run: runId.toUpperCase() }, typed("docs-v2"))).status).toBe(200)
    expect(textOf(await stored(`run:${runId}`, textId))).toBe("docs-v2")
    expect(await json(await write(await open(ben), textId, { run: runId }, typed("ben")))).toEqual([
      403,
      { code: "forbidden" },
    ])
    // Only a Member or above asks, so only they answer.
    expect(await json(await write(await open({ ...maya, role: "guest" }), textId, { run: runId }, typed("x"))))
      .toEqual([403, { code: "forbidden" }])
    expect(await json(await write(h, textId, { run: crypto.randomUUID() }, typed("x")))).toEqual([
      404,
      { code: "not_found" },
    ])
  })

  test("one seed per text: the first is kept and a second, even of other words, changes nothing", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    const textId = crypto.randomUUID()
    const scope = { conversation: branch.conversationId }
    const h = await open()
    const first = await json(await write(h, textId, scope, SharedText.seed("body {}\n"), { seed: true }))
    expect(first[0]).toBe(200)
    expect(await json(await write(h, textId, scope, SharedText.seed("other\n"), { seed: true }))).toEqual([
      200,
      { txid: null },
    ])
    const rows = await stored(`branch:${branch.branchId}`, textId)
    expect(rows.map((row) => row.seed)).toEqual([true])
    expect(textOf(rows)).toBe("body {}\n")
  })

  test("refuses what isn't an update: 400 for a bad body, bytes, base64 or a forged seed; 413 over the limit", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    const textId = crypto.randomUUID()
    const scope = { conversation: branch.conversationId }
    const h = await open()
    const invalid = [400, { code: "invalid" }]
    expect(await json(await h.fetch(textRoute(textId), { method: "POST", body: "{" }))).toEqual(invalid)
    expect(await json(await write(h, textId, { conversation: "not-a-conversation" }, typed("x")))).toEqual(invalid)
    expect(await json(await write(h, textId, scope, "%%%not-base64"))).toEqual(invalid)
    expect(await json(await write(h, textId, scope, new Uint8Array([7, 255, 1, 3])))).toEqual(invalid)
    // The seed's replica writes only a seed, and a seed only it.
    expect(await json(await write(h, textId, scope, SharedText.seed("forged")))).toEqual(invalid)
    expect(await json(await write(h, textId, scope, typed("not a seed"), { seed: true }))).toEqual(invalid)
    const huge = await h.fetch(textRoute(textId), { method: "POST", body: "x".repeat(MAX_TEXT_BODY_BYTES + 1) })
    expect(huge.status).toBe(413)
    // A body that isn't UTF-8.
    expect(await json(await h.fetch(textRoute(textId), { method: "POST", body: new Uint8Array([0xff, 0xfe, 0xfd]) })))
      .toEqual(invalid)
    expect(await json(await write(h, "not-a-text", scope, typed("x")))).toEqual([404, { code: "not_found" }])
    expect(await json(await write(h, textId, { conversation: crypto.randomUUID() }, typed("x")))).toEqual([
      404,
      { code: "not_found" },
    ])
    const get = await h.fetch(textRoute(textId))
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])
    expect(await stored(`branch:${branch.branchId}`, textId)).toEqual([])
  })

  test("sessions or Postgres that fail are 503 unavailable, logged by the failure's code", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    const unreadable = Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) }))
    const sessions = await open(null, { sessions: unreadable })
    const scope = { conversation: branch.conversationId }
    expect(await json(await write(sessions, crypto.randomUUID(), scope, typed("x")))).toEqual([503, { code: "unavailable" }])
    expect(sessions.only("text.write")).toMatchObject({
      level: "ERROR",
      annotations: { errorCode: "@smthrs/mvp/auth/SessionsUnavailable", outcome: "unavailable" },
    })
    const down = await open(maya, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect(await json(await write(down, crypto.randomUUID(), scope, typed("x")))).toEqual([503, { code: "unavailable" }])
    expect(down.only("text.write").annotations.errorCode).toMatch(/^sql:/)
  })
})

describe("GET /api/shapes/texts", () => {
  /** Reads the shape from its start until `count` rows are in: Electric may still be replicating them. */
  const values = async (h: BranchHarness, query: string, count: number) => {
    const rows: Array<Record<string, unknown>> = []
    let at = "offset=-1"
    await eventually(async () => {
      const response = await h.fetch(`${TEXTS_SHAPE_ROUTE}?${query}&${at}`)
      expect(response.status).toBe(200)
      for (const message of (await response.json()) as Array<{ readonly value?: Record<string, unknown> }>) {
        if (message.value !== undefined) rows.push(message.value)
      }
      at = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
      return rows.length >= count
    }, 10_000)
    return rows
  }

  test("someone who may view the branch syncs a text's updates, ids and bytes only", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    await shared(runtime, branch.branchId, "person-ben", "view")
    const [textId, other] = [crypto.randomUUID(), crypto.randomUUID()]
    const scope = { conversation: branch.conversationId }
    const owner = await open()
    await write(owner, textId, scope, typed("one"))
    await write(owner, other, scope, typed("two"))
    const h = await open(ben)

    const rows = await values(h, `text=${textId.toUpperCase()}&conversation=${branch.conversationId}`, 1)

    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!).sort()).toEqual(["data", "id"])
    expect(textOf(rows as Array<{ readonly data: string }>)).toBe("one")
    expect(Object.fromEntries(h.electric[0]!.searchParams)).toEqual({
      offset: "-1",
      table: "text_updates",
      columns: "id,data",
      where: "scope = $1 AND text_id = $2",
      "params[1]": `branch:${branch.branchId}`,
      "params[2]": textId,
    })
    await eventually(() => h.line("text.shape").length >= 1)
  })

  test("anyone who may not see the text, or names none, gets a shape with no rows", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    const runId = await run("person-maya")
    const textId = crypto.randomUUID()
    await write(await open(), textId, { conversation: branch.conversationId }, typed("private"))
    const cases: ReadonlyArray<[BranchHarness, string]> = [
      [await open(null), `text=${textId}&conversation=${branch.conversationId}`],
      [await open(ben), `text=${textId}&conversation=${branch.conversationId}`],
      [await open(ben), `text=${textId}&run=${runId}`],
      [await open(null), `text=${textId}&run=${runId}`],
      [await open(), `text=${textId}&conversation=${crypto.randomUUID()}`],
      [await open(), `text=not-a-text&conversation=${branch.conversationId}`],
      [await open(), `text=${textId}`],
      [await open(), `text=${textId}&run=not-a-run`],
    ]
    for (const [h, query] of cases) {
      const response = await h.fetch(`${TEXTS_SHAPE_ROUTE}?offset=-1&${query}`)
      expect([query, response.status]).toEqual([query, 200])
      const rows = (await response.json()) as Array<{ readonly value?: unknown }>
      expect(rows.filter((row) => row.value !== undefined)).toEqual([])
      expect(h.electric[0]!.searchParams.get("params[1]")).toBe("none")
    }
  })

  test("while sessions or Postgres can't be read, the request is refused 503 and Electric is never asked", async () => {
    const unreadable = Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) }))
    const query = `${TEXTS_SHAPE_ROUTE}?offset=-1&text=${crypto.randomUUID()}&conversation=${HOME}`
    const h = await open(null, { sessions: unreadable })
    const response = await h.fetch(query)
    expect([response.status, response.headers.get("retry-after")]).toEqual([503, "5"])
    expect(h.electric).toEqual([])
    const down = await open(maya, {
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect((await down.fetch(query)).status).toBe(503)
    expect(down.electric).toEqual([])
  })
})

describe("GET /api/texts/<id>/room", () => {
  const join = (h: BranchHarness, textId: string, query: string, headers: Record<string, string> = {}) =>
    h.fetch(`${textRoomRoute(textId)}?${query}`, {
      headers: { upgrade: "websocket", connection: "Upgrade", origin: "http://chat.test", ...headers },
    })

  test("joins the text's own room as the session says, with what they may do", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    await shared(runtime, branch.branchId, "person-ben", "view")
    const textId = crypto.randomUUID()
    const h = await open(ben)
    expect(await json(await join(h, textId.toUpperCase(), `conversation=${branch.conversationId}`))).toEqual([
      200,
      { joined: { principal: "person-ben", name: "ben", role: "member", access: "view" } },
    ])
    expect(h.rooms.joined).toEqual([{
      branchId: `text:branch:${branch.branchId}:${textId}`,
      member: { principal: "person-ben", name: "ben", role: "member", access: "view" },
    }])
    expect(h.only("text.room").annotations).toMatchObject({ textId, scope: "conversation", access: "view", outcome: "joined" })
    expect(h.count(Texts.joins, { outcome: "joined" })).toBe(1)
    const runId = await run("person-maya")
    const owner = await open()
    expect((await join(owner, textId, `run=${runId}`)).status).toBe(200)
    expect(owner.rooms.joined[0]!.branchId).toBe(`text:run:${runId}:${textId}`)
    // Someone with no login is named by their id.
    await shared(runtime, branch.branchId, "person-nolog", "view")
    const nameless = await open({ subject: { kind: "person", id: "person-nolog" }, role: "member" })
    expect(await json(await join(nameless, textId, `conversation=${branch.conversationId}`))).toEqual([
      200,
      { joined: { principal: "person-nolog", name: "person-nolog", role: "member", access: "view" } },
    ])
  })

  test("refuses who may not see the text, and anything but this app's page asking for a socket", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    const runId = await run("person-maya")
    const textId = crypto.randomUUID()
    const scope = `conversation=${branch.conversationId}`
    const h = await open(ben)
    expect(await json(await join(h, textId, scope))).toEqual([403, { code: "forbidden" }])
    expect(await json(await join(h, textId, `run=${runId}`))).toEqual([403, { code: "forbidden" }])
    expect(await json(await join(await open(null), textId, scope))).toEqual([401, { code: "authentication" }])
    expect(await json(await join(h, textId, "nothing=1"))).toEqual([404, { code: "not_found" }])
    expect(await json(await join(h, textId, `run=${crypto.randomUUID()}`))).toEqual([404, { code: "not_found" }])
    expect(await json(await join(h, textId, scope, { origin: "http://evil.test" }))).toEqual([403, { code: "origin" }])
    const plain = await h.fetch(`${textRoomRoute(textId)}?${scope}`, { headers: { origin: "http://chat.test" } })
    expect(await json(plain)).toEqual([426, { code: "upgrade" }])
    const post = await h.fetch(`${textRoomRoute(textId)}?${scope}`, { method: "POST" })
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"])
    expect(h.rooms.joined).toEqual([])
    const unreadable = Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) }))
    const down = await open(null, { sessions: unreadable })
    expect(await json(await join(down, textId, scope))).toEqual([503, { code: "unavailable" }])
    expect(down.only("text.room").annotations).toMatchObject({ errorCode: "@smthrs/mvp/auth/SessionsUnavailable" })
  })

  test("a change of sharing holds the rooms of the branch's texts to it, as it does the branch's own room", async () => {
    const branch = await tracked(runtime, REPO, "feature/texts", "open", "person-maya")
    await shared(runtime, branch.branchId, "person-ben", "edit", "ben")
    const [prompt, file] = [crypto.randomUUID(), crypto.randomUUID()]
    const scope = { conversation: branch.conversationId }
    const h = await open()
    await write(h, prompt, scope, typed("a"))
    await write(h, prompt, scope, typed("b"))
    await write(h, file, scope, SharedText.seed("c"), { seed: true })
    const removed = await h.fetch(sharesRoute(branch.branchId), {
      method: "POST",
      body: JSON.stringify({ grantee: "person-ben", access: null }),
    })
    expect(removed.status).toBe(200)
    const rooms = h.rooms.enforced.map((enforced) => enforced.branchId).sort()
    expect(rooms).toEqual(
      [branch.branchId, `text:branch:${branch.branchId}:${prompt}`, `text:branch:${branch.branchId}:${file}`].sort(),
    )
    for (const enforced of h.rooms.enforced) expect(enforced.policy.grants).not.toHaveProperty("person-ben")
  })
})

describe("Texts", () => {
  test("handles co-editing's routes and nothing else", () => {
    for (const path of [TEXTS_SHAPE_ROUTE, textRoute("x"), textRoomRoute("x")]) expect([path, Texts.handles(path)]).toEqual([path, true])
    for (const path of ["/api/texts", "/api/textsx/1", "/api/shapes/textsx"]) expect([path, Texts.handles(path)]).toEqual([path, false])
  })

  test("a text's other paths are 404", async () => {
    const h = await open()
    expect((await h.fetch("/api/texts/x/other")).status).toBe(404)
  })
})


test("AUTH-8: the launcher's repository role controls answer-draft writes, sync and rooms, including demotion", async () => {
  const personId = crypto.randomUUID()
  const actor: Actor = { subject: { kind: "person", id: personId }, role: null, login: "maya" }
  const repository = "github/acme/widgets"
  const github = scriptedGitHub("acme", "widgets")
  github.roles.set("maya", "write")
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.all([
    sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}::uuid, ${accountIdOf("maya")}, 'maya')`,
    sql`INSERT INTO github_repositories (repo_id, installation_id) VALUES (${repository}, ${INSTALLATION_ID})`,
  ])))
  const branch = await tracked(runtime, repository, "answer-draft", "open", personId)
  const runId = await run(personId)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`
    UPDATE runs SET conversation_id = ${branch.conversationId}::uuid, branch_id = ${branch.branchId}::uuid, repo_id = ${repository}
    WHERE id = ${runId}::uuid`))
  const scratch = await runtime.runPromise(TestDatabase.Scratch)
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("smithersai/smithers"),
    app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  const branchRoles = BranchRoles.layer(roles)
  const h = await open(actor, { branchRoles })
  const textId = crypto.randomUUID()
  const update = typed("answer draft")
  const updateId = crypto.randomUUID()
  expect((await write(h, textId, { run: runId }, update, { id: updateId })).status).toBe(200)
  const shape = await h.fetch(`${TEXTS_SHAPE_ROUTE}?offset=-1&text=${textId}&run=${runId}`)
  expect(shape.status).toBe(200)
  expect(h.electric.at(-1)!.searchParams.get("params[1]")).toBe(`run:${runId}`)
  const join = () => h.fetch(`${textRoomRoute(textId)}?run=${runId}`, {
    headers: { upgrade: "websocket", connection: "Upgrade", origin: "http://chat.test" },
  })
  expect((await join()).status).toBe(200)
  expect(h.rooms.joined.at(-1)!.member).toMatchObject({ principal: personId, role: "member", access: "owner" })
  const other = await open({ ...actor, subject: { kind: "person", id: crypto.randomUUID() } }, { branchRoles })
  expect((await write(other, textId, { run: runId }, typed("not the launcher"))).status).toBe(403)
  // Runs that carry only a repository or branch still use that repository, never the deployment's role.
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE runs SET conversation_id = NULL, branch_id = NULL WHERE id = ${runId}::uuid`))
  expect((await write(h, textId, { run: runId }, update, { id: updateId })).status).toBe(200)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE runs SET branch_id = ${branch.branchId}::uuid WHERE id = ${runId}::uuid`))
  expect((await write(h, textId, { run: runId }, update, { id: updateId })).status).toBe(200)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE runs SET branch_id = NULL WHERE id = ${runId}::uuid`))
  // Even a deployment Admin cannot retain the draft after a repository demotion.
  github.roles.set("maya", "read")
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`TRUNCATE github_repo_roles`))
  const demoted = await open({ ...actor, role: "admin" }, { branchRoles })
  expect((await write(demoted, textId, { run: runId }, typed("denied"))).status).toBe(403)
  const hidden = await demoted.fetch(`${TEXTS_SHAPE_ROUTE}?offset=-1&text=${textId}&run=${runId}`)
  expect(hidden.status).toBe(200)
  expect(demoted.electric.at(-1)!.searchParams.get("params[1]")).toBe("none")
  expect((await demoted.fetch(`${textRoomRoute(textId)}?run=${runId}`, {
    headers: { upgrade: "websocket", connection: "Upgrade", origin: "http://chat.test" },
  })).status).toBe(403)
  expect(textOf(await stored(`run:${runId}`, textId))).toBe("answer draft")
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE runs SET conversation_id = ${branch.conversationId}::uuid, branch_id = ${branch.branchId}::uuid WHERE id = ${runId}::uuid`))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE branches SET deleted_at = now() WHERE id = ${branch.branchId}::uuid`))
  expect((await write(demoted, textId, { run: runId }, typed("deleted branch"))).status).toBe(403)
})

test("a legacy run without a conversation is refused when its home repository is unavailable", async () => {
  const runId = await run("person-maya")
  const h = await open(maya, { config: { GITHUB_REPOSITORY: "nobody/nothing" } })
  expect((await write(h, crypto.randomUUID(), { run: runId }, typed("no home"))).status).toBe(403)
})
