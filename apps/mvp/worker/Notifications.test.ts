// The personal feed on the server (worker/Notifications.ts, docs/features/notifications.md#the-server), through ChatApi's
// real handler on this file's schema of the compose Postgres and Electric (`pnpm db:up`): a run's reports route to its
// launcher and to the people on its branch, GitHub's `main` and release deliveries route to the repository's watchers,
// acts merge with greatest(), and the shape syncs only the person's own rows.
import { Effect, Option, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { ACK_ROUTE, MAX_ATTENTION_BODY_BYTES, NOTIFICATIONS_SHAPE_ROUTE, WATCHES_ROUTE } from "../src/features/attention/contract.ts"
import { GITHUB_WEBHOOK_ROUTE } from "../src/features/issues/contract.ts"
import type { Report } from "../src/features/status/schema.ts"
import type { Actor } from "./Actor.ts"
import { REPOSITORY } from "./github/test/fixtures.ts"
import { delivery, githubHarness } from "./github/test/harness.ts"
import * as Notifications from "./Notifications.ts"
import { eventually, harness, recorded, testFile } from "./test/harness.ts"

const runtime = testFile("notifications")

const ann: Actor = { subject: { kind: "person", id: "person-ann" }, role: "member", login: "ann" }
const ben: Actor = { subject: { kind: "person", id: "person-ben" }, role: "maintainer", login: "ben" }
const cat: Actor = { subject: { kind: "person", id: "person-cat" }, role: "member", login: "cat" }
const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }

/** What a question says: a sentinel no record may carry. */
const QUESTION = "Deploy the docs preview sentinel-7c1d\nwith every page"

const sql = <A extends object>(query: string, ...params: ReadonlyArray<unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(query, params as Array<never>)))

beforeEach(() => sql(`TRUNCATE watches, notifications, runs`))

const open = (actor: Actor | null, options: { readonly fetch?: typeof globalThis.fetch } = {}) =>
  harness(runtime, () => Stream.empty, { ...(actor === null ? {} : { actor }), ...options })

type Harness = Awaited<ReturnType<typeof open>>

const post = (h: Harness, path: string, body: unknown, init: RequestInit = {}) =>
  h.fetch(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init })

const json = async (response: Response) => [response.status, await response.json()]

/** Asks `QUESTION` as `h`'s actor, in `conversationId` (the home conversation unless set): the run's id. */
const asked = async (h: Harness, conversationId?: string) => {
  const question = {
    id: crypto.randomUUID(),
    answerId: crypto.randomUUID(),
    text: QUESTION,
    ...(conversationId === undefined ? {} : { conversationId }),
  }
  expect((await h.ask(question)).status).toBe(202)
  return question.answerId
}

const report = (h: Harness, runId: string, body: Report) => post(h, `/api/runs/${runId}`, body)

const wait = (execution = "run/call/0.0") => ({
  execution,
  kind: "question" as const,
  prompt: "Which branch should I deploy?\nmain or docs-v2",
  options: ["main", "docs-v2"],
})

/** A tracked branch of `repoId` with its conversation, as `branch/track` records one. */
const branch = async (repoId = REPOSITORY.id, name = `feature-${crypto.randomUUID().slice(0, 8)}`) => {
  const branchId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  await sql(`INSERT INTO branches (id, repo_id, name, mode) VALUES ($1, $2, $3, 'open')`, branchId, repoId, name)
  await sql(`INSERT INTO conversations (id, repo_id, branch_id) VALUES ($1, $2, $3)`, conversationId, repoId, branchId)
  // The team's branch: anyone in the repository with the link may edit it (worker/branch/Access.ts).
  await sql(`INSERT INTO branch_shares (branch_id, grantee, access) VALUES ($1, 'repository', 'edit')`, branchId)
  return { branchId, conversationId, name }
}

interface Row {
  readonly recipient: string
  readonly subject: string
  readonly kind: string
  readonly state: string
  readonly mine: boolean
  readonly quiet: boolean
  readonly actor: string | null
  readonly title: string | null
  readonly ref: string | null
  readonly href: string
  readonly version: number
  readonly readVersion: number
  readonly dismissedVersion: number
  readonly hiddenVersion: number
}

