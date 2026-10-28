// A person's own flows in ChatApi (worker/PersonalFlows.ts, docs/features/flows.md#your-own-flows), through ChatApi's
// real handler on this file's schema of the compose Postgres and the compose Electric (`pnpm db:up`): drafts round by
// round, the person's answers, saving a ready draft, writing code, reading a revision, deleting, and the shapes that
// sync only the person's own rows.
import { digestSync } from "@smthrs/crypto"
import { Deferred, Effect, Layer, Stream } from "effect"
import { SqlClient, Statement } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { MAX_SOURCE_BYTES } from "../src/features/flows-ui/contract.ts"
import type { DraftWrite } from "../src/features/flows-ui/schema.ts"
import { renderSource, SOURCE_PATH } from "../src/features/flows-ui/source.ts"
import { type Actor, Sessions, SessionsUnavailable } from "./Actor.ts"
import * as PersonalFlows from "./PersonalFlows.ts"
import { eventually, harness, recorded, testFile } from "./test/harness.ts"

const runtime = testFile("personal_flows")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE flow_drafts, flow_revisions, flows CASCADE`))
)

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const other: Actor = { subject: { kind: "person", id: "person-other" }, role: "maintainer" }
const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }

const open = (actor: Actor | null = member, options: { readonly fetch?: typeof globalThis.fetch } = {}) =>
  harness(runtime, () => Stream.empty, { ...(actor === null ? {} : { actor }), ...options })

type Harness = Awaited<ReturnType<typeof open>>

const send = (h: Harness, method: string, path: string, body?: unknown) =>
  h.fetch(path, {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  })
const json = async (response: Response) => [response.status, await response.json()] as const

/** A drafted flow's source for `name`. */
const skill = (name: string, description = "Summarize merged pull requests.") =>
  renderSource({ name, description, instructions: "Read the repository and summarize.", flows: ["repo/read"] })

/** A round of a draft for `name`, ready to save unless overridden. */
const round = (name: string, overrides: Partial<DraftWrite> = {}): DraftWrite => ({
  scope: "person",
  round: 0,
  request: "Summarize merged pull requests",
  name,
  status: "ready",
  summary: "A flow that summarizes",
  files: [{ path: SOURCE_PATH, text: skill(name) }],
  checks: [{ check: "parses", ok: true }, { check: "name", ok: true }],
  questions: [{ id: "q1", text: "Which tag pattern?", assumed: "v*", blocking: false }],
  failure: null,
  flowId: null,
  ...overrides,
})

const writeRound = (h: Harness, draftId: string, write: DraftWrite | string) =>
  send(h, "POST", `/api/flow-drafts/${draftId}`, write)

/** The save request for draft `draftId`'s file. */
const saving = (draftId: string, name: string, source = skill(name)) => ({
  draftId,
  name,
  description: "Summarize merged pull requests.",
  source,
  digest: digestSync(source),
})

/** Code written for the flow `name`, edited from `revision`. */
const writing = (name: string, revision: number, source = skill(name).replace(`"${name}/agent"`, `"${name}/answer"`)) => ({
  name,
  revision,
  description: "Summarize merged pull requests.",
  source,
  digest: digestSync(source),
})

/** A ready draft for `name`, saved: the flow it became. */
const saved = async (h: Harness, name: string) => {
  const draftId = crypto.randomUUID()
  expect((await writeRound(h, draftId, round(name))).status).toBe(200)
  const [status, body] = await json(await send(h, "POST", "/api/flows/save", saving(draftId, name)))
  expect(status).toBe(200)
  return { draftId, ...(body as { flowId: string; revision: number }) }
}

const draftRow = async (draftId: string) => {
  const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly status: string; readonly round: number; readonly questions: unknown; readonly flowId: string | null }>`
      SELECT status, round, questions, flow_id AS "flowId" FROM flow_drafts WHERE id = ${draftId}`))
  return row
}

describe("who may use the routes", () => {
  test("signed out is 401 on every route; nothing is written", async () => {
    const draftId = crypto.randomUUID()
    const h = await open(null)
    expect((await send(h, "GET", "/api/flows")).status).toBe(401)
    expect((await send(h, "GET", "/api/flow-drafts")).status).toBe(401)
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(401)
    expect((await send(h, "POST", "/api/flows/save", saving(draftId, "notes"))).status).toBe(401)
    expect((await send(h, "POST", "/api/flows/write", writing("notes", 1))).status).toBe(401)
    expect(await draftRow(draftId)).toBeUndefined()
  })

  test("a Guest of the deployment's repository has flows of their own: their lists, and a draft round they write (ruling AUTH-8)", async () => {
    const draftId = crypto.randomUUID()
    const h = await open(guest)
    expect(await json(await send(h, "GET", "/api/flows"))).toEqual([200, expect.anything()])
    expect((await send(h, "GET", "/api/flow-drafts")).status).toBe(200)
    expect((await writeRound(h, draftId, round("notes"))).status).toBeLessThan(300)
    expect(await draftRow(draftId)).toBeDefined()
  })

  test("Postgres failing is 503 unavailable, logged by its code", async () => {
    const failing = Layer.succeed(SqlClient.SqlClient, undefined as never)
    const h = await harness(runtime, () => Stream.empty, { actor: member, database: failing as never })
    expect(await json(await send(h, "GET", "/api/flows"))).toEqual([503, { code: "unavailable" }])
    expect(h.only("flow.route")).toMatchObject({ annotations: { route: "list", status: 503 } })
  })

  test("an unknown path under either route is 404", async () => {
    const h = await open()
    expect((await send(h, "GET", "/api/flows/run")).status).toBe(404)
    expect((await send(h, "POST", `/api/flows/${crypto.randomUUID()}/rename`)).status).toBe(404)
    expect((await send(h, "POST", "/api/flows/not-a-uuid/delete")).status).toBe(404)
    expect((await send(h, "GET", "/api/flow-drafts/not-a-uuid")).status).toBe(404)
    expect((await send(h, "POST", `/api/flow-drafts/${crypto.randomUUID()}/answers/more`)).status).toBe(404)
    expect((await send(h, "POST", `/api/flow-drafts/${crypto.randomUUID()}/other`)).status).toBe(404)
  })
})

describe("drafts", () => {
  test("a round inserts the author's draft, a newer round updates it, and the same round again writes nothing", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect(await json(await writeRound(h, draftId, round("notes", { status: "drafting", files: [], checks: [], questions: [] }))))
      .toEqual([200, { txid: expect.any(Number) }])
    expect(await draftRow(draftId)).toMatchObject({ status: "drafting", round: 0 })

    expect((await writeRound(h, draftId, round("notes", { round: 1 }))).status).toBe(200)
    expect(await draftRow(draftId)).toMatchObject({ status: "ready", round: 1 })
    expect(await json(await writeRound(h, draftId, round("notes", { round: 1 })))).toEqual([200, { txid: null }])
    expect(h.line("flow.route").at(-1)).toMatchObject({ annotations: { route: "draft", existing: true, round: 1, outcome: "ready" } })

    // An older round is stale.
    expect(await json(await writeRound(h, draftId, round("notes", { round: 0 })))).toEqual([409, { code: "stale_round" }])
  })

  test("only the author writes or reads a draft", async () => {
    const draftId = crypto.randomUUID()
    expect((await writeRound(await open(), draftId, round("notes"))).status).toBe(200)
    const theirs = await open(other)
    expect(await json(await writeRound(theirs, draftId, round("notes", { round: 2 })))).toEqual([403, { code: "forbidden" }])
    expect(await json(await send(theirs, "GET", `/api/flow-drafts/${draftId}`))).toEqual([403, { code: "forbidden" }])
  })

  test("GET answers the draft as the device keeps it; an unknown one is 404, and other methods 405", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    const [status, body] = await json(await send(h, "GET", `/api/flow-drafts/${draftId.toUpperCase()}`))
    expect(status).toBe(200)
    expect(body).toMatchObject({
      id: draftId,
      scope: "person",
      repoId: null,
      target: "flow",
      name: "notes",
      status: "ready",
      round: 0,
      files: [{ path: SOURCE_PATH, text: skill("notes") }],
      questions: [{ id: "q1", assumed: "v*", blocking: false }],
      flowId: null,
    })
    expect(body).not.toHaveProperty("actorId")
    expect(new Date((body as { createdAt: string }).createdAt).toISOString()).toBe((body as { createdAt: string }).createdAt)
    expect(await json(await send(h, "GET", `/api/flow-drafts/${crypto.randomUUID()}`))).toEqual([404, { code: "not_found" }])
    expect((await send(h, "PUT", `/api/flow-drafts/${draftId}`)).status).toBe(405)
  })

  test("a round that doesn't decode is 400, and one past 64 KiB of files is 413", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect(await json(await writeRound(h, draftId, "{"))).toEqual([400, { code: "invalid" }])
    expect((await writeRound(h, draftId, { ...round("notes"), scope: "repo" } as never)).status).toBe(400)
    const huge = "x".repeat(MAX_SOURCE_BYTES + 1)
    expect(await json(await writeRound(h, draftId, round("notes", { files: [{ path: SOURCE_PATH, text: huge }] }))))
      .toEqual([413, { code: "too_large" }])
    expect(await json(await writeRound(h, draftId, JSON.stringify({ pad: "x".repeat(81 * 1024) }))))
      .toEqual([413, { code: "too_large" }])
    // Malformed UTF-8 is no round at all.
    expect(await json(await h.fetch(`/api/flow-drafts/${draftId}`, { method: "POST", body: new Uint8Array([0xff, 0xfe, 0x7b]) })))
      .toEqual([400, { code: "invalid" }])
  })

  test("a saved draft never changes", async () => {
    const h = await open()
    const { draftId } = await saved(h, "notes")
    expect(await json(await writeRound(h, draftId, round("notes", { round: 3 })))).toEqual([409, { code: "settled" }])
    expect(await json(await send(h, "POST", `/api/flow-drafts/${draftId}/answers`, { round: 0, answers: [{ id: "q1", value: "v2*" }] })))
      .toEqual([409, { code: "settled" }])
  })
})

describe("GET /api/flow-drafts", () => {
  test("lists the person's own drafts not saved yet, newest first; another's, a deleted and a saved one never", async () => {
    const h = await open()
    const [kept, deleted, saved, theirs] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    expect((await writeRound(h, kept, round("notes"))).status).toBe(200)
    expect((await writeRound(h, deleted, round("other", { status: "drafting", files: [], checks: [] }))).status).toBe(200)
    expect((await writeRound(h, saved, round("saved"))).status).toBe(200)
    expect((await writeRound(await open(other), theirs, round("theirs"))).status).toBe(200)
    expect((await send(h, "POST", `/api/flow-drafts/${deleted}/delete`)).status).toBe(200)
    expect((await send(h, "POST", "/api/flows/save", saving(saved, "saved"))).status).toBe(200)

    expect(await json(await send(h, "GET", "/api/flow-drafts"))).toEqual([
      200,
      { drafts: [{ id: kept, name: "notes", request: expect.any(String), status: "ready" }] },
    ])
    expect(h.line("flow.route").at(-1)).toMatchObject({ annotations: { route: "draft_list", status: 200 } })
    expect((await send(h, "POST", "/api/flow-drafts")).status).toBe(405)
  })
})

describe("deleting a draft", () => {
  test("only the author deletes a draft not saved yet; it is gone after, and a late round can't bring it back", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes", { status: "drafting", files: [], checks: [] }))).status).toBe(200)
    expect(await json(await send(await open(other), "POST", `/api/flow-drafts/${draftId}/delete`))).toEqual([403, { code: "forbidden" }])
    const [status, body] = await json(await send(h, "POST", `/api/flow-drafts/${draftId}/delete`))
    expect([status, body]).toEqual([200, { txid: expect.any(Number) }])
    expect(h.line("flow.route").at(-1)).toMatchObject({ annotations: { route: "draft_delete", status: 200, draftId } })
    // Gone: deleting it again, reading it, answering it, saving it, and the round still running writing it.
    expect(await json(await send(h, "POST", `/api/flow-drafts/${draftId}/delete`))).toEqual([404, { code: "not_found" }])
    expect(await json(await send(h, "GET", `/api/flow-drafts/${draftId}`))).toEqual([404, { code: "not_found" }])
    expect(await json(await send(h, "POST", `/api/flow-drafts/${draftId}/answers`, { round: 0, answers: [{ id: "q1", value: "x" }] })))
      .toEqual([404, { code: "not_found" }])
    expect(await json(await send(h, "POST", "/api/flows/save", saving(draftId, "notes")))).toEqual([404, { code: "not_found" }])
    expect(await json(await writeRound(h, draftId, round("notes", { round: 1 })))).toEqual([404, { code: "not_found" }])
    expect(await draftRow(draftId)).toMatchObject({ status: "drafting", round: 0 })
    // One no one wrote, and GET, are refused too.
    expect(await json(await send(h, "POST", `/api/flow-drafts/${crypto.randomUUID()}/delete`))).toEqual([404, { code: "not_found" }])
    expect((await send(h, "GET", `/api/flow-drafts/${draftId}/delete`)).status).toBe(405)
  })

  test("a saved draft is settled, and stays", async () => {
    const h = await open()
    const { draftId } = await saved(h, "notes")
    expect(await json(await send(h, "POST", `/api/flow-drafts/${draftId}/delete`))).toEqual([409, { code: "settled" }])
    expect(await draftRow(draftId)).toMatchObject({ status: "saved" })
  })

  test.each(["read", "update"] as const)("a delete paused before its %s finds the other delete committed", async (step) => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const scratch = await runtime.runPromise(TestDatabase.Scratch)
    let pauses = 0
    const loser = await harness(runtime, () => Stream.empty, {
      actor: member,
      database: Layer.merge(scratch.database, Layer.succeed(Statement.CurrentTransformer, (statement) =>
        Effect.gen(function* () {
          const [query, params] = statement.compile()
          const target = step === "read" ? /^\s*SELECT actor_id/ : /^\s*UPDATE flow_drafts SET deleted_at/
          if (target.test(query) && params.includes(draftId) && pauses === 0) {
            pauses++
            yield* Deferred.succeed(reached, undefined)
            yield* Deferred.await(release)
          }
          return statement
        }))),
    })
    // Before read: the loser sees the tombstone immediately. Before update: it has read the live draft,
    // so its conditional UPDATE returns no rows and it must reread the winner's tombstone.
    const pending = send(loser, "POST", `/api/flow-drafts/${draftId}/delete`).then(json)
    try {
      await Promise.race([
        runtime.runPromise(Deferred.await(reached)),
        pending.then((answer) => {
          throw new Error(`delete completed before its ${step} gate: ${JSON.stringify(answer)}`)
        }),
      ])
      expect(await json(await send(h, "POST", `/api/flow-drafts/${draftId}/delete`)))
        .toEqual([200, { txid: expect.any(Number) }])
      expect(await json(await send(h, "GET", `/api/flow-drafts/${draftId}`))).toEqual([404, { code: "not_found" }])
    } finally {
      await runtime.runPromise(Deferred.succeed(release, undefined))
      await pending
    }
    expect(await pending).toEqual([404, { code: "not_found" }])
    expect(pauses).toBe(1)
    expect(loser.only("flow.route")).toMatchObject({ annotations: { route: "draft_delete", status: 404, draftId } })
    expect(loser.count(PersonalFlows.requests, { route: "draft_delete", status: "404" })).toBe(1)
  })
})

describe("answers", () => {
  test("an agent cannot answer the person's draft questions; the draft stays unchanged", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    const before = await draftRow(draftId)
    const agent = await open({ ...member, act: { kind: "agent", id: crypto.randomUUID() } })
    expect(await json(await send(agent, "POST", `/api/flow-drafts/${draftId}/answers`, {
      round: 0,
      answers: [{ id: "q1", value: "v2*" }],
    }))).toEqual([403, { code: "person_only" }])
    expect(await draftRow(draftId)).toEqual(before)
  })

  test("the author's answers land on the round's questions by id; the same answers again write nothing", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    const questions = [
      { id: "q1", text: "Which tag pattern?", assumed: "v*", blocking: false },
      { id: "q2", text: "Post as a draft release?", assumed: "no", blocking: true },
    ]
    expect((await writeRound(h, draftId, round("notes", { status: "needs_you", questions }))).status).toBe(200)
    const answers = { round: 0, answers: [{ id: "q2", value: " yes " }, { id: "nope", value: "x" }] }
    expect(await json(await send(h, "POST", `/api/flow-drafts/${draftId}/answers`, answers)))
      .toEqual([200, { txid: expect.any(Number) }])
    expect((await draftRow(draftId))!.questions).toEqual([questions[0], { ...questions[1], answer: "yes" }])
    expect(await json(await send(h, "POST", `/api/flow-drafts/${draftId}/answers`, answers))).toEqual([200, { txid: null }])
  })

  test("answers for another round, or while a round drafts, are stale; refusals by code", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    const answer = (round: number, value = "v2*") =>
      send(h, "POST", `/api/flow-drafts/${draftId}/answers`, { round, answers: [{ id: "q1", value }] })
    expect(await json(await answer(0))).toEqual([404, { code: "not_found" }])
    expect((await writeRound(h, draftId, round("notes", { status: "drafting" }))).status).toBe(200)
    expect(await json(await answer(0))).toEqual([409, { code: "stale_round" }])
    expect((await writeRound(h, draftId, round("notes", { round: 1 }))).status).toBe(200)
    expect(await json(await answer(0))).toEqual([409, { code: "stale_round" }])
    expect(await json(await answer(1, ""))).toEqual([400, { code: "invalid" }])
    expect(await json(await send(await open(other), "POST", `/api/flow-drafts/${draftId}/answers`, { round: 1, answers: [{ id: "q1", value: "x" }] })))
      .toEqual([403, { code: "forbidden" }])
    expect((await send(h, "GET", `/api/flow-drafts/${draftId}/answers`)).status).toBe(405)
  })
})

describe("POST /api/flows/save", () => {
  test("a ready draft becomes revision 1 of a new flow and the draft is saved; saving again answers the same", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    const [status, body] = await json(await send(h, "POST", "/api/flows/save", saving(draftId.toUpperCase(), "notes")))
    expect(status).toBe(200)
    expect(body).toEqual({ flowId: expect.any(String), name: "notes", revision: 1, txid: expect.any(Number) })
    expect(await draftRow(draftId)).toMatchObject({ status: "saved", flowId: (body as { flowId: string }).flowId })
    expect(await json(await send(h, "POST", "/api/flows/save", saving(draftId, "notes"))))
      .toEqual([200, { ...(body as object), txid: null }])
    expect(h.line("flow.route").at(-1)).toMatchObject({ annotations: { route: "save", existing: true } })
  })

  test("two saves of one ready draft at once make one revision, and both answer it", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    const answers = await Promise.all([1, 2].map(() => send(h, "POST", "/api/flows/save", saving(draftId, "notes")).then(json)))
    expect(answers.map(([status]) => status)).toEqual([200, 200])
    const [first, second] = answers.map(([, body]) => body as { flowId: string; revision: number })
    expect(second).toMatchObject({ flowId: first!.flowId, revision: 1 })
    const [count] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM flow_revisions WHERE flow_id = ${first!.flowId}`))
    expect(count!.n).toBe(1)
  })

  /**
   * Saves `draftId` while a newer round, `newer`, holds the draft's row uncommitted: the save reads the old round, then
   * waits on its lock until the newer round commits. Answers the save's status and body.
   */
  const saveAgainstNewerRound = async (h: Harness, draftId: string, newer: DraftWrite, deleted = false) => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let held!: () => void
    const holding = new Promise<void>((resolve) => (held = resolve))
    const writing = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function* () {
        yield* sql`
          UPDATE flow_drafts SET status = ${newer.status}, round = ${newer.round},
            files = ${JSON.stringify(newer.files)}::jsonb, checks = ${JSON.stringify(newer.checks)}::jsonb,
            deleted_at = ${deleted ? new Date() : null}
          WHERE id = ${draftId}`
        held()
        yield* Effect.promise(() => released)
      }))))
    await holding
    const answer = send(h, "POST", "/api/flows/save", saving(draftId, "notes")).then(json)
    try {
      // The save's transaction waits on the newer round's row lock.
      await eventually(async () => {
        const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql<{ readonly n: number }>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`))
        return row!.n > 0
      }, 10_000)
    } finally {
      release()
      await writing
    }
    return answer
  }

  const noFlows = async () => {
    const [count] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM flows`))
    expect(count!.n).toBe(0)
  }

  test("a save that finds the draft drafting a newer round once it holds it is not_ready, and writes nothing", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    expect(await saveAgainstNewerRound(h, draftId, round("notes", { round: 1, status: "drafting", files: [], checks: [] })))
      .toEqual([409, { code: "not_ready" }])
    expect(await draftRow(draftId)).toMatchObject({ status: "drafting", round: 1, flowId: null })
    await noFlows()
  })

  test("a save that finds the draft deleted once it holds it is not_found", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    expect(await saveAgainstNewerRound(h, draftId, round("notes"), true)).toEqual([404, { code: "not_found" }])
    await noFlows()
  })

  test("a save that finds a newer ready round with another file once it holds it is not_draft: the newer round stays ready", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    const other = { path: SOURCE_PATH, text: skill("notes", "Summarize merged pull requests, newest first.") }
    expect(await saveAgainstNewerRound(h, draftId, round("notes", { round: 1, files: [other] })))
      .toEqual([409, { code: "not_draft" }])
    expect(await draftRow(draftId)).toMatchObject({ status: "ready", round: 1, flowId: null })
    await noFlows()
  })

  test("a draft that edits a flow saves its next revision under the same id", async () => {
    const h = await open()
    const first = await saved(h, "notes")
    const draftId = crypto.randomUUID()
    const source = skill("notes", "Summarize merged pull requests by label.")
    expect((await writeRound(h, draftId, round("notes", { flowId: first.flowId, files: [{ path: SOURCE_PATH, text: source }] }))).status).toBe(200)
    const [status, body] = await json(await send(h, "POST", "/api/flows/save", { ...saving(draftId, "notes", source), description: "By label." }))
    expect([status, body]).toEqual([200, { flowId: first.flowId, name: "notes", revision: 2, txid: expect.any(Number) }])
    expect(await json(await send(h, "GET", "/api/flows"))).toEqual([
      200,
      { flows: [{ id: first.flowId, name: "notes", revision: 2, description: "By label.", placement: "client" }] },
    ])
  })

  test("an edit of a flow deleted meanwhile is refused gone", async () => {
    const h = await open()
    const first = await saved(h, "notes")
    expect((await send(h, "POST", `/api/flows/${first.flowId}/delete`)).status).toBe(200)
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes", { flowId: first.flowId }))).status).toBe(200)
    expect(await json(await send(h, "POST", "/api/flows/save", saving(draftId, "notes")))).toEqual([409, { code: "gone" }])
  })

  test("a name another live flow of the person holds is taken; another person's isn't", async () => {
    const h = await open()
    await saved(h, "notes")
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    expect(await json(await send(h, "POST", "/api/flows/save", saving(draftId, "notes")))).toEqual([409, { code: "name_taken" }])
    expect(h.line("flow.route").at(-1)).toMatchObject({ annotations: { code: "name_taken", status: 409 } })
    await saved(await open(other), "notes")
  })

  test("refuses what it can't admit, by code", async () => {
    const h = await open()
    const cases: ReadonlyArray<readonly [string, Partial<DraftWrite>, (draftId: string) => object, number]> = [
      ["name", {}, (id) => saving(id, "flow"), 409],
      ["digest", {}, (id) => ({ ...saving(id, "notes"), digest: "0".repeat(64) }), 409],
      ["not_ready", { status: "needs_you" }, (id) => saving(id, "notes"), 409],
      ["checks", { checks: [{ check: "calls", ok: false, code: "forbidden" }] }, (id) => saving(id, "notes"), 409],
      ["checks", { checks: [] }, (id) => saving(id, "notes"), 409],
      ["needs_you", { questions: [{ id: "q", text: "Which?", assumed: "a", blocking: true }] }, (id) => saving(id, "notes"), 409],
      ["not_draft", {}, (id) => saving(id, "notes", skill("notes", "Another.")), 409],
      ["not_draft", { files: [] }, (id) => saving(id, "notes"), 409],
      ["not_draft", { files: [{ path: "SKILL.md", text: skill("notes") }] }, (id) => saving(id, "notes"), 409],
      ["not_draft", { name: "other" }, (id) => saving(id, "notes"), 409],
    ]
    for (const [code, overrides, request, status] of cases) {
      const draftId = crypto.randomUUID()
      expect((await writeRound(h, draftId, round("notes", overrides))).status).toBe(200)
      expect([code, await json(await send(h, "POST", "/api/flows/save", request(draftId)))]).toEqual([code, [status, { code }]])
    }
    const big = "x".repeat(MAX_SOURCE_BYTES)
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    expect(await json(await send(h, "POST", "/api/flows/save", saving(draftId, "notes", `${big}x`)))).toEqual([413, { code: "too_large" }])
  })

  test("an unknown draft is 404, another's 403, a body that doesn't decode 400, and GET 405", async () => {
    const h = await open()
    expect(await json(await send(h, "POST", "/api/flows/save", saving(crypto.randomUUID(), "notes"))))
      .toEqual([404, { code: "not_found" }])
    const draftId = crypto.randomUUID()
    expect((await writeRound(h, draftId, round("notes"))).status).toBe(200)
    expect(await json(await send(await open(other), "POST", "/api/flows/save", saving(draftId, "notes"))))
      .toEqual([403, { code: "forbidden" }])
    expect(await json(await send(h, "POST", "/api/flows/save", { draftId }))).toEqual([400, { code: "invalid" }])
    expect((await send(h, "GET", "/api/flows/save")).status).toBe(405)
  })
})

