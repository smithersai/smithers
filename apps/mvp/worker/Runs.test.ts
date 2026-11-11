// The runs routes (worker/Runs.ts, docs/features/agent-status.md#the-routes), through ChatApi's real handler on this
// file's schema of the compose Postgres and the compose Electric (`pnpm db:up`): a run's steps report its status, the
// person answers its open question, and the shape syncs only that person's rows.
import { Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { MAX_RUN_BODY_BYTES } from "../src/features/status/contract.ts"
import type { Report } from "../src/features/status/schema.vibe"
import { type Actor, Sessions, SessionsUnavailable } from "./Actor.vibe"
import * as Runs from "./Runs.ts"
import { eventually, harness, testFile } from "./test/harness.ts"

const runtime = testFile("runs")

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const other: Actor = { subject: { kind: "person", id: "person-other" }, role: "maintainer" }
const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }

const open = (actor: Actor | null = member, options: { readonly fetch?: typeof globalThis.fetch } = {}) =>
  harness(runtime, () => Stream.empty, { ...(actor === null ? {} : { actor }), ...options })

type Harness = Awaited<ReturnType<typeof open>>

const post = (h: Harness, path: string, body: unknown, init: RequestInit = {}) =>
  h.fetch(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init })

/** Asks a question as `h`'s actor: the answer's id, which is the run's. */
const asked = async (h: Harness) => {
  const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Deploy the docs preview" }
  expect((await h.ask(question)).status).toBe(202)
  return question.answerId
}

const wait = (execution = "run/call/0.0", kind: "question" | "approval" = "question") => ({
  execution,
  kind,
  prompt: "Which branch should I deploy?",
  options: kind === "question" ? ["main", "docs-v2"] : [],
})

const report = (h: Harness, runId: string, body: Report | string) => post(h, `/api/runs/${runId}`, body)
const answer = (h: Harness, runId: string, version: number, value: unknown) =>
  post(h, `/api/runs/${runId}/answer`, { version, value })

const runRow = async (runId: string) => {
  const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly status: string
      readonly waiting: string | null
      readonly wait: unknown
      readonly version: number
      readonly answer: unknown
      readonly answeredAt: Date | null
      readonly launchedBy: string
    }>`SELECT status, waiting, wait, version, answer, answered_at AS "answeredAt", launched_by AS "launchedBy"
      FROM runs WHERE id = ${runId}`))
  return row
}

const json = async (response: Response) => [response.status, await response.json()]

