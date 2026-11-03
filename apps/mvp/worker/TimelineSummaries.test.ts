import { ConfigProvider, Effect, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import * as TimelineSummaries from "./TimelineSummaries.ts"
import { TIMELINE_SUMMARIES_ROUTE } from "../src/features/timeline/contract.ts"
import { segmentRevision } from "../src/features/timeline/identity.ts"
import { answers, harness, testFile } from "./test/harness.ts"

const runtime = testFile("timeline_summaries")
const person = (id: string) => ({ subject: { kind: "person" as const, id }, role: "member" as const })
const actor = person("summary-person")
const sql = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use))
// The worker's lib is ES2022, which has no Promise.withResolvers.
const resolvers = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const revision = (n: number) => `${n}`.padStart(64, "a")
/** The durable run behind a claim: each device's own. */
const owner = crypto.randomUUID(), rival = crypto.randomUUID()

/** A finished exchange in the home conversation; its answer's id. `status` the answer's. */
const exchange = async (status = "done", conversationId?: string) => {
  const [conversation] = conversationId === undefined ? await sql(sql => sql<{ readonly id: string }>`SELECT id FROM conversations LIMIT 1`) : [{ id: conversationId }]
  const question = crypto.randomUUID(), answer = crypto.randomUUID()
  await sql(sql => sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${question}, 'user', 'Did it retry?', 'done', ${conversation!.id})`)
  await sql(sql => sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id)
    VALUES (${answer}, 'assistant', 'It retried twice and kept both attempts.', ${status}, ${question}, ${conversation!.id})`)
  return { question, answer }
}
/** Posts `body` as `h`'s run: every request carries an owner unless it names its own. */
const poster = (h: Awaited<ReturnType<typeof harness>>, run = owner) => (body: unknown) =>
  h.fetch(TIMELINE_SUMMARIES_ROUTE, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(typeof body === "object" && body !== null && "op" in body ? { owner: run, ...body } : body) })

test("the first claim of an answer's revision takes it for every tab, device and person; its summary lands on the message", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const other = await harness(runtime, answers("Hi"), { actor: person("summary-other") })
  const { answer } = await exchange()
  const claim = { op: "claim", messageId: answer, revision: revision(1), reason: "long_answer" }
  const first = await poster(h)(claim)
  expect([first.status, await first.json()]).toEqual([200, { claimed: true }])
  // The same person's other tab, and another person, are told it is taken.
  for (const who of [poster(h, rival), poster(other, rival)]) expect(await (await who(claim)).json()).toEqual({ claimed: false })
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
    "bad", {}, { ...claim(answer), op: "other" }, { ...claim(answer), reason: "words" }, { ...claim(answer), revision: "NOT-HEX" },
    { ...claim(answer), messageId: "bad" }, { op: "record", messageId: answer, revision: revision(3), summary: "" },
    { op: "record", messageId: answer, revision: revision(3), summary: "two\nlines" }, { op: "record", messageId: answer, revision: revision(3), summary: "x".repeat(97) },
  ]) expect((await post(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)
  expect((await post("a".repeat(16_385))).status).toBe(413)
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

/** A conversation of its own with `count` finished exchanges: segmentation reads a whole conversation. Its questions' ids. */
const exchanges = async (count: number) => {
  const { tracked } = await import("./test/branch.ts")
  const { conversationId } = await tracked(runtime, "github/octocat/spoon-knife", `phases-${crypto.randomUUID()}`, "open")
  const made: Array<string> = []
  for (let n = 0; n < count; n++) made.push((await exchange("done", conversationId)).question)
  return made
}
/** One segmentation's identity: its anchor, how many items it reads, and its level. */
const call = (messageId: string, read = 4, level = 1) => ({ messageId, level, read, owner, revision: segmentRevision(messageId.toLowerCase(), level, read) })
const span = (id: string, title: string) => ({ id, title, summary: `${title}, done.` })
const stored = (title: string, closed: boolean, covered: number) => JSON.stringify({ title, summary: `${title}, done.`, closed, covered })
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
  expect(await (await poster(other, rival)(claim)).json()).toEqual({ claimed: false })
  expect(await (await poster(h)({ op: "release", ...key })).json()).toEqual({ released: true })
  // A released claim records nothing, and its cap is back.
  expect((await poster(h)({ op: "record", ...key, summary: "Late" })).status).toBe(409)
  expect(await (await poster(h)(claim)).json()).toEqual({ claimed: true })
  expect((await poster(h)({ op: "record", ...key, summary: "Retried twice" })).status).toBe(200)
  await poster(h)({ op: "release", ...key })
  expect(await (await poster(other, rival)(claim)).json()).toEqual({ claimed: false })
  // Two attempts spent the cap of two: an outage can't re-claim for ever.
  const next = await exchange()
  expect((await poster(h)({ op: "claim", messageId: next.answer, revision: revision(6), reason: "answer" })).status).toBe(429)
})