describe("POST /api/flows/write", () => {
  test("code written by hand is the next revision and runs here; code that needs a machine runs on a sandbox", async () => {
    const h = await open()
    const first = await saved(h, "notes")
    const machine = writing("notes", 1, `import { readFile } from "node:fs/promises"\n${skill("notes")}`)
    expect(await json(await send(h, "POST", "/api/flows/write", machine)))
      .toEqual([200, { flowId: first.flowId, name: "notes", revision: 2, txid: expect.any(Number) }])
    expect(h.line("flow.route").at(-1)).toMatchObject({ annotations: { route: "write", revision: 1, placement: "sandbox" } })
    expect(await json(await send(h, "GET", "/api/flows"))).toEqual([200, {
      flows: [{ id: first.flowId, name: "notes", revision: 2, description: "Summarize merged pull requests.", placement: "sandbox" }],
    }])
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes"))).toMatchObject([200, { revision: 2, source: machine.source }])

    // A relabelled step is the person's code, which runs on their device in the QuickJS realm.
    const edited = writing("notes", 2)
    expect(await json(await send(h, "POST", "/api/flows/write", edited)))
      .toEqual([200, { flowId: first.flowId, name: "notes", revision: 3, txid: expect.any(Number) }])
    expect(h.line("flow.route").at(-1)).toMatchObject({ annotations: { route: "write", revision: 2, placement: "client" } })
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes"))).toEqual([200, {
      flowId: first.flowId,
      name: "notes",
      revision: 3,
      digest: edited.digest,
      source: edited.source,
    }])
    expect((await json(await send(h, "GET", "/api/flows")))[1]).toMatchObject({ flows: [{ revision: 3, placement: "client" }] })
  })

  test("a write from a revision another followed is stale, the same write again isn't; a flow the person hasn't is 404", async () => {
    const h = await open()
    const first = await saved(h, "notes")
    expect((await send(h, "POST", "/api/flows/write", writing("notes", 1))).status).toBe(200)
    // The same write again, as a step tried again after its answer was lost: the revision it made.
    expect(await json(await send(h, "POST", "/api/flows/write", writing("notes", 1))))
      .toEqual([200, { flowId: first.flowId, name: "notes", revision: 2, txid: null }])
    // Other bytes from the same revision: stale.
    expect(await json(await send(h, "POST", "/api/flows/write", writing("notes", 1, skill("notes", "Other.")))))
      .toEqual([409, { code: "stale" }])
    expect(h.line("flow.route").at(-1)).toMatchObject({ annotations: { code: "stale", status: 409 } })
    expect(await json(await send(h, "POST", "/api/flows/write", writing("other", 1)))).toEqual([404, { code: "not_found" }])
    expect(await json(await send(await open(other), "POST", "/api/flows/write", writing("notes", 2))))
      .toEqual([404, { code: "not_found" }])
  })

  test("refuses what it can't admit, by code; a body that doesn't decode is 400, and GET 405", async () => {
    const h = await open()
    await saved(h, "notes")
    expect(await json(await send(h, "POST", "/api/flows/write", writing("flow", 1)))).toEqual([409, { code: "name" }])
    expect(await json(await send(h, "POST", "/api/flows/write", { ...writing("notes", 1), digest: "0".repeat(64) })))
      .toEqual([409, { code: "digest" }])
    const big = "x".repeat(MAX_SOURCE_BYTES + 1)
    expect(await json(await send(h, "POST", "/api/flows/write", writing("notes", 1, big)))).toEqual([413, { code: "too_large" }])
    expect(await json(await send(h, "POST", "/api/flows/write", { name: "notes" }))).toEqual([400, { code: "invalid" }])
    expect((await send(h, "GET", "/api/flows/write")).status).toBe(405)
    // Nothing was written.
    expect((await json(await send(h, "GET", "/api/flows")))[1]).toMatchObject({ flows: [{ revision: 1 }] })
  })
})

