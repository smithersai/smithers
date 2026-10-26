import { Effect, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import { TIMELINE_SUMMARIES_ROUTE } from "../src/features/timeline/contract.ts"
import { answers, harness, testFile } from "./test/harness.ts"

const runtime = testFile("timeline_summaries")
const person = (id: string) => ({ subject: { kind: "person" as const, id }, role: "member" as const })
const actor = person("summary-person")
const sql = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use))
const revision = (n: number) => `${n}`.padStart(64, "a")

/** A finished exchange in the home conversation; its answer's id. `status` the answer's. */
const exchange = async (status = "done") => {
  const [conversation] = await sql(sql => sql<{ readonly id: string }>`SELECT id FROM conversations LIMIT 1`)
  const question = crypto.randomUUID(), answer = crypto.randomUUID()
  await sql(sql => sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${question}, 'user', 'Did it retry?', 'done', ${conversation!.id})`)
  await sql(sql => sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id)
    VALUES (${answer}, 'assistant', 'It retried twice and kept both attempts.', ${status}, ${question}, ${conversation!.id})`)
  return { question, answer }
}
const poster = (h: Awaited<ReturnType<typeof harness>>) => (body: unknown) =>
  h.fetch(TIMELINE_SUMMARIES_ROUTE, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })

test("the first claim of an answer's revision takes it for every tab, device and person; its summary lands on the message", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const other = await harness(runtime, answers("Hi"), { actor: person("summary-other") })
  const { answer } = await exchange()
  const claim = { op: "claim", messageId: answer, revision: revision(1), reason: "long_answer" }
  const first = await poster(h)(claim)
  expect([first.status, await first.json()]).toEqual([200, { claimed: true }])
  // The same person's other tab, and another person, are told it is taken.
  for (const who of [h, other]) expect(await (await poster(who)(claim)).json()).toEqual({ claimed: false })
  // Only the claimant records it, onto the message every device syncs.
  expect((await poster(other)({ op: "record", messageId: answer, revision: revision(1), summary: "Retry kept both attempts" })).status).toBe(409)
  const recorded = await poster(h)({ op: "record", messageId: answer.toUpperCase(), revision: revision(1), summary: "Retry kept both attempts" })
  expect([recorded.status, await recorded.json()]).toEqual([200, { recorded: true }])
  // Recording again (a replay) writes the same summary.
  expect((await poster(h)({ op: "record", messageId: answer, revision: revision(1), summary: "Retry kept both attempts" })).status).toBe(200)
  expect(await sql(sql => sql`SELECT summary, summary_revision AS revision FROM messages WHERE id = ${answer}`))
    .toEqual([{ summary: "Retry kept both attempts", revision: revision(1) }])
  expect(await sql(sql => sql`SELECT person_id, reason, recorded_at IS NOT NULL AS recorded FROM timeline_summaries WHERE message_id = ${answer}`))
    .toEqual([{ person_id: actor.subject.id, reason: "long_answer", recorded: true }])
  // New content is a new revision, claimable once more.
  expect(await (await poster(other)({ ...claim, revision: revision(2), reason: "multiline_answer" })).json()).toEqual({ claimed: true })
  expect(h.line("timeline.summary.claim").at(0)!.annotations).toMatchObject({ status: 200, outcome: "claimed", reason: "long_answer" })
  expect(h.line("timeline.summary.claim").at(1)!.annotations).toMatchObject({ outcome: "taken" })
  expect(JSON.stringify(h.line("timeline.summary.claim"))).not.toContain("Retry kept")
})

test("a person's claims stop at the daily cap, whoever else claims", async () => {
  const h = await harness(runtime, answers("Hi"), { actor: person("capped-person"), config: { TIMELINE_SUMMARY_DAILY_CAP: "1" } })
  const other = await harness(runtime, answers("Hi"), { actor: person("uncapped-person"), config: { TIMELINE_SUMMARY_DAILY_CAP: "1" } })
  const [a, b] = [await exchange(), await exchange()]
  expect(await (await poster(h)({ op: "claim", messageId: a.answer, revision: revision(1), reason: "long_answer" })).json()).toEqual({ claimed: true })
  const capped = await poster(h)({ op: "claim", messageId: b.answer, revision: revision(1), reason: "long_answer" })
  expect([capped.status, await capped.json()]).toEqual([429, { code: "capped" }])
  expect(await (await poster(other)({ op: "claim", messageId: b.answer, revision: revision(1), reason: "long_answer" })).json()).toEqual({ claimed: true })
  expect(h.line("timeline.summary.claim").at(-1)!.annotations).toMatchObject({ status: 429, outcome: "capped" })
})

test("the route refuses what isn't a person's finished answer they may view", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const post = poster(h)
  const { question, answer } = await exchange()
  const streaming = await exchange("streaming")
  const claim = (messageId: string) => ({ op: "claim", messageId, revision: revision(3), reason: "long_answer" })
  expect((await h.fetch(TIMELINE_SUMMARIES_ROUTE)).status).toBe(405)
  expect((await poster(await harness(runtime, answers("Hi")))(claim(answer))).status).toBe(401)
  for (const act of [{ kind: "agent" as const, id: "run-1", chain: ["timeline/summarize"] }, { kind: "flow" as const, id: "run-2", chain: ["chat/pin"] }, { kind: "flow" as const, id: "run-3" }]) {
    expect((await poster(await harness(runtime, answers("Hi"), { actor: { ...actor, act } }))(claim(answer))).status, act.id).toBe(403)
  }
  // The summary flow acting for the person may claim.
  const flow = await harness(runtime, answers("Hi"), { actor: { ...actor, act: { kind: "flow", id: "run-4", chain: ["timeline/summarize"] } } })
  expect(await (await poster(flow)(claim(answer))).json()).toEqual({ claimed: true })
  for (const body of [
    "bad", "a".repeat(1025), {}, { ...claim(answer), op: "other" }, { ...claim(answer), reason: "words" }, { ...claim(answer), revision: "NOT-HEX" },
    { ...claim(answer), messageId: "bad" }, { op: "record", messageId: answer, revision: revision(3), summary: "" },
    { op: "record", messageId: answer, revision: revision(3), summary: "two\nlines" }, { op: "record", messageId: answer, revision: revision(3), summary: "x".repeat(97) },
  ]) expect((await post(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)
  expect((await post(claim(crypto.randomUUID()))).status).toBe(404)
  expect((await post(claim(question))).status).toBe(409)
  expect((await post(claim(streaming.answer))).status).toBe(409)
  const { tracked } = await import("./test/branch.ts")
  const hidden = await tracked(runtime, "github/octocat/spoon-knife", "private-summary", "open", "somebody-else")
  const unseen = crypto.randomUUID()
  await sql(sql => sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${unseen}, 'user', 'Hidden', 'done', ${hidden.conversationId})`)
  expect((await post(claim(unseen))).status).toBe(404)
  // Only the summary flow's claim was taken; no refusal claimed anything.
  expect(await sql(sql => sql`SELECT message_id FROM timeline_summaries WHERE revision = ${revision(3)}`)).toEqual([{ message_id: answer }])
})

test("a database the route can't reach is 503, and no claim is assumed", async () => {
  const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))
  const h = await harness(runtime, () => Stream.empty, { actor, database: unreachable })
  const answered = await poster(h)({ op: "claim", messageId: crypto.randomUUID(), revision: revision(4), reason: "long_answer" })
  expect([answered.status, await answered.json()]).toEqual([503, { code: "unavailable" }])
})