test("a claim a closed tab left behind can be taken after ten minutes, not before", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const [anchor] = await exchanges(4)
  const key = call(anchor!)
  expect(await (await poster(h)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
  expect(await (await poster(h)({ op: "claim_spans", ...key, owner: rival })).json()).toEqual({ claimed: false })
  await sql(sql => sql`UPDATE timeline_phase_claims SET claimed_at = now() - interval '11 minutes' WHERE anchor_id = ${anchor!}`)
  expect(await (await poster(h)({ op: "claim_spans", ...key, owner: rival })).json()).toEqual({ claimed: true })
  // The run that lost it can't record over the one that took it.
  const lost = await poster(h)({ op: "record_spans", ...key, spans: [span(anchor!, "Fixing tests")] })
  expect([lost.status, await lost.json()]).toEqual([409, { code: "unclaimed" }])
})

test("a stale device can't cut a closed span short or replace a newer call, at its claim or at its record", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const ids = await exchanges(9)
  // Claimed before the record that closes the span, recorded after it.
  const late = call(ids[0]!, 4)
  await poster(h)({ op: "claim_spans", ...late })
  await poster(h)({ op: "claim_spans", ...call(ids[0]!, 8) })
  expect((await poster(h)({ op: "record_spans", ...call(ids[0]!, 8), spans: [span(ids[0]!, "Researching issue"), span(ids[4]!, "Fixing tests")] })).status).toBe(200)
  const refused = await poster(h)({ op: "record_spans", ...late, spans: [span(ids[0]!, "Rewritten")] })
  expect([refused.status, await refused.json()]).toEqual([409, { code: "closed" }])
  // Inside the closed span, and no newer than the open one.
  expect(await (await poster(h)({ op: "claim_spans", ...call(ids[1]!) })).json()).toEqual({ code: "closed" })
  expect(await (await poster(h)({ op: "claim_spans", ...call(ids[4]!) })).json()).toEqual({ code: "stale" })
})

test("a client's own coverage and closing never reach a mark; the server counts them from its items", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const ids = await exchanges(9)
  const key = call(ids[0]!, 8)
  await poster(h)({ op: "claim_spans", ...key })
  // Old-style marks, and whatever else a client adds, aren't a record at all.
  for (const body of [
    { op: "record_spans", ...key, spans: [{ id: ids[0]!, mark: stored("Fixing tests", true, -1) }] },
    { op: "record_spans", ...key, spans: [{ ...span(ids[0]!, "Fixing tests"), title: 3 }] },
    { op: "record_spans", ...key, read: 1.5, spans: [span(ids[0]!, "Fixing tests")] },
    { op: "record_spans", ...key, read: 1e9, spans: [span(ids[0]!, "Fixing tests")] },
    { op: "record_spans", ...key, read: 4, spans: [span(ids[0]!, "Fixing tests")] },
  ]) expect((await poster(h)(body)).status, JSON.stringify(body).slice(0, 90)).toBe(400)
  expect(await poster(h)({ op: "record_spans", ...key, spans: [{ ...span(ids[0]!, "Fixing tests"), closed: true, covered: -1 }, span(ids[3]!, "Reviewing the fix")] }).then(answered => answered.status)).toBe(200)
  expect((await marks([ids[0]!, ids[3]!])).map(row => JSON.parse(row.phase!))).toEqual([
    { title: "Fixing tests", summary: "Fixing tests, done.", closed: true, covered: 3 },
    { title: "Reviewing the fix", summary: "Reviewing the fix, done.", closed: false, covered: 5 },
  ])
})