describe("reading flows", () => {
  test("GET /api/flows lists the person's live flows, newest first, and no one else's", async () => {
    const h = await open()
    const notes = await saved(h, "notes")
    const triage = await saved(h, "triage")
    await saved(await open(other), "theirs")
    expect(await json(await send(h, "GET", "/api/flows"))).toEqual([200, {
      flows: [
        { id: triage.flowId, name: "triage", revision: 1, description: "Summarize merged pull requests.", placement: "client" },
        { id: notes.flowId, name: "notes", revision: 1, description: "Summarize merged pull requests.", placement: "client" },
      ],
    }])
    expect((await send(h, "POST", "/api/flows")).status).toBe(405)
  })

  test("GET /api/flows/source reads the latest revision, or one by number, also of a deleted flow", async () => {
    const h = await open()
    const first = await saved(h, "notes")
    const latest = { flowId: first.flowId, name: "notes", revision: 1, digest: digestSync(skill("notes")), source: skill("notes") }
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes"))).toEqual([200, latest])
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes&revision=1"))).toEqual([200, latest])
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes&revision=2"))).toEqual([404, { code: "not_found" }])

    expect(await json(await send(h, "POST", `/api/flows/${first.flowId}/delete`))).toEqual([200, { txid: expect.any(Number) }])
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes"))).toEqual([404, { code: "not_found" }])
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes&revision=1"))).toEqual([200, latest])
    // Its name is free again.
    const again = await saved(h, "notes")
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes&revision=1"))).toEqual([200, { ...latest, flowId: again.flowId }])
    expect(await json(await send(await open(other), "GET", "/api/flows/source?name=notes"))).toEqual([404, { code: "not_found" }])
    // By its id: the deleted flow's revision, though the name went to another flow; the live one's latest by id too.
    expect(await json(await send(h, "GET", `/api/flows/source?name=notes&revision=1&flowId=${first.flowId.toUpperCase()}`)))
      .toEqual([200, latest])
    expect(await json(await send(h, "GET", `/api/flows/source?name=notes&flowId=${again.flowId}`)))
      .toEqual([200, { ...latest, flowId: again.flowId }])
    // Another person's flow by id, an id under another name, or a revision it never had: not found.
    expect(await json(await send(await open(other), "GET", `/api/flows/source?name=notes&revision=1&flowId=${first.flowId}`)))
      .toEqual([404, { code: "not_found" }])
    expect(await json(await send(h, "GET", `/api/flows/source?name=other&revision=1&flowId=${first.flowId}`)))
      .toEqual([404, { code: "not_found" }])
    expect(await json(await send(h, "GET", `/api/flows/source?name=notes&revision=9&flowId=${first.flowId}`)))
      .toEqual([404, { code: "not_found" }])
  })

  test("a name or revision that doesn't read is 400, and POST is 405", async () => {
    const h = await open()
    expect(await json(await send(h, "GET", "/api/flows/source?name=notes&flowId=not-a-uuid"))).toEqual([400, { code: "invalid" }])
    for (const query of ["", "?name=Bad", "?name=notes&revision=0", "?name=notes&revision=x"]) {
      expect([query, (await send(h, "GET", `/api/flows/source${query}`)).status]).toEqual([query, 400])
    }
    expect((await send(h, "POST", "/api/flows/source?name=notes")).status).toBe(405)
  })

  test("deleting someone else's flow, or one already gone, is 404; GET is 405", async () => {
    const h = await open()
    const first = await saved(h, "notes")
    expect(await json(await send(await open(other), "POST", `/api/flows/${first.flowId}/delete`))).toEqual([404, { code: "not_found" }])
    expect((await send(h, "GET", `/api/flows/${first.flowId}/delete`)).status).toBe(405)
    expect((await send(h, "POST", `/api/flows/${first.flowId.toUpperCase()}/delete`)).status).toBe(200)
    expect((await send(h, "POST", `/api/flows/${first.flowId}/delete`)).status).toBe(404)
  })
})

