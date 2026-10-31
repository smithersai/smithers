import { ConfigProvider, Effect, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import * as TimelineSummaries from "./TimelineSummaries.ts"
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
    "bad", "a".repeat(16_385), {}, { ...claim(answer), op: "other" }, { ...claim(answer), reason: "words" }, { ...claim(answer), revision: "NOT-HEX" },
    { ...claim(answer), messageId: "bad" }, { op: "record", messageId: answer, revision: revision(3), summary: "" },
    { op: "record", messageId: answer, revision: revision(3), summary: "two\nlines" }, { op: "record", messageId: answer, revision: revision(3), summary: "x".repeat(97) },
  ]) expect((await post(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)
  expect((await post(claim(crypto.randomUUID()))).status).toBe(404)
  expect((await post(claim(streaming.answer))).status).toBe(409)
  const { tracked } = await import("./test/branch.ts")
  const hidden = await tracked(runtime, "github/octocat/spoon-knife", "private-summary", "open", "somebody-else")
  const unseen = crypto.randomUUID()
  await sql(sql => sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${unseen}, 'user', 'Hidden', 'done', ${hidden.conversationId})`)
  expect((await post(claim(unseen))).status).toBe(404)
  // Only the summary flow's claim was taken; no refusal claimed anything.
  expect(await sql(sql => sql`SELECT message_id FROM timeline_summaries WHERE revision = ${revision(3)}`)).toEqual([{ message_id: answer }])
})

test("a question is claimed like an answer: every settled message gets its summary", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const { question } = await exchange()
  expect(await (await poster(h)({ op: "claim", messageId: question, revision: revision(5), reason: "question" })).json()).toEqual({ claimed: true })
  expect((await poster(h)({ op: "record", messageId: question, revision: revision(5), summary: "Check the retry" })).status).toBe(200)
  expect(await sql(sql => sql`SELECT summary FROM messages WHERE id = ${question}`)).toEqual([{ summary: "Check the retry" }])
})

/** A conversation of `count` finished exchanges; their questions' ids. */
const exchanges = async (count: number) => {
  const made: Array<string> = []
  for (let n = 0; n < count; n++) made.push((await exchange()).question)
  return made
}
const stored = (title: string, closed: boolean, covered = 2) => JSON.stringify({ title, summary: `${title}, done.`, closed, covered })
const marks = (ids: ReadonlyArray<string>) => sql(sql => sql<{ readonly id: string; readonly phase: string | null }>`SELECT id, phase FROM messages WHERE id = ANY(${ids}::uuid[]) ORDER BY position`)

test("a claim whose model never answered is free again, for anyone, and every attempt counts; a recorded one stays", async () => {
  const h = await harness(runtime, answers("Hi"), { actor: person("release-person"), config: { TIMELINE_SUMMARY_DAILY_CAP: "2" } })
  const other = await harness(runtime, answers("Hi"), { actor: person("release-other") })
  const { answer } = await exchange()
  const key = { messageId: answer, revision: revision(6) }
  const claim = { op: "claim", ...key, reason: "answer" }
  expect(await (await poster(h)(claim)).json()).toEqual({ claimed: true })
  // Someone else's claim isn't theirs to free.
  await poster(other)({ op: "release", ...key })
  expect(await (await poster(other)(claim)).json()).toEqual({ claimed: false })
  expect(await (await poster(h)({ op: "release", ...key })).json()).toEqual({ released: true })
  // A released claim records nothing, and its cap is back.
  expect((await poster(h)({ op: "record", ...key, summary: "Late" })).status).toBe(409)
  expect(await (await poster(h)(claim)).json()).toEqual({ claimed: true })
  expect((await poster(h)({ op: "record", ...key, summary: "Retried twice" })).status).toBe(200)
  await poster(h)({ op: "release", ...key })
  expect(await (await poster(other)(claim)).json()).toEqual({ claimed: false })
  // Two attempts spent the cap of two: an outage can't re-claim for ever.
  const next = await exchange()
  expect((await poster(h)({ op: "claim", messageId: next.answer, revision: revision(6), reason: "answer" })).status).toBe(429)
})

test("a claim a closed tab left behind can be taken after ten minutes, not before", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const [anchor] = await exchanges(1)
  const key = { messageId: anchor!, level: 1, revision: revision(11) }
  expect(await (await poster(h)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
  expect(await (await poster(h)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: false })
  await sql(sql => sql`UPDATE timeline_phase_claims SET claimed_at = now() - interval '11 minutes' WHERE anchor_id = ${anchor!}`)
  expect(await (await poster(h)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
})

test("a stale device can't cut a closed span short", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const [a, b, c] = await exchanges(3)
  const first = { messageId: a!, level: 1, revision: revision(12) }
  await poster(h)({ op: "claim_spans", ...first })
  await poster(h)({ op: "record_spans", ...first, spans: [{ id: a!, mark: stored("Researching", true, 2) }, { id: c!, mark: stored("Fixing", false, 1) }] })
  const stale = { messageId: b!, level: 1, revision: revision(13) }
  await poster(h)({ op: "claim_spans", ...stale })
  const refused = await poster(h)({ op: "record_spans", ...stale, spans: [{ id: b!, mark: stored("Rewritten", false) }] })
  expect([refused.status, await refused.json()]).toEqual([409, { code: "closed" }])
})

test("spans are claimed once for everyone, written onto the messages they start at, and a closed span never changes", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const other = await harness(runtime, answers("Hi"), { actor: person("span-other") })
  const [a, b, c, d] = await exchanges(4)
  const key = { messageId: a!, level: 1, revision: revision(7) }
  expect(await (await poster(h)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
  expect(await (await poster(other)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: false })
  const spans = [{ id: a!, mark: stored("Researching issue", true) }, { id: c!, mark: stored("Fixing tests", false) }]
  expect((await poster(other)({ op: "record_spans", ...key, spans })).status).toBe(409)
  expect(await (await poster(h)({ op: "record_spans", ...key, messageId: a!.toUpperCase(), spans })).json()).toEqual({ recorded: true })
  expect(await marks([a!, b!, c!])).toEqual([{ id: a, phase: spans[0]!.mark }, { id: b, phase: null }, { id: c, phase: spans[1]!.mark }])
  // A replay of a recorded call stands.
  expect((await poster(h)({ op: "record_spans", ...key, spans })).status).toBe(200)
  // The open span may be rewritten; it goes, and what the new call made stands.
  const again = { messageId: c!, level: 1, revision: revision(8) }
  expect(await (await poster(h)({ op: "claim_spans", ...again })).json()).toEqual({ claimed: true })
  const next = [{ id: c!, mark: stored("Fixing flaky tests", true) }, { id: d!, mark: stored("Reviewing the fix", false) }]
  expect((await poster(h)({ op: "record_spans", ...again, spans: next })).status).toBe(200)
  expect((await marks([c!, d!])).map(row => row.phase)).toEqual([next[0]!.mark, next[1]!.mark])
  // A closed span refuses to be rewritten.
  const closed = { messageId: a!, level: 1, revision: revision(9) }
  await poster(h)({ op: "claim_spans", ...closed })
  const refused = await poster(h)({ op: "record_spans", ...closed, spans: [{ id: a!, mark: stored("Rewritten", true) }] })
  expect([refused.status, await refused.json()]).toEqual([409, { code: "closed" }])
  expect((await marks([a!]))[0]!.phase).toBe(spans[0]!.mark)
  // Arcs keep their own column, for the same messages.
  const arc = { messageId: a!, level: 2, revision: revision(7) }
  await poster(h)({ op: "claim_spans", ...arc })
  expect((await poster(h)({ op: "record_spans", ...arc, spans: [{ id: a!, mark: stored("Issue work", false) }] })).status).toBe(200)
  expect(await sql(sql => sql`SELECT arc FROM messages WHERE id = ${a!}`)).toEqual([{ arc: stored("Issue work", false) }])
})

test("a span's refusals: bad marks, foreign or earlier messages, an unclaimed call, a released one, and the cap", async () => {
  const h = await harness(runtime, answers("Hi"), { actor: person("span-refused"), config: { TIMELINE_SUMMARY_DAILY_CAP: "1" } })
  const flow = await harness(runtime, answers("Hi"), { actor: { ...person("span-flow"), act: { kind: "flow", id: "run-5", chain: ["timeline/phases"] } } })
  const [a, b] = await exchanges(2)
  const key = { messageId: b!, level: 1, revision: revision(10) }
  const good = [{ id: b!, mark: stored("Fixing tests", false) }]
  expect((await poster(h)({ op: "record_spans", ...key, spans: good })).status).toBe(409)
  expect(await (await poster(h)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
  // The cap counts spans and summaries together.
  const capped = await poster(h)({ op: "claim", messageId: a!, revision: revision(10), reason: "answer" })
  expect(capped.status).toBe(429)
  for (const spans of [
    [], [{ id: b!, mark: "not json" }], [{ id: a!, mark: stored("Earlier", false) }], [{ id: b!, mark: stored("Fixing", false) }, { id: a!, mark: stored("Earlier", false) }],
    [{ id: b!, mark: stored("Fixing", false) }, { id: crypto.randomUUID(), mark: stored("Gone", false) }],
  ]) expect((await poster(h)({ op: "record_spans", ...key, spans })).status, JSON.stringify(spans).slice(0, 80)).toBe(400)
  expect(await (await poster(h)({ op: "release_spans", ...key })).json()).toEqual({ released: true })
  expect((await poster(h)({ op: "record_spans", ...key, spans: good })).status).toBe(409)
  // The phases flow acts for its person; a released call can be claimed again.
  expect(await (await poster(flow)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
})

test("a database the route can't reach is 503, and no claim is assumed", async () => {
  const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))
  const h = await harness(runtime, () => Stream.empty, { actor, database: unreachable })
  const answered = await poster(h)({ op: "claim", messageId: crypto.randomUUID(), revision: revision(4), reason: "long_answer" })
  expect([answered.status, await answered.json()]).toEqual([503, { code: "unavailable" }])
})

test("the cap's default is the caller's when unset, and the environment's when set", async () => {
  const read = (env: Record<string, string>, unset?: number) => TimelineSummaries.dailyCap(unset).parse(ConfigProvider.fromEnv({ env }))
  expect(await Effect.runPromise(read({}))).toBe(200)
  expect(await Effect.runPromise(read({}, 100_000))).toBe(100_000)
  expect(await Effect.runPromise(read({ TIMELINE_SUMMARY_DAILY_CAP: "7" }, 100_000))).toBe(7)
})