test("two revisions recorded at once can't both replace the phases: the second reads the first's", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const ids = await exchanges(9)
  const older = call(ids[0]!, 4), newer = call(ids[0]!, 8)
  await poster(h)({ op: "claim_spans", ...older })
  await poster(h)({ op: "claim_spans", ...newer })
  // Both requests pass their reads, then wait on the row this transaction holds, as two devices racing would.
  const release = resolvers(), holding = resolvers()
  const held = sql(sql => sql.withTransaction(sql`SELECT id FROM messages WHERE id = ${ids[0]!} FOR UPDATE`.pipe(
    Effect.andThen(Effect.promise(() => { holding.resolve(); return release.promise })),
  )))
  await holding.promise
  const racing = Promise.all([
    poster(h)({ op: "record_spans", ...older, spans: [span(ids[0]!, "First device")] }),
    poster(h)({ op: "record_spans", ...newer, spans: [span(ids[0]!, "Second device")] }),
  ])
  await new Promise(resolve => setTimeout(resolve, 300))
  release.resolve()
  await held
  const [one, two] = await racing
  // Whichever went first, the newer call's coverage stands: the older one is refused, or was replaced by it.
  expect(two.status).toBe(200)
  expect([200, 409]).toContain(one.status)
  const [row] = await marks([ids[0]!])
  expect(JSON.parse(row!.phase!)).toMatchObject({ title: "Second device", covered: 8 })
})

test("a closed span survives a racing rewrite", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const ids = await exchanges(9)
  const closing = call(ids[0]!, 8), reopening = call(ids[0]!, 4)
  await poster(h)({ op: "claim_spans", ...closing })
  await poster(h)({ op: "claim_spans", ...reopening })
  const [a, b] = await Promise.all([
    poster(h)({ op: "record_spans", ...closing, spans: [span(ids[0]!, "Researching issue"), span(ids[4]!, "Fixing tests")] }),
    poster(h)({ op: "record_spans", ...reopening, spans: [span(ids[0]!, "Rewritten")] }),
  ])
  const [row] = await marks([ids[0]!])
  if (b.status === 200) expect(a.status).toBe(200)
  expect(JSON.parse(row!.phase!)).toMatchObject({ title: "Researching issue", closed: true, covered: 4 })
})

test("spans are claimed once for everyone, written onto the messages they start at, and a closed span never changes", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const other = await harness(runtime, answers("Hi"), { actor: person("span-other") })
  const ids = await exchanges(13)
  const [a, b, c, d] = ids
  const key = call(a!, 8)
  expect(await (await poster(h)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
  expect(await (await poster(other, rival)({ op: "claim_spans", ...key, owner: rival })).json()).toEqual({ claimed: false })
  const spans = [span(a!, "Researching issue"), span(d!, "Fixing tests")]
  expect((await poster(other)({ op: "record_spans", ...key, spans })).status).toBe(409)
  expect(await (await poster(h)({ op: "record_spans", ...key, messageId: a!.toUpperCase(), spans })).json()).toEqual({ recorded: true })
  expect(await marks([a!, b!, c!, d!])).toEqual([
    { id: a, phase: stored("Researching issue", true, 3) }, { id: b, phase: null }, { id: c, phase: null }, { id: d, phase: stored("Fixing tests", false, 5) },
  ])
  // A replay of a recorded call stands.
  expect((await poster(h)({ op: "record_spans", ...key, spans })).status).toBe(200)
  // The open span may be rewritten; it goes, and what the new call made stands.
  const again = call(d!, 8)
  expect(await (await poster(h)({ op: "claim_spans", ...again })).json()).toEqual({ claimed: true })
  const next = [span(d!, "Fixing flaky tests"), span(ids[7]!, "Reviewing the fix")]
  expect((await poster(h)({ op: "record_spans", ...again, spans: next })).status).toBe(200)
  expect((await marks([d!, ids[7]!])).map(row => row.phase)).toEqual([stored("Fixing flaky tests", true, 4), stored("Reviewing the fix", false, 4)])
  // A closed span refuses to be rewritten, at its claim and at its record.
  const refused = await poster(h)({ op: "claim_spans", ...call(a!, 12) })
  expect([refused.status, await refused.json()]).toEqual([409, { code: "closed" }])
  await sql(sql => sql`INSERT INTO timeline_phase_claims (anchor_id, level, revision, person_id, owner) VALUES (${a!}, 1, ${call(a!, 12).revision}, ${actor.subject.id}, ${owner})`)
  const late = await poster(h)({ op: "record_spans", ...call(a!, 12), spans: [span(a!, "Rewritten")] })
  expect([late.status, await late.json()]).toEqual([409, { code: "closed" }])
  expect((await marks([a!]))[0]!.phase).toBe(stored("Researching issue", true, 3))
})

test("arcs keep their own column and read closed phases", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const ids = await exchanges(7)
  for (const id of ids) await sql(sql => sql`UPDATE messages SET phase = ${stored("Researching issue", true, 1)} WHERE id = ${id}`)
  const arc = call(ids[0]!, 6, 2)
  await poster(h)({ op: "claim_spans", ...arc })
  expect((await poster(h)({ op: "record_spans", ...arc, spans: [span(ids[0]!, "Issue work")] })).status).toBe(200)
  expect(await sql(sql => sql`SELECT arc FROM messages WHERE id = ${ids[0]!}`)).toEqual([{ arc: stored("Issue work", false, 6) }])
})

