// A person's own list of conversations on the server (decision 0013 decision 2, docs/features/conversations.md): the
// statements (worker/branch/ConversationPeople.vibe) and the routes (worker/branch/ConversationApi.vibe) against the compose
// Postgres and Electric, in this file's own schema (worker/test/harness.ts).
import * as Database from "../../db/Database.ts"
import { ARCHIVE_ROUTE } from "../../src/features/conversations/contract.ts"
import * as Api from "./ConversationApi.vibe"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import { branchHarness, resetBranches, tracked } from "../test/branch.ts"
import { testFile } from "../test/harness.ts"
import * as People from "./ConversationPeople.vibe"

const runtime = testFile("conversation_people")
beforeEach(() => resetBranches(runtime))
const actor = { subject: { kind: "person" as const, id: "person-member" }, role: "member" as const }
const rows = () => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT * FROM conversation_people ORDER BY person_id`))

test("personal, idempotent latest acts win; asks never restore and opens restore at server time", async () => {
  const b = await tracked(runtime, "github/octocat/spoon-knife", "feature")
  const run = runtime.runPromise
  await run(People.asked(b.conversationId, "a"))
  await run(People.asked(b.conversationId, "b"))
  const at = Date.now() + 1000
  expect(await run(People.archive(b.conversationId, "a", true, at))).not.toBeNull()
  expect(await run(People.archive(b.conversationId, "a", false, at - 1))).toBeNull()
  expect(await run(People.archive(b.conversationId, "a", true, at))).toBeNull()
  await run(People.asked(b.conversationId, "a"))
  expect((await rows())[0].archived_at).not.toBeNull()
  expect((await rows())[1].archived_at).toBeNull()
  await run(People.opened(b.conversationId, "a", "Octocat", "Spoon-Knife", "feature"))
  expect((await rows())[0].archived_at).not.toBeNull()
  await run(People.archive(b.conversationId, "a", false, at + 1))
  expect(await run(People.archive(b.conversationId, "a", true, at))).toBeNull()
  await run(People.archive(b.conversationId, "c", true, 1))
  await run(People.opened(b.conversationId, "c", "Octocat", "Spoon-Knife", "feature"))
  expect((await rows())[2]).toMatchObject({ owner: "Octocat", archived_at: null })
  expect(await run(People.archive(b.conversationId, "c", true, 2))).toBeNull()
})

test("archive route validates method, authentication, body, access and existence", async () => {
  const b = await tracked(runtime, "github/octocat/spoon-knife", "feature", "open", actor.subject.id)
  const h = await branchHarness(runtime, { actor })
  const post = (body: unknown, harness = h) =>
    harness.fetch(ARCHIVE_ROUTE, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
  const of = (fields: Record<string, unknown>) => ({ conversationId: b.conversationId, ...fields })
  expect((await h.fetch(ARCHIVE_ROUTE)).status).toBe(405)
  for (const body of [
    "{}",
    "null",
    "1",
    "no",
    of({ archived: 1, at: 1 }),
    of({ archived: true, at: 1.5 }),
    of({ archived: true, at: "1" }),
    of({ archived: true, at: 0 }),
    of({ archived: true, at: Date.now() + 172_800_000 }),
    { conversationId: "bad", archived: true, at: 1 },
    // Exactly one of the conversation and the answer.
    { archived: true, at: 1 },
    of({ answerId: b.conversationId, archived: true, at: 1 }),
  ]) {
    expect((await post(body)).status, JSON.stringify(body)).toBe(400)
  }
  expect((await post("x".repeat(257))).status).toBe(413)
  expect((await post({ conversationId: "00000000-0000-4000-8000-000000000000", archived: true, at: 1 })).status).toBe(404)
  const at = Date.now() + 100
  expect(await (await post(of({ archived: true, at }))).json()).toEqual({ archived: true, txid: expect.any(Number) })
  expect(await (await post(of({ archived: false, at: at - 1 }))).json()).toEqual({ archived: false, txid: null })
  expect(await (await post(of({ archived: false, at: at + 1 }))).json()).toEqual({ archived: false, txid: expect.any(Number) })
  const broken = await h.fetch(ARCHIVE_ROUTE, { method: "POST", body: new Uint8Array([0xff]) })
  expect(broken.status).toBe(400)
  expect((await post("{}", await branchHarness(runtime))).status).toBe(401)
  const other = await branchHarness(runtime, { actor: { ...actor, subject: { kind: "person", id: "other" } } })
  expect((await post(of({ archived: true, at: 1 }), other)).status).toBe(403)
})

test("the agent's run archives the conversation its answer is in, and no other answer's", async () => {
  const b = await tracked(runtime, "github/octocat/spoon-knife", "feature", "open", actor.subject.id)
  const [question, answer, someone] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO messages (id, role, text, status, asked_by, conversation_id)
    VALUES (${question}, 'user', 'Archive this', 'done', ${actor.subject.id}, ${b.conversationId})`))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO messages (id, role, status, question_id, conversation_id)
    VALUES (${answer}, 'assistant', 'streaming', ${question}, ${b.conversationId})`))
  const run = { ...actor, act: { kind: "agent" as const, id: answer } }
  const h = await branchHarness(runtime, { actor: run })
  const post = (answerId: string) =>
    h.fetch(ARCHIVE_ROUTE, { method: "POST", body: JSON.stringify({ answerId, archived: true, at: Date.now() }) })
  expect((await post(answer)).status).toBe(200)
  expect((await rows())[0]).toMatchObject({ conversation_id: b.conversationId, person_id: actor.subject.id })
  expect((await rows())[0].archived_at).not.toBeNull()
  // Another answer than its own: refused before anything is read.
  expect((await post(someone)).status).toBe(403)
  // Its own answer, but one nobody asked: no such conversation to archive.
  const person = await branchHarness(runtime, { actor })
  const missing = await person.fetch(ARCHIVE_ROUTE, {
    method: "POST",
    body: JSON.stringify({ answerId: someone, archived: true, at: Date.now() }),
  })
  expect(missing.status).toBe(404)
  // Someone else's question's answer: forbidden.
  const stranger = await branchHarness(runtime, { actor: { ...actor, subject: { kind: "person", id: "other" } } })
  const theirs = await stranger.fetch(ARCHIVE_ROUTE, {
    method: "POST",
    body: JSON.stringify({ answerId: answer, archived: true, at: Date.now() }),
  })
  expect(theirs.status).toBe(403)
})

test("the shape holds only the person's own rows, drops forged filters, and holds none signed out", async () => {
  const b = await tracked(runtime, "github/octocat/spoon-knife", "feature")
  await runtime.runPromise(People.asked(b.conversationId, actor.subject.id))
  await runtime.runPromise(People.asked(b.conversationId, "other"))
  for (const person of [actor, undefined]) {
    const h = await branchHarness(runtime, { actor: person })
    const response = await h.fetch("/api/shapes/my-conversations?offset=-1&where=true&table=messages&columns=person_id")
    expect(response.status, await response.clone().text()).toBe(200)
    const values = (await response.json() as Array<{ value?: Record<string, unknown> }>).flatMap(row => row.value ? [row.value] : [])
    expect(values).toHaveLength(person ? 1 : 0)
    if (person) {
      expect(values[0]).toMatchObject({
        conversation_id: b.conversationId,
        person_id: actor.subject.id,
        owner: "octocat",
        repo: "spoon-knife",
        branch: "feature",
      })
    }
    expect(Object.fromEntries(h.electric[0]!.searchParams)).toMatchObject({
      table: "conversation_people",
      where: "person_id = $1",
      "params[1]": person?.subject.id ?? "",
      columns: Api.SYNCED_COLUMNS.join(","),
    })
  }
})


test("archive failures are unavailable with one content-free span, log and counter", async () => {
  const h = await branchHarness(runtime, { actor, database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))) })
  const id = "00000000-0000-4000-8000-000000000000"
  const response = await h.fetch(ARCHIVE_ROUTE, { method: "POST", body: JSON.stringify({ conversationId: id, archived: true, at: 1 }) })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ code: "unavailable" })
  expect(h.only("conversation.archive").annotations).toMatchObject({ conversationId: id, status: 503, outcome: "unavailable", durationMs: expect.any(Number) })
  expect(h.span("conversation.archive")).toHaveLength(1)
  expect(h.count(Api.archives, { outcome: "unavailable" })).toBe(1)
})

test("an open tried again after a lost answer never undoes an archive made since, nor moves up the list", async () => {
  const b = await tracked(runtime, "github/octocat/spoon-knife", "feature")
  const run = runtime.runPromise
  const row = async () => (await rows())[0] as { archived_at: Date | null; opened_at: Date; changed_at: Date }
  const open = (at?: number) => run(People.opened(b.conversationId, "a", "octocat", "Spoon-Knife", "feature", at))
  const base = Date.now() - 60_000
  // Open A, then open B on another device, then archive: A's lost answer makes its step try again.
  await open(base)
  await open(base + 10)
  await run(People.archive(b.conversationId, "a", true, base + 20))
  await open(base)
  expect((await row()).archived_at).not.toBeNull()
  expect((await row()).opened_at.getTime()).toBe(base + 10)
  expect((await row()).changed_at.getTime()).toBe(base + 20)
  // A new open, later than the archive, brings it back; so does one that names no time, as the agent's, at now.
  await open(base + 30)
  expect((await row()).archived_at).toBeNull()
  expect((await row()).opened_at.getTime()).toBe(base + 30)
  await run(People.archive(b.conversationId, "a", true, base + 40))
  await open()
  expect((await row()).archived_at).toBeNull()
})