describe("POST /api/runs/<id>: a run reports its status", () => {
  test("the asker's run writes working, waiting and a question, and a report that changes nothing writes nothing", async () => {
    const h = await open()
    const runId = await asked(h)

    expect(await json(await report(h, runId, { status: "waiting", waiting: "turn" }))).toEqual([
      200,
      { txid: expect.any(Number) },
    ])
    expect(await runRow(runId)).toMatchObject({ status: "waiting", waiting: "turn", wait: null, version: 0, launchedBy: "person-member" })

    expect((await report(h, runId, { status: "working" })).status).toBe(200)
    expect(await json(await report(h, runId, { status: "working" }))).toEqual([200, { txid: null }])
    expect(await runRow(runId)).toMatchObject({ status: "working", waiting: null })

    expect((await report(h, runId, { status: "needs_you", wait: wait() })).status).toBe(200)
    expect(await runRow(runId)).toMatchObject({ status: "needs_you", waiting: "input", wait: wait(), version: 1 })
    // The same question again is the same question.
    expect(await json(await report(h, runId, { status: "needs_you", wait: wait() }))).toEqual([
      200,
      { txid: null },
    ])
    expect((await runRow(runId))!.version).toBe(1)

    expect(h.line("agent.status.report").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ runId, report: "waiting", status: 200 }),
      expect.objectContaining({ runId, report: "working", status: 200 }),
      expect.objectContaining({ runId, report: "working", status: 200, existing: true }),
      expect.objectContaining({ runId, report: "needs_you", status: 200 }),
      expect.objectContaining({ runId, report: "needs_you", status: 200, existing: true }),
    ])
    expect(h.count(Runs.requests, { route: "report", status: "200" })).toBe(5)
    expect(h.span("agent.status.request")).toHaveLength(5)
    // No line carries the question.
    expect(JSON.stringify(h.logs)).not.toContain("Which branch")
  })

  test("a first report can be the question: the run starts at version 1, and an approval waits on approval", async () => {
    const h = await open()
    const runId = await asked(h)
    expect((await report(h, runId, { status: "needs_you", wait: wait("a/call/0.0", "approval") })).status)
      .toBe(200)
    expect(await runRow(runId)).toMatchObject({ status: "needs_you", waiting: "approval", version: 1 })
  })

  test("a new question bumps the version and clears the last answer; the answered one is never reopened", async () => {
    const h = await open()
    const runId = await asked(h)
    await report(h, runId, { status: "needs_you", wait: wait("r/call/0.0") })
    expect((await answer(h, runId, 1, "docs-v2")).status).toBe(200)
    // A replay of the question already answered changes nothing.
    expect(await json(await report(h, runId, { status: "needs_you", wait: wait("r/call/0.0") }))).toEqual([
      200,
      { txid: null },
    ])
    await report(h, runId, { status: "working" })
    expect(await runRow(runId)).toMatchObject({ status: "working", waiting: null, wait: wait("r/call/0.0"), answer: { value: "docs-v2" } })

    await report(h, runId, { status: "needs_you", wait: wait("r/call/1.0") })
    expect(await runRow(runId)).toMatchObject({
      status: "needs_you",
      wait: wait("r/call/1.0"),
      version: 2,
      answer: null,
      answeredAt: null,
    })
  })

  test("a settled run never changes again, and a report to it says so", async () => {
    const h = await open()
    const runId = await asked(h)
    await report(h, runId, { status: "done" })
    for (const body of [
      { status: "working" },
      { status: "failed" },
      { status: "needs_you", wait: wait() },
    ] as const) {
      expect(await json(await report(h, runId, body))).toEqual([409, { code: "not_writable", reason: "settled" }])
    }
    expect(await runRow(runId)).toMatchObject({ status: "done", version: 0 })
    expect(h.line("agent.status.report").at(-1)).toMatchObject({
      annotations: { errorCode: "not_writable", reason: "settled", status: 409 },
    })
    const failed = await asked(h)
    await report(h, failed, { status: "failed" })
    await report(h, failed, { status: "done" })
    expect((await runRow(failed))!.status).toBe("failed")
  })

  test("a report to a row someone else launched is refused with its reason, and writes nothing", async () => {
    const h = await open()
    const runId = await asked(h)
    // A row whose launcher isn't the asker: not one ChatApi writes, but the report must never take it over.
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO runs (id, flow, status, version, launched_by, conversation_id)
        SELECT ${runId}, 'chat/Answer', 'working', 0, ${other.subject.id}, conversation_id FROM messages WHERE id = ${runId}`))
    expect(await json(await report(h, runId, { status: "needs_you", wait: wait() }))).toEqual([
      409,
      { code: "not_writable", reason: "other_launcher" },
    ])
    expect(await runRow(runId)).toMatchObject({ status: "working", launchedBy: other.subject.id, version: 0 })
  })

  test("only the asker reports, while they may ask; anything else is refused and writes nothing", async () => {
    const h = await open()
    const runId = await asked(h)
    const working = { status: "working" } as const

    expect(await json(await report(await open(other), runId, working))).toEqual([403, { code: "forbidden" }])
    expect(await json(await report(await open(guest), runId, working))).toEqual([403, { code: "forbidden" }])
    expect(await json(await report(await open(null), runId, working))).toEqual([401, { code: "authentication" }])
    // A question's id, or an id that isn't an answer at all.
    expect(await json(await report(h, crypto.randomUUID(), working))).toEqual([404, { code: "not_found" }])
    expect(await json(await report(h, "not-a-uuid", working))).toEqual([404, { code: "not_found" }])
    expect(await json(await post(h, `/api/runs/${runId}/answers`, {}))).toEqual([404, { code: "not_found" }])
    expect(await json(await post(h, `/api/runs/${runId}/answer/again`, {}))).toEqual([404, { code: "not_found" }])
    expect((await h.fetch(`/api/runs/${runId}`)).status).toBe(405)
    expect(await json(await report(h, runId, "{"))).toEqual([400, { code: "invalid" }])
    expect(await json(await report(h, runId, JSON.stringify({ status: "live" })))).toEqual([
      400,
      { code: "invalid" },
    ])
    expect(await json(await report(h, runId, JSON.stringify({ status: "needs_you" })))).toEqual([
      400,
      { code: "invalid" },
    ])
    const large = await report(h, runId, JSON.stringify({ ...working, pad: "x".repeat(MAX_RUN_BODY_BYTES) }))
    expect(await json(large)).toEqual([413, { code: "too_large" }])
    const malformed = await h.fetch(`/api/runs/${runId}`, { method: "POST", body: new Uint8Array([0xff, 0xfe]) })
    expect(await json(malformed)).toEqual([400, { code: "invalid" }])
    expect(await runRow(runId)).toBeUndefined()
    expect(h.line("agent.status.report").some((line) => line.annotations.errorCode === "not_launcher")).toBe(false)
  })

  test("Postgres out of reach is 503 unavailable, logged with the failure's code", async () => {
    const h = await harness(runtime, () => Stream.empty, {
      actor: member,
      database: Layer.effect(SqlClient.SqlClient, Effect.die(new Error("unreachable"))),
    })
    const response = await report(h, crypto.randomUUID(), { status: "working" })
    expect(await json(response)).toEqual([503, { code: "unavailable" }])
    expect(h.only("agent.status.report")).toMatchObject({ level: "ERROR", annotations: { status: 503, errorCode: "unknown" } })
  })
})

describe("POST /api/runs/<id>/answer: the person answers", () => {
  const needing = async (kind: "question" | "approval" = "question") => {
    const h = await open()
    const runId = await asked(h)
    await report(h, runId, { status: "needs_you", wait: wait("x/call/0.0", kind) })
    return { h, runId }
  }

  test("the first answer settles the question; the same answer again is taken, another is 409 not_open", async () => {
    const { h, runId } = await needing()
    expect(await json(await answer(h, runId, 1, "  docs-v2 "))).toEqual([200, { txid: expect.any(Number) }])
    const row = await runRow(runId)
    expect(row).toMatchObject({ status: "needs_you", answer: { value: "docs-v2" } })
    expect(row!.answeredAt).toBeInstanceOf(Date)
    expect(await json(await answer(h, runId, 1, "docs-v2"))).toEqual([200, { txid: null }])
    expect(await json(await answer(h, runId, 1, "main"))).toEqual([409, { code: "not_open" }])
    expect((await runRow(runId))!.answer).toEqual({ value: "docs-v2" })
    expect(h.line("agent.status.answer").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ runId, version: 1, status: 200 }),
      expect.objectContaining({ runId, version: 1, status: 200, existing: true }),
      expect.objectContaining({ runId, version: 1, status: 409 }),
    ])
    expect(JSON.stringify(h.logs)).not.toContain("docs-v2")
    expect(h.count(Runs.requests, { route: "answer", status: "409" })).toBe(1)
  })

  test("an approval takes true or false, and a question takes words only", async () => {
    const approval = await needing("approval")
    expect(await json(await answer(approval.h, approval.runId, 1, "yes"))).toEqual([400, { code: "invalid" }])
    expect(await json(await answer(approval.h, approval.runId, 1, false))).toEqual([200, { txid: expect.any(Number) }])
    expect((await runRow(approval.runId))!.answer).toEqual({ value: false })
    expect(await json(await answer(approval.h, approval.runId, 1, false))).toEqual([200, { txid: null }])
    expect(await json(await answer(approval.h, approval.runId, 1, true))).toEqual([409, { code: "not_open" }])
    expect(await json(await answer(approval.h, approval.runId, 1, { approved: false, note: "" }))).toEqual([
      409,
      { code: "not_open" },
    ])
    const question = await needing()
    expect(await json(await answer(question.h, question.runId, 1, true))).toEqual([400, { code: "invalid" }])
    expect(await json(await answer(question.h, question.runId, 1, "   "))).toEqual([400, { code: "invalid" }])
    expect(await json(await post(question.h, `/api/runs/${question.runId}/answer`, { version: 0, value: "x" }))).toEqual([
      400,
      { code: "invalid" },
    ])
  })

  test("an approval takes a decision with a note, trimmed; the same again is taken, another is 409 not_open", async () => {
    const approval = await needing("approval")
    const changes = { approved: false, note: "  Keep the logs. " }
    expect(await json(await answer(approval.h, approval.runId, 1, changes))).toEqual([200, { txid: expect.any(Number) }])
    expect((await runRow(approval.runId))!.answer).toEqual({ value: { approved: false, note: "Keep the logs." } })
    expect(await json(await answer(approval.h, approval.runId, 1, { approved: false, note: "Keep the logs." }))).toEqual([
      200,
      { txid: null },
    ])
    for (const other of [{ approved: true, note: "Keep the logs." }, { approved: false, note: "Other." }, false]) {
      expect(await json(await answer(approval.h, approval.runId, 1, other))).toEqual([409, { code: "not_open" }])
    }
    expect(JSON.stringify(approval.h.logs)).not.toContain("Keep the logs")

    // An empty note is a decision without one; a note over the limit, or a missing field, isn't an answer.
    const empty = await needing("approval")
    expect(await json(await answer(empty.h, empty.runId, 1, { approved: true, note: "   " }))).toEqual([
      200,
      { txid: expect.any(Number) },
    ])
    expect((await runRow(empty.runId))!.answer).toEqual({ value: { approved: true, note: "" } })
    const refused = await needing("approval")
    for (const value of [{ approved: true, note: "x".repeat(8_001) }, { approved: true }, { note: "x" }]) {
      expect(await json(await answer(refused.h, refused.runId, 1, value))).toEqual([400, { code: "invalid" }])
    }
    // A question takes no decision, with a note or without.
    const question = await needing()
    expect(await json(await answer(question.h, question.runId, 1, { approved: true, note: "main" }))).toEqual([
      400,
      { code: "invalid" },
    ])
  })

  test("an answer to another version, or once the question closed, is 409 not_open", async () => {
    const { h, runId } = await needing()
    expect(await json(await answer(h, runId, 2, "main"))).toEqual([409, { code: "not_open" }])
    await report(h, runId, { status: "working" })
    expect(await json(await answer(h, runId, 1, "main"))).toEqual([409, { code: "not_open" }])
  })

  test("only the person whose run it is answers; an unknown run is 404", async () => {
    const { runId } = await needing()
    expect(await json(await answer(await open(other), runId, 1, "main"))).toEqual([403, { code: "forbidden" }])
    expect(await json(await answer(await open(guest), runId, 1, "main"))).toEqual([403, { code: "forbidden" }])
    expect(await json(await answer(await open(null), runId, 1, "main"))).toEqual([401, { code: "authentication" }])
    const h = await open()
    expect(await json(await answer(h, crypto.randomUUID(), 1, "main"))).toEqual([404, { code: "not_found" }])
    expect(await json(await post(h, `/api/runs/${runId}/answer`, "{"))).toEqual([400, { code: "invalid" }])
    const large = await post(h, `/api/runs/${runId}/answer`, JSON.stringify({ version: 1, value: "x".repeat(MAX_RUN_BODY_BYTES) }))
    expect(await json(large)).toEqual([413, { code: "too_large" }])
    const malformed = await h.fetch(`/api/runs/${runId}/answer`, { method: "POST", body: new Uint8Array([0xff, 0xfe]) })
    expect(await json(malformed)).toEqual([400, { code: "invalid" }])
    expect((await runRow(runId))!.answer).toBeNull()
  })
})

describe("GET /api/shapes/runs", () => {
  const proxy = async (actor: Actor | null) => {
    const { name } = await runtime.runPromise(Effect.gen(function* () {
      return yield* TestDatabase.Scratch
    }))
    const upstream: Array<URL> = []
    const h = await open(actor, {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        upstream.push(new URL(url))
        if (url.searchParams.get("table") === "runs") url.searchParams.set("table", `${name}.runs`)
        return fetch(url, init)
      },
    })
    return { h, upstream }
  }

  test("syncs the signed-in person's rows without who launched them", async () => {
    const { h, upstream } = await proxy(member)
    const mine = await asked(h)
    await report(h, mine, { status: "needs_you", wait: wait() })
    const theirs = await open(other)
    const not = await asked(theirs)
    await report(theirs, not, { status: "working" })

    const response = await h.fetch("/api/shapes/runs?offset=-1&where=true&columns=launched_by")
    expect(response.status).toBe(200)
    const rows = (await response.json()) as Array<{ readonly value?: Record<string, unknown> }>
    const values = rows.flatMap((row) => (row.value === undefined ? [] : [row.value]))
    // Every row the file's earlier tests wrote for this person, and none of anyone else's.
    const ids = values.map((value) => value.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(not)
    const row = values.find((value) => value.id === mine)!
    expect(row).not.toHaveProperty("launched_by")
    expect(row).toMatchObject({ status: "needs_you", waiting: "input", version: "1" })
    // The conversation the run works in: what a device attributes its wait by (decision 0110, the data gate).
    expect(row.conversation_id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    expect(Object.fromEntries(upstream[0]!.searchParams)).toEqual({
      offset: "-1",
      table: "runs",
      where: "(launched_by = $1 AND execution IS NULL) OR addressed_to = $1",
      "params[1]": "person-member",
      columns: Runs.SYNCED_RUN_COLUMNS.join(","),
    })
    await eventually(() => h.line("agent.status.shape").length === 1)
    expect(h.count(Runs.shapes, { status: "200", live: "false" })).toBe(1)
  })

  test("when who is asking can't be read, the request is refused 503 and Electric is never asked", async () => {
    const { name } = await runtime.runPromise(Effect.gen(function* () {
      return yield* TestDatabase.Scratch
    }))
    const upstream: Array<URL> = []
    const h = await harness(runtime, () => Stream.empty, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        upstream.push(new URL(url))
        url.searchParams.set("table", `${name}.runs`)
        return fetch(url, init)
      },
    })
    const response = await h.fetch("/api/shapes/runs?offset=-1&handle=h-1")
    expect([response.status, response.headers.get("retry-after")]).toEqual([503, "5"])
    expect(upstream).toEqual([])
  })

  test("signed out, the shape holds no one's rows", async () => {
    const { h, upstream } = await proxy(null)
    const response = await h.fetch("/api/shapes/runs?offset=-1")
    expect(response.status).toBe(200)
    expect(upstream[0]!.searchParams.get("params[1]")).toBe("")
  })
})