test("a span's refusals: bad spans, foreign or earlier messages, an unclaimed call, a released one, and the cap", async () => {
  const h = await harness(runtime, answers("Hi"), { actor: person("span-refused"), config: { TIMELINE_SUMMARY_DAILY_CAP: "1" } })
  const flow = await harness(runtime, answers("Hi"), { actor: { ...person("span-flow"), act: { kind: "flow", id: "run-5", chain: ["timeline/phases"] } } })
  const ids = await exchanges(5)
  const [a, b] = ids
  const key = call(a!)
  const good = [span(a!, "Fixing tests")]
  expect((await poster(h)({ op: "record_spans", ...key, spans: good })).status).toBe(409)
  expect((await poster(h)({ op: "claim_spans", ...key, revision: revision(10) })).status).toBe(400)
  expect((await poster(h)({ op: "claim_spans", ...call(b!) })).status).toBe(409)
  expect(await (await poster(h)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
  // The cap counts spans and summaries together.
  const capped = await poster(h)({ op: "claim", messageId: a!, revision: revision(10), reason: "answer" })
  expect(capped.status).toBe(429)
  for (const spans of [
    [], [{ id: a!, title: "Fixing" }], [span(b!, "Later first")], [span(a!, "Conversation")], [span(a!, "Fixing tests"), span(ids[4]!, "Past what it read")],
    [span(a!, "Fixing tests"), span(crypto.randomUUID(), "Gone")],
  ]) expect((await poster(h)({ op: "record_spans", ...key, spans })).status, JSON.stringify(spans).slice(0, 80)).toBe(400)
  expect((await poster(h)({ op: "record_spans", ...key, revision: revision(10), spans: good })).status).toBe(400)
  expect(await (await poster(h)({ op: "release_spans", messageId: a!, level: 1, revision: key.revision })).json()).toEqual({ released: true })
  expect((await poster(h)({ op: "record_spans", ...key, spans: good })).status).toBe(409)
  // The phases flow acts for its person; a released call can be claimed again.
  expect(await (await poster(flow)({ op: "claim_spans", ...key })).json()).toEqual({ claimed: true })
})

test("concurrent claims can't overspend the last of the cap", async () => {
  const h = await harness(runtime, answers("Hi"), { actor: person("race-capped"), config: { TIMELINE_SUMMARY_DAILY_CAP: "1" } })
  const made = await Promise.all(Array.from({ length: 6 }, () => exchange()))
  const answered = await Promise.all(made.map(({ answer }) => poster(h, crypto.randomUUID())({ op: "claim", messageId: answer, revision: revision(23), reason: "answer" })))
  expect(answered.map(one => one.status).sort()).toEqual([200, 429, 429, 429, 429, 429])
})

test("every attempt stays its person's and its day's, whoever takes the claim next", async () => {
  const first = "attempt-first", second = "attempt-second"
  const h = await harness(runtime, answers("Hi"), { actor: person(first) })
  const other = await harness(runtime, answers("Hi"), { actor: person(second) })
  const { answer } = await exchange()
  const claim = { op: "claim", messageId: answer, revision: revision(24), reason: "answer" }
  await poster(h)(claim)
  await sql(sql => sql`UPDATE timeline_attempts SET claimed_at = now() - interval '2 days' WHERE person_id = ${first}`)
  await poster(h)({ op: "release", messageId: answer, revision: revision(24) })
  await poster(other, rival)(claim)
  expect(await sql(sql => sql`
    SELECT person_id, kind, owner, claimed_at < now() - interval '1 day' AS old FROM timeline_attempts WHERE message_id = ${answer} ORDER BY id`)).toEqual([
    { person_id: first, kind: "summary", owner, old: true },
    { person_id: second, kind: "summary", owner: rival, old: false },
  ])
  // The attempts outlive their message.
  await sql(sql => sql`DELETE FROM messages WHERE id = ${answer}`)
  expect(await sql(sql => sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM timeline_attempts WHERE message_id = ${answer}`)).toEqual([{ n: 2 }])
})

test("the run that holds a claim resumes it for free after a crash, and nobody else's run does", async () => {
  const h = await harness(runtime, answers("Hi"), { actor: person("resuming"), config: { TIMELINE_SUMMARY_DAILY_CAP: "1" } })
  const { answer } = await exchange()
  const claim = { op: "claim", messageId: answer, revision: revision(25), reason: "answer" }
  expect(await (await poster(h)(claim)).json()).toEqual({ claimed: true })
  // At the cap, and back after a crash: the attempt is already paid for.
  expect(await (await poster(h)(claim)).json()).toEqual({ claimed: true })
  expect(h.line("timeline.summary.claim").at(-1)!.annotations).toMatchObject({ outcome: "resumed" })
  expect((await poster(h, rival)({ op: "record", messageId: answer, revision: revision(25), summary: "Stolen" })).status).toBe(409)
  await poster(h, rival)({ op: "release", messageId: answer, revision: revision(25) })
  expect((await poster(h)({ op: "record", messageId: answer, revision: revision(25), summary: "Retried twice" })).status).toBe(200)
  // A replay past the record resumes too, and records the same.
  expect(await (await poster(h)(claim)).json()).toEqual({ claimed: true })
  const key = await exchanges(4)
  expect(await sql(sql => sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM timeline_attempts WHERE person_id = 'resuming'`)).toEqual([{ n: 1 }])
  expect((await poster(h)({ op: "claim_spans", ...call(key[0]!) })).status).toBe(429)
  const line = h.line("timeline.summary.claim").at(-1)!.annotations
  expect(line).toMatchObject({ outcome: "capped" })
})

test("a phases claim is resumed the same way", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const ids = await exchanges(4)
  expect(await (await poster(h)({ op: "claim_spans", ...call(ids[0]!) })).json()).toEqual({ claimed: true })
  expect(await (await poster(h)({ op: "claim_spans", ...call(ids[0]!) })).json()).toEqual({ claimed: true })
  await poster(h, rival)({ op: "release_spans", messageId: ids[0]!, level: 1, revision: call(ids[0]!).revision })
  expect((await poster(h)({ op: "record_spans", ...call(ids[0]!), spans: [span(ids[0]!, "Fixing tests")] })).status).toBe(200)
})

test("a claim needs its owner", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const { answer } = await exchange()
  for (const bad of [undefined, "not-a-run"]) {
    const body = { op: "claim", messageId: answer, revision: revision(26), reason: "answer", owner: bad }
    expect((await h.fetch(TIMELINE_SUMMARIES_ROUTE, { method: "POST", body: JSON.stringify(body) })).status).toBe(400)
  }
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