const rows = (subject: string) =>
  sql<Row>(
    `SELECT recipient, subject, kind, state, mine, quiet, actor, title, ref, href, version, read_version AS "readVersion",
      dismissed_version AS "dismissedVersion", hidden_version AS "hiddenVersion"
    FROM notifications WHERE subject = $1 ORDER BY recipient`,
    subject,
  )

const rowOf = async (subject: string, recipient: string) =>
  (await rows(subject)).find((row) => row.recipient === recipient)

const watches = (principal: string) =>
  sql<{ readonly subject: string; readonly level: string }>(
    `SELECT subject, level FROM watches WHERE principal_id = $1 ORDER BY subject`,
    principal,
  )

describe("a run's reports route to its launcher and the people on its branch", () => {
  test("revoked recipients receive no further run updates, including the launcher", async () => {
    const a = await open(ann)
    const { branchId, conversationId } = await branch()
    await sql(`INSERT INTO watches (principal_id, subject, level) VALUES ('person-ben', $1, 'attention')`, `branch:${branchId}`)
    const runId = await asked(a, conversationId)
    await report(a, runId, { status: "working" })
    const subject = Notifications.runSubject(runId)
    const before = await rows(subject)
    expect(before).toHaveLength(2)
    await sql(`DELETE FROM branch_shares WHERE branch_id = $1`, branchId)
    await sql(`UPDATE runs SET status = 'needs_you', waiting = 'input', wait = $2::jsonb WHERE id = $1`, runId, JSON.stringify(wait()))
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.withTransaction(Notifications.foldRun(runId, "ann"))))
    expect(await rows(subject)).toEqual(before)
  })

  test("missing run metadata never bypasses a recipient's revoked branch access", async () => {
    const a = await open(ann)
    const { branchId, conversationId } = await branch()
    await sql(`INSERT INTO watches (principal_id, subject, level) VALUES ('person-ben', $1, 'attention')`, `branch:${branchId}`)
    const runId = await asked(a, conversationId)
    await report(a, runId, { status: "working" })
    const subject = Notifications.runSubject(runId)
    const before = await rows(subject)
    await sql(`DELETE FROM runs WHERE id = $1`, runId)
    await sql(`DELETE FROM branch_shares WHERE branch_id = $1`, branchId)
    await sql(`UPDATE messages SET status = 'done' WHERE id = $1`, runId)
    expect(await runtime.runPromise(Notifications.foldRun(runId, undefined))).toBe(0)
    expect(await rows(subject)).toEqual(before)
  })

  test("a quiet-only needs_you change preserves the attention version", async () => {
    const a = await open(ann)
    const runId = await asked(a)
    await report(a, runId, { status: "needs_you", wait: wait() })
    const subject = Notifications.runSubject(runId)
    const before = (await rowOf(subject, "person-ann"))!
    await sql(`UPDATE notifications SET quiet = true WHERE subject = $1 AND recipient = 'person-ann'`, subject)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.withTransaction(Notifications.foldRun(runId, "ann"))))
    expect(await rowOf(subject, "person-ann")).toMatchObject({ quiet: false, version: before.version })
  })

  test("the launcher hears every state; a watcher hears a quiet copy, waiting where the launcher is asked", async () => {
    const a = await open(ann)
    const b = await open(ben)
    // Ben shows the home conversation: he follows its branch and its repository.
    expect(await json(await post(b, WATCHES_ROUTE, { conversationId: null }))).toEqual([200, { txid: expect.any(Number) }])
    expect(await json(await post(b, WATCHES_ROUTE, { conversationId: null }))).toEqual([200, { txid: null }])
    expect((await watches("person-ben")).map((row) => row.level)).toEqual(["attention", "attention"])

    const runId = await asked(a)
    const subject = Notifications.runSubject(runId)
    expect((await report(a, runId, { status: "working" })).status).toBe(200)
    expect(await rows(subject)).toEqual([
      expect.objectContaining({ recipient: "person-ann", state: "working", mine: true, quiet: false, version: 1 }),
      expect.objectContaining({ recipient: "person-ben", state: "working", mine: false, quiet: true, version: 1 }),
    ])
    expect(await rowOf(subject, "person-ben")).toMatchObject({
      kind: "run",
      actor: "ann",
      title: "Deploy the docs preview sentinel-7c1d",
      href: "/app",
    })

    // A question: the launcher's row needs her, with the question as its title; Ben's waits, unraised.
    await report(a, runId, { status: "needs_you", wait: wait() })
    expect(await rowOf(subject, "person-ann")).toMatchObject({
      state: "needs_you",
      version: 2,
      title: "Which branch should I deploy?",
    })
    expect(await rowOf(subject, "person-ben")).toMatchObject({ state: "waiting", version: 1 })

    // Answered: it reads working again for both, in the answer's own transaction.
    expect((await post(a, `/api/runs/${runId}/answer`, { version: 1, value: "docs-v2" })).status).toBe(200)
    expect(await rowOf(subject, "person-ann")).toMatchObject({ state: "working", version: 2 })
    expect(await rowOf(subject, "person-ben")).toMatchObject({ state: "working", version: 1 })
    // The run's own report of it changes nothing more.
    await report(a, runId, { status: "working" })
    expect(await rowOf(subject, "person-ann")).toMatchObject({ state: "working", version: 2 })

    // A second question while the first still needs her shows again.
    await report(a, runId, { status: "needs_you", wait: wait("run/call/1.0") })
    expect(await rowOf(subject, "person-ann")).toMatchObject({ state: "needs_you", version: 3 })
    await report(a, runId, { status: "needs_you", wait: { ...wait("run/call/2.0"), prompt: "Which region?" } })
    expect(await rowOf(subject, "person-ann")).toMatchObject({ state: "needs_you", version: 4, title: "Which region?" })

    // Done raises both rows once; a settled run never writes again.
    await report(a, runId, { status: "done" })
    expect(await rows(subject)).toEqual([
      expect.objectContaining({ recipient: "person-ann", state: "done", version: 5 }),
      expect.objectContaining({ recipient: "person-ben", state: "done", version: 2, quiet: true }),
    ])
    await report(a, runId, { status: "failed" })
    expect((await rows(subject)).map((row) => row.state)).toEqual(["done", "done"])

    expect(a.count(Notifications.routed, { kind: "run", state: "done" })).toBe(2)
    expect(a.span("runs.fold").length).toBeGreaterThan(0)
    // No record carries a question or a title.
    expect(recorded(a)).not.toContain("sentinel-7c1d")
    expect(recorded(a)).not.toContain("Which branch")
  })

  test("a watcher at `all` hears it as an entry; a muted one hears nothing, unless it already has a row", async () => {
    const a = await open(ann)
    const { branchId, conversationId, name } = await branch()
    await sql(
      `INSERT INTO watches (principal_id, subject, level) VALUES ($1, $3, 'all'), ($2, $3, 'muted')`,
      "person-ben",
      "person-cat",
      `branch:${branchId}`,
    )
    const runId = await asked(a, conversationId)
    const subject = Notifications.runSubject(runId)
    await report(a, runId, { status: "working" })
    expect(await rows(subject)).toEqual([
      expect.objectContaining({ recipient: "person-ann", mine: true, href: `/acme/widgets/tree/${name}` }),
      expect.objectContaining({ recipient: "person-ben", quiet: false, mine: false }),
    ])
    // Ben mutes the branch mid-run: his row still settles, so it never reads working forever.
    await sql(`UPDATE watches SET level = 'muted' WHERE principal_id = 'person-ben'`)
    await report(a, runId, { status: "needs_you", wait: wait() })
    expect(await rowOf(subject, "person-ben")).toMatchObject({ state: "waiting", quiet: false })
    await report(a, runId, { status: "failed" })
    expect(await rowOf(subject, "person-ben")).toMatchObject({ state: "failed", version: 2 })
    expect(await rowOf(subject, "person-cat")).toBeUndefined()
  })

  test("the answer's own settle is its run's: an answer settled before its run reports so reads settled", async () => {
    const a = await open(ann)
    const b = await open(ben)
    await post(b, WATCHES_ROUTE, { conversationId: null })
    for (const settle of [{ status: "done", text: "Deployed." }, { status: "failed", failure: "unfinished" }] as const) {
      const runId = await asked(a)
      const subject = Notifications.runSubject(runId)
      await report(a, runId, { status: "working" })
      expect((await post(a, `/api/answers/${runId}`, settle)).status).toBe(200)
      expect(await rows(subject)).toEqual([
        expect.objectContaining({ recipient: "person-ann", state: settle.status, version: 2 }),
        expect.objectContaining({ recipient: "person-ben", state: settle.status, quiet: true }),
      ])
      // The run's own late report of it changes nothing.
      await report(a, runId, { status: settle.status })
      expect((await rowOf(subject, "person-ann"))!.version).toBe(2)
    }
  })

  test.each([{ status: "done", text: "Finished." }, { status: "failed", failure: "unfinished" }] as const)(
    "a settled answer repairs its Working notice when the run row is gone ($status)", async (ending) => {
      const a = await open(ann)
      const runId = await asked(a)
      await report(a, runId, { status: "working" })
      await sql(`DELETE FROM runs WHERE id = $1`, runId)
      // Missing run metadata alone is not a terminal outcome while the answer still streams.
      expect(await runtime.runPromise(Notifications.foldRun(runId, undefined))).toBe(0)
      expect(await rowOf(Notifications.runSubject(runId), "person-ann")).toMatchObject({ state: "working" })
      expect((await post(a, `/api/answers/${runId}`, ending)).status).toBe(200)
      expect(await rowOf(Notifications.runSubject(runId), "person-ann"))
        .toMatchObject({ state: ending.status, version: 2, title: "Deploy the docs preview sentinel-7c1d" })
      expect(a.count(Notifications.routed, { kind: "run", state: ending.status })).toBe(1)
      expect(recorded(a)).not.toContain("sentinel-7c1d")
      expect(a.only("notifications.run_missing").annotations).toMatchObject({ runId, written: 1 })
      expect(await runtime.runPromise(Notifications.foldRun(runId, undefined))).toBe(0)
    },
  )

  test("a missing legacy unscoped run settles only its launcher", async () => {
    const runId = crypto.randomUUID()
    await sql(`INSERT INTO runs (id, flow, status, launched_by) VALUES ($1, 'chat/Answer', 'working', 'person-ann')`, runId)
    await runtime.runPromise(Notifications.foldRun(runId, undefined))
    const subject = Notifications.runSubject(runId)
    await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, quiet, run_id, href)
      VALUES ('person-ben', $1, 'run', 'working', false, true, $2, '/app')`, subject, runId)
    await sql(`DELETE FROM runs WHERE id = $1`, runId)
    expect(await runtime.runPromise(Notifications.foldRun(runId, undefined))).toBe(1)
    expect(await rows(subject)).toEqual([
      expect.objectContaining({ recipient: "person-ann", state: "failed", version: 2 }),
      expect.objectContaining({ recipient: "person-ben", state: "working", version: 1 }),
    ])
  })

  test("a missing run with an unverifiable conversation scope fails closed", async () => {
    const a = await open(ann)
    const runId = await asked(a)
    await report(a, runId, { status: "working" })
    const subject = Notifications.runSubject(runId)
    await sql(`DELETE FROM runs WHERE id = $1`, runId)
    await sql(`UPDATE notifications SET conversation_id = $2 WHERE subject = $1`, subject, crypto.randomUUID())
    await sql(`UPDATE messages SET status = 'done' WHERE id = $1`, runId)
    const before = await rows(subject)
    expect(await runtime.runPromise(Notifications.foldRun(runId, undefined))).toBe(0)
    expect(await rows(subject)).toEqual(before)
  })

  test("a run with no scope, from before scopes, reaches its launcher alone and opens home", async () => {
    const runId = crypto.randomUUID()
    await sql(`INSERT INTO runs (id, flow, status, launched_by) VALUES ($1, 'chat/Answer', 'working', 'person-ann')`, runId)
    const folded = (id: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
        client.withTransaction(Notifications.foldRun(id, undefined))))
    expect(await folded(runId)).toBe(1)
    expect(await rows(Notifications.runSubject(runId))).toEqual([
      expect.objectContaining({ recipient: "person-ann", href: "/app", actor: null, title: null }),
    ])
    // The same again writes nothing; a run that isn't there writes nothing.
    expect(await folded(runId)).toBe(0)
    expect(await folded(crypto.randomUUID())).toBe(0)
  })
})

describe("POST /api/watches", () => {
  test("follows a conversation's branch and repository, keeping a level already chosen", async () => {
    const b = await open(ben)
    const { branchId, conversationId } = await branch()
    await sql(`INSERT INTO watches (principal_id, subject, level) VALUES ('person-ben', $1, 'all')`, `branch:${branchId}`)
    expect((await post(b, WATCHES_ROUTE, { conversationId: conversationId.toUpperCase() })).status).toBe(200)
    expect(await watches("person-ben")).toEqual([
      { subject: `branch:${branchId}`, level: "all" },
      { subject: `repo:${REPOSITORY.id}`, level: "attention" },
    ])
    expect(b.line("notifications.watch").at(-1)!.annotations).toMatchObject({ conversationId, status: 200 })
    expect(b.count(Notifications.requests, { route: "watch", status: "200" })).toBe(1)
  })

  test("refuses who may not have a feed, a bad body and a conversation that isn't there", async () => {
    const signedOut = await open(null)
    expect(await json(await post(signedOut, WATCHES_ROUTE, { conversationId: null }))).toEqual([401, { code: "authentication" }])
    const g = await open(guest)
    expect(await json(await post(g, WATCHES_ROUTE, { conversationId: null }))).toEqual([403, { code: "forbidden" }])
    const b = await open(ben)
    expect((await b.fetch(WATCHES_ROUTE)).status).toBe(405)
    expect(await json(await post(b, WATCHES_ROUTE, { conversationId: "nope" }))).toEqual([400, { code: "invalid" }])
    expect(await json(await post(b, WATCHES_ROUTE, "{"))).toEqual([400, { code: "invalid" }])
    expect(await json(await post(b, WATCHES_ROUTE, "x".repeat(MAX_ATTENTION_BODY_BYTES + 1)))).toEqual([
      413,
      { code: "too_large" },
    ])
    expect(await json(await b.fetch(WATCHES_ROUTE, { method: "POST", body: new Uint8Array([0xff, 0xfe]) }))).toEqual([
      400,
      { code: "invalid" },
    ])
    expect(await json(await post(b, WATCHES_ROUTE, { conversationId: crypto.randomUUID() }))).toEqual([
      404,
      { code: "not_found" },
    ])
    // A branch its creator hasn't shared: Ben may not open it, so he may not follow it.
    const { conversationId: privateOne, branchId } = await branch()
    await sql(`DELETE FROM branch_shares WHERE branch_id = $1`, branchId)
    await sql(`UPDATE branches SET created_by = 'person-ann' WHERE id = $1`, branchId)
    expect(await json(await post(b, WATCHES_ROUTE, { conversationId: privateOne }))).toEqual([403, { code: "forbidden" }])
    expect(await watches("person-ben")).toEqual([])
    // With no home conversation, the home one isn't found either.
    const homeless = await harness(runtime, () => Stream.empty, {
      actor: ben,
      config: { GITHUB_REPOSITORY: "nobody/nothing" },
    })
    expect(await json(await post(homeless, WATCHES_ROUTE, { conversationId: null }))).toEqual([404, { code: "not_found" }])
  })

  test("Postgres down: 503, logged with its code", async () => {
    const down = await harness(runtime, () => Stream.empty, {
      actor: ben,
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect(await json(await post(down, WATCHES_ROUTE, { conversationId: null }))).toEqual([503, { code: "unavailable" }])
    expect(down.line("notifications.watch")[0]!.annotations).toMatchObject({ status: 503, errorCode: expect.stringMatching(/^sql:/) })
  })
})

describe("POST /api/notifications/ack", () => {
  /** Ann's own done run, at version `n` of its row. */
  const settledRun = async (a: Harness) => {
    const runId = await asked(a)
    await report(a, runId, { status: "working" })
    await report(a, runId, { status: "done" })
    return Notifications.runSubject(runId)
  }

  const ack = (h: Harness, subject: string, act: string, version: number) =>
    post(h, ACK_ROUTE, { subject, act, version })

  test("an agent cannot acknowledge the person's notification", async () => {
    const a = await open(ann)
    const subject = await settledRun(a)
    const before = await rows(subject)
    const agent = await open({ ...ann, act: { kind: "agent", id: "agent-1" } })
    expect(await json(await ack(agent, subject, "dismiss", 2))).toEqual([403, { code: "person_only" }])
    expect(await rows(subject)).toEqual(before)
  })

  test("Read, Dismiss and Hide each move their own version, merged with greatest() and never past the row's", async () => {
    const a = await open(ann)
    const subject = await settledRun(a)
    expect(await rowOf(subject, "person-ann")).toMatchObject({ version: 2, readVersion: 0 })

    expect(await json(await ack(a, subject, "read", 1))).toEqual([200, { txid: expect.any(Number) }])
    // A later device's act for a newer version wins; an older one arriving late changes nothing.
    expect((await ack(a, subject, "read", 9)).status).toBe(200)
    expect(await json(await ack(a, subject, "read", 1))).toEqual([200, { txid: null }])
    expect(await rowOf(subject, "person-ann")).toMatchObject({ readVersion: 2, dismissedVersion: 0, hiddenVersion: 0 })

    expect((await ack(a, subject, "hide", 2)).status).toBe(200)
    expect((await ack(a, subject, "dismiss", 2)).status).toBe(200)
    expect(await rowOf(subject, "person-ann")).toMatchObject({ readVersion: 2, dismissedVersion: 2, hiddenVersion: 2 })
    expect(a.line("notifications.ack").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ subject, act: "read", version: 1, status: 200 }),
      expect.objectContaining({ subject, act: "read", version: 9, status: 200 }),
      expect.objectContaining({ subject, act: "read", version: 1, status: 200, existing: true }),
      expect.objectContaining({ subject, act: "hide", status: 200 }),
      expect.objectContaining({ subject, act: "dismiss", status: 200 }),
    ])
  })

  test("two devices' acts land the same in either order", async () => {
    const a = await open(ann)
    const first = await settledRun(a)
    const second = await settledRun(a)
    await ack(a, first, "dismiss", 1)
    await ack(a, first, "dismiss", 2)
    await ack(a, second, "dismiss", 2)
    await ack(a, second, "dismiss", 1)
    expect((await rowOf(first, "person-ann"))!.dismissedVersion).toBe(2)
    expect((await rowOf(second, "person-ann"))!.dismissedVersion).toBe(2)
  })

  test("refuses someone else's row, a bad act and the signed out; a Guest's ack of a row not theirs finds none", async () => {
    const a = await open(ann)
    const subject = await settledRun(a)
    const b = await open(ben)
    expect(await json(await ack(b, subject, "read", 1))).toEqual([404, { code: "not_found" }])
    expect(await json(await ack(a, subject, "open", 1))).toEqual([400, { code: "invalid" }])
    expect(await json(await ack(a, subject, "read", 0))).toEqual([400, { code: "invalid" }])
    expect(await json(await ack(a, "", "read", 1))).toEqual([400, { code: "invalid" }])
    expect((await ack(await open(null), subject, "read", 1)).status).toBe(401)
    // Anyone signed in acks their own rows (ruling AUTH-8): a Guest has none of Ann's.
    expect(await json(await ack(await open(guest), subject, "read", 1))).toEqual([404, { code: "not_found" }])
    expect((await rowOf(subject, "person-ann"))!.readVersion).toBe(0)
  })
})

describe("GET /api/shapes/notifications", () => {
  const proxy = async (actor: Actor | null) => {
    const { name } = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const upstream: Array<URL> = []
    const h = await open(actor, {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        upstream.push(new URL(url))
        url.searchParams.set("table", `${name}.notifications`)
        return fetch(url, init)
      },
    })
    return { h, upstream }
  }

  const values = async (response: Response) =>
    ((await response.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
      row.value === undefined ? [] : [row.value]
    )

  test("syncs the signed-in Member's own rows and nobody else's", async () => {
    const a = await open(ann)
    const b = await open(ben)
    await post(b, WATCHES_ROUTE, { conversationId: null })
    const runId = await asked(a)
    await report(a, runId, { status: "working" })
    const { h, upstream } = await proxy(ben)
    const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1&where=true`)
    expect(response.status).toBe(200)
    const synced = await values(response)
    expect(synced).toContainEqual(expect.objectContaining({ recipient: "person-ben", subject: `run:${runId}`, quiet: "true" }))
    expect(synced.every((row) => row.recipient === "person-ben")).toBe(true)
    expect(Object.fromEntries(upstream[0]!.searchParams)).toMatchObject({
      table: "notifications",
      where: "recipient = $1",
      "params[1]": "person-ben",
      columns: Notifications.SYNCED_NOTIFICATION_COLUMNS.join(","),
    })
    await eventually(() => h.line("notifications.shape").length === 1)
  })

  test("signed out, it holds no one's rows; anyone else not a Member, their own acts' rows only (ruling AUTH-8)", async () => {
    const out = await proxy(null)
    expect((await out.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
    expect(out.upstream[0]!.searchParams.get("params[1]")).toBe("")
    const theirs = await proxy(guest)
    expect((await theirs.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
    expect(theirs.upstream[0]!.searchParams.get("params[1]")).toBe(guest.subject.id)
    expect(theirs.upstream[0]!.searchParams.get("where")).toBe("recipient = $1 AND mine = true")
    const member = await proxy(ann)
    expect((await member.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
    expect(member.upstream[0]!.searchParams.get("where")).toBe("recipient = $1")
  })

  test("a former Member's rows of others' runs stay theirs in Postgres but no longer sync; their own do", async () => {
    // Someone no shape was made for yet, so Electric's first answer is a snapshot of the rows below.
    const former: Actor = { subject: { kind: "person", id: `person-former-${crypto.randomUUID()}` }, role: "guest" }
    await sql(`
      INSERT INTO notifications (recipient, subject, kind, state, mine, quiet, run_id, href)
      VALUES ('${former.subject.id}', 'run:theirs', 'run', 'done', false, false, '${crypto.randomUUID()}', '/app'),
        ('${former.subject.id}', 'run:mine', 'run', 'done', true, false, '${crypto.randomUUID()}', '/app')`)
    const theirs = await proxy(former)
    const response = await theirs.h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
    expect((await values(response)).map((row) => row.subject)).toEqual(["run:mine"])
  })
})

describe("GitHub's `main` and release deliveries reach the repository's watchers", () => {
  const SHA = (digit: string) => digit.repeat(40)
  const push = (after: string, overrides: Record<string, unknown> = {}) => ({
    ref: "refs/heads/main",
    after,
    repository: { full_name: "acme/widgets", default_branch: "main", pushed_at: 1_760_000_000 },
    head_commit: { message: "Fix the parser sentinel-9a1e\n\nLong body" },
    pusher: { name: "dana" },
    ...overrides,
  })
  const release = (tag: string, overrides: Record<string, unknown> = {}) => ({
    action: "published",
    release: { tag_name: tag, name: `Widgets ${tag}`, published_at: "2026-10-20T12:00:00Z", author: { login: "dana" } },
    repository: { full_name: "acme/widgets" },
    ...overrides,
  })
  const watchRepo = () =>
    sql(
      `INSERT INTO watches (principal_id, subject, level) VALUES ('person-ann', $1, 'attention'),
        ('person-ben', $1, 'all'), ('person-cat', $1, 'muted')`,
      `repo:${REPOSITORY.id}`,
    )
  const mainRows = () => rows(`main:${REPOSITORY.id}`)

  test("distinct pushes in the same second advance the commit and version", async () => {
    await watchRepo()
    const h = await githubHarness(runtime)
    const first = await delivery("push", push(SHA("a")))
    const second = await delivery("push", push(SHA("b")))
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, first)).status).toBe(200)
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, second)).status).toBe(200)
    expect((await mainRows()).map(({ ref, version }) => ({ ref, version }))).toEqual([
      { ref: SHA("b"), version: 2 }, { ref: SHA("b"), version: 2 },
    ])
  })

  test("`main` moving is one row per watcher, raised for each newer commit; a replay or an older push changes nothing", async () => {
    await watchRepo()
    const h = await githubHarness(runtime)
    const id = crypto.randomUUID()
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("push", push(SHA("a")), { id }))).status).toBe(200)
    expect(await mainRows()).toEqual([
      expect.objectContaining({
        recipient: "person-ann",
        kind: "main",
        state: "update",
        ref: SHA("a"),
        title: "Fix the parser sentinel-9a1e",
        actor: "dana",
        href: "/acme/widgets",
        version: 1,
      }),
      expect.objectContaining({ recipient: "person-ben", version: 1 }),
    ])
    // GitHub redelivers: nothing changes.
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("push", push(SHA("a")), { id }))
    expect((await mainRows()).map((row) => row.version)).toEqual([1, 1])
    // A newer push raises it; an older one, delivered late, doesn't roll it back.
    const newer = { repository: { full_name: "Acme/Widgets", default_branch: "main", pushed_at: 1_760_000_100 } }
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("push", push(SHA("b"), newer)))
    const older = { repository: { full_name: "acme/widgets", default_branch: "main", pushed_at: 1_760_000_050 } }
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("push", push(SHA("c"), older)))
    expect(await mainRows()).toEqual([
      expect.objectContaining({ recipient: "person-ann", ref: SHA("b"), version: 2 }),
      expect.objectContaining({ recipient: "person-ben", ref: SHA("b"), version: 2 }),
    ])
    expect(h.line("notifications.repo_event").map((line) => line.annotations)).toContainEqual(
      expect.objectContaining({ kind: "main", repoId: REPOSITORY.id, watchers: 3, written: 2 }),
    )
    expect(JSON.stringify(h.logs)).not.toContain("sentinel-9a1e")
  })

  test("other branches, a deleted branch, another repository and other events reach no one", async () => {
    await watchRepo()
    const h = await githubHarness(runtime)
    for (
      const [event, payload] of [
        ["push", push(SHA("a"), { ref: "refs/heads/feature" })],
        ["push", push(SHA("0"), { deleted: true })],
        ["push", push(SHA("0"))],
        ["push", push(SHA("a"), { repository: { full_name: "someone/else", default_branch: "main" } })],
        ["push", { ref: "refs/heads/main" }],
        ["release", release("v1", { action: "created" })],
        ["release", release("v1", { repository: { full_name: "someone/else" } })],
        ["ping", { zen: "Keep it logically awesome." }],
      ] as const
    ) {
      expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery(event, payload))).status).toBe(200)
    }
    expect(await sql(`SELECT subject FROM notifications`)).toEqual([])
  })

  test("a published release is one row per watcher, once", async () => {
    await watchRepo()
    const h = await githubHarness(runtime)
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("release", release("v1.2.0")))
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("release", release("v1.2.0")))
    expect(await rows(`release:${REPOSITORY.id}:v1.2.0`)).toEqual([
      expect.objectContaining({
        recipient: "person-ann",
        kind: "release",
        title: "Widgets v1.2.0",
        ref: "v1.2.0",
        actor: "dana",
        href: "/acme/widgets/tree/v1.2.0",
        version: 1,
      }),
      expect.objectContaining({ recipient: "person-ben", version: 1 }),
    ])
  })
})