describe("the pure rules", () => {
  test("withAnswers keeps unanswered questions and ignores answers to none", () => {
    const questions = [{ id: "a", text: "A?", assumed: "1", blocking: false }]
    expect(PersonalFlows.withAnswers(questions, [{ id: "b", value: "2" }])).toEqual(questions)
    expect(PersonalFlows.withAnswers(questions, [{ id: "a", value: "2" }])).toEqual([{ ...questions[0], answer: "2" }])
  })

  test("nameAllowed takes the pattern outside the app's names", () => {
    expect(PersonalFlows.nameAllowed("release-notes")).toBe(true)
    expect(PersonalFlows.nameAllowed("theme")).toBe(false)
    expect(PersonalFlows.nameAllowed("Release")).toBe(false)
  })
})

describe("the shapes", () => {
  const proxy = async (actor: Actor | null) => {
    const { name } = await runtime.runPromise(Effect.gen(function* () {
      return yield* TestDatabase.Scratch
    }))
    const upstream: Array<URL> = []
    const h = await open(actor, {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        upstream.push(new URL(url))
        const table = url.searchParams.get("table")
        if (table === "flows" || table === "flow_drafts") url.searchParams.set("table", `${name}.${table}`)
        return fetch(url, init)
      },
    })
    return { h, upstream }
  }

  const values = async (response: Response) =>
    ((await response.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
      row.value === undefined ? [] : [row.value]
    )

  test("flows syncs the person's live flows without their owner; drafts the person's drafts without their author", async () => {
    const { h, upstream } = await proxy(member)
    const mine = await saved(h, "notes")
    const gone = await saved(h, "gone")
    expect((await send(h, "POST", `/api/flows/${gone.flowId}/delete`)).status).toBe(200)
    await saved(await open(other), "theirs")

    const flows = await values(await h.fetch("/api/shapes/flows?offset=-1&columns=owner_id"))
    expect(flows.map((flow) => flow.id)).toEqual([mine.flowId])
    expect(flows[0]).not.toHaveProperty("owner_id")
    expect(Object.fromEntries(upstream[0]!.searchParams)).toEqual({
      offset: "-1",
      table: "flows",
      where: "owner_id = $1 AND deleted_at IS NULL",
      "params[1]": "person-member",
      columns: PersonalFlows.SYNCED_FLOW_COLUMNS.join(","),
    })

    // A deleted draft leaves the shape.
    const deleted = crypto.randomUUID()
    expect((await writeRound(h, deleted, round("later"))).status).toBe(200)
    expect((await send(h, "POST", `/api/flow-drafts/${deleted}/delete`)).status).toBe(200)
    const drafts = await values(await h.fetch("/api/shapes/flow-drafts?offset=-1"))
    expect(drafts.map((draft) => draft.id).sort()).toEqual([mine.draftId, gone.draftId].sort())
    expect(drafts[0]).not.toHaveProperty("actor_id")
    expect(upstream[1]!.searchParams.get("where")).toBe("actor_id = $1 AND deleted_at IS NULL")
    await eventually(() => h.line("flow.shape").length === 1 && h.line("flow.drafts.shape").length === 1)
  })

  test("signed out, the shapes hold no one's rows", async () => {
    const { h, upstream } = await proxy(null)
    expect((await h.fetch("/api/shapes/flows?offset=-1")).status).toBe(200)
    expect(upstream[0]!.searchParams.get("params[1]")).toBe("")
  })

  test("when who is asking can't be read, both shapes are refused 503 and Electric is never asked", async () => {
    const upstream: Array<URL> = []
    const h = await harness(runtime, () => Stream.empty, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
      fetch: async (input) => {
        upstream.push(new URL(input instanceof Request ? input.url : String(input)))
        return new Response("[]")
      },
    })
    const statuses = []
    for (const route of ["/api/shapes/flows", "/api/shapes/flow-drafts"]) {
      const response = await h.fetch(`${route}?offset=-1&handle=h-1`)
      statuses.push([response.status, response.headers.get("retry-after")])
    }
    expect(statuses).toEqual([[503, "5"], [503, "5"]])
    expect(upstream).toEqual([])
  })
})