describe("repoEventOf and titleOf", () => {
  const now = new Date("2026-10-20T00:00:00Z")
  test("dates an event GitHub doesn't, names it by its tag when it has no name, and cuts long titles", () => {
    const event = Notifications.repoEventOf(
      "push",
      { ref: "refs/heads/main", after: "f".repeat(40), repository: { full_name: "acme/widgets", default_branch: "main" } },
      REPOSITORY,
      now,
    )
    expect(Option.getOrThrow(event)).toMatchObject({ occurredAt: now, title: null, actor: null })
    const unnamed = Notifications.repoEventOf(
      "release",
      { action: "published", release: { tag_name: "v2", name: null, published_at: "not a date" }, repository: { full_name: "acme/widgets" } },
      REPOSITORY,
      now,
    )
    expect(Option.getOrThrow(unnamed)).toMatchObject({ title: "v2", occurredAt: now, actor: null })
    const undated = Notifications.repoEventOf(
      "release",
      { action: "published", release: { tag_name: "v3" }, repository: { full_name: "acme/widgets" } },
      REPOSITORY,
      now,
    )
    expect(Option.getOrThrow(undated)).toMatchObject({ ref: "v3", occurredAt: now })
    expect(Notifications.titleOf("x".repeat(100))).toBe(`${"x".repeat(79)}…`)
    expect(Notifications.titleOf("  \nsecond line")).toBeNull()
    expect(Notifications.titleOf(null)).toBeNull()
  })
})