describe("telemetry", () => {
  test("no request, file, question, answer, description or name reaches a record", async () => {
    const h = await open()
    const draftId = crypto.randomUUID()
    const canary = "canary-7f3a"
    expect((await writeRound(h, draftId, {
      ...round(`n${canary}`),
      request: `ask ${canary}`,
      files: [{ path: SOURCE_PATH, text: skill(`n${canary}`, `d ${canary}`) }],
      questions: [{ id: "q1", text: `q ${canary}`, assumed: canary, blocking: false }],
    })).status).toBe(200)
    expect((await send(h, "POST", `/api/flow-drafts/${draftId}/answers`, { round: 0, answers: [{ id: "q1", value: canary }] })).status).toBe(200)
    expect((await send(h, "POST", "/api/flows/save", {
      ...saving(draftId, `n${canary}`, skill(`n${canary}`, `d ${canary}`)),
      description: `d ${canary}`,
    })).status).toBe(200)
    expect((await send(h, "GET", `/api/flows/source?name=n${canary}`)).status).toBe(200)
    expect((await send(h, "POST", "/api/flows/write", {
      ...writing(`n${canary}`, 1, skill(`n${canary}`, `d ${canary}`).replace("Read the", `${canary} read the`)),
      description: `d ${canary}`,
    })).status).toBe(200)
    expect(recorded(h)).not.toContain(canary)
  })
})
