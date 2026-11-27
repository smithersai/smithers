import { ConfigProvider, Effect, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as TimelineSummaries from "./TimelineSummaries.vibe"
import { TIMELINE_SUMMARIES_ROUTE } from "../src/features/timeline/contract.ts"
import { revisionOf, segmentRevision } from "../src/features/timeline/identity.ts"
import { answers, branchRoles, eventually, harness, signedIn, testFile } from "./test/harness.ts"
import { branchOf, shardHost } from "../src/test/messagesShardHost.ts"
import { ShardProtocol } from "@smthrs/sync"
import { shardOf } from "./chat/MessagesShard.ts"
import { MessagesShardBridge } from "./chat/MessagesShardBridge.ts"
import * as MessagesShardRoutes from "./chat/MessagesShardRoutes.ts"
import * as MessagesShardSource from "./chat/MessagesShardSource.ts"

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

/** The same full-content identity the timeline sends for this stored message. */
const currentRevision = async (messageId: string) => {
  const [row] = await sql(sql => sql<{ readonly id: string; readonly role: string; readonly text: string }>`SELECT id, role, text FROM messages WHERE id = ${messageId}`)
  return revisionOf(row!)
}
const summaryRow = (messageId: string) =>
  sql(sql => sql`SELECT summary, summary_revision AS revision FROM messages WHERE id = ${messageId}`)

test("recorded summaries acknowledge replays without replacing their text or a newer revision", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const { answer } = await exchange()
  const first = { messageId: answer, revision: await currentRevision(answer) }
  const post = poster(h)
  await post({ op: "claim", ...first, reason: "answer" })
  expect((await post({ op: "record", ...first, summary: "First answer" })).status).toBe(200)
  const before = await sql(sql => sql`SELECT recorded_at FROM timeline_summaries WHERE message_id = ${answer}`)
  expect((await post({ op: "record", ...first, summary: "Changed replay" })).status).toBe(200)
  expect(await summaryRow(answer)).toEqual([{ summary: "First answer", revision: first.revision }])
  await sql(sql => sql`UPDATE messages SET text = 'The answer changed.' WHERE id = ${answer}`)
  const next = { messageId: answer, revision: await currentRevision(answer) }
  await post({ op: "claim", ...next, reason: "answer" })
  expect((await post({ op: "record", ...next, summary: "New answer" })).status).toBe(200)
  const replay = await post({ op: "record", ...first, summary: "First answer" })
  expect([replay.status, await replay.json()]).toEqual([200, { recorded: true }])
  expect(await summaryRow(answer)).toEqual([{ summary: "New answer", revision: next.revision }])
  expect(await sql(sql => sql`SELECT recorded_at FROM timeline_summaries WHERE message_id = ${answer} AND revision = ${first.revision}`)).toEqual(before)
})

test("a late first record refuses changed content without consuming its claim", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const { answer } = await exchange()
  const key = { messageId: answer, revision: await currentRevision(answer) }
  await poster(h)({ op: "claim", ...key, reason: "answer" })
  await sql(sql => sql`UPDATE messages SET text = 'A newer answer.' WHERE id = ${answer}`)
  const response = await poster(h)({ op: "record", ...key, summary: "Old answer" })
  expect([response.status, await response.json()]).toEqual([409, { code: "stale" }])
  expect(await summaryRow(answer)).toEqual([{ summary: null, revision: null }])
  expect(await sql(sql => sql`SELECT recorded_at FROM timeline_summaries WHERE message_id = ${answer}`)).toEqual([{ recorded_at: null }])
  expect(h.line("timeline.summary.claim").at(-1)!.annotations).toMatchObject({ status: 409, outcome: "stale" })
})

test.each([false, true])("recording is serialized with other records and content edits (edit: %s)", async edit => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const { answer } = await exchange()
  const key = { messageId: answer, revision: await currentRevision(answer) }
  await poster(h)({ op: "claim", ...key, reason: "answer" })
  const release = resolvers(), holding = resolvers()
  let pid = 0
  const held = sql(sql => sql.withTransaction(Effect.gen(function* () {
    const [backend] = yield* sql<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`
    pid = backend!.pid
    yield* sql`SELECT id FROM messages WHERE id = ${answer} FOR UPDATE`
    if (edit) yield* sql`UPDATE messages SET text = 'Changed while recording.' WHERE id = ${answer}`
    yield* Effect.sync(holding.resolve)
    yield* Effect.promise(() => release.promise)
  })))
  await holding.promise
  const responses: Array<Promise<Response>> = []
  // Count real lock waiters, including a second recorder queued behind the first.
  const waitFor = (count: number) => eventually(async () => {
    const [row] = await sql(sql => sql<{ readonly n: number }>`
      WITH RECURSIVE waiting AS (
        SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
      ) SELECT count(*)::int AS n FROM waiting`)
    return row!.n >= count
  }, 10_000)
  try {
    responses.push(poster(h)({ op: "record", ...key, summary: "First recorder" }))
    await waitFor(1)
    if (!edit) {
      responses.push(poster(h)({ op: "record", ...key, summary: "Second recorder" }))
      await waitFor(2)
    }
  } finally {
    release.resolve()
    await held
  }
  for (const response of await Promise.all(responses)) {
    expect([response.status, await response.json()]).toEqual(edit
      ? [409, { code: "stale" }]
      : [200, { recorded: true }])
  }
  expect(await summaryRow(answer)).toEqual(edit
    ? [{ summary: null, revision: null }]
    : [{ summary: "First recorder", revision: key.revision }])
})

test("an unreadable summary body is refused before it can claim or record anything", async () => {
  const { database } = await runtime.runPromise(TestDatabase.Scratch)
  const { write } = await runtime.runPromise(TimelineSummaries.make(database))
  // Exercise the handler's own body guard, before a host's admission middleware.
  const handle = HttpEffect.toWebHandler(write.pipe(
    Effect.provide(signedIn(actor)),
    Effect.provide(branchRoles(database)),
  ))
  const response = await handle(new Request(`http://chat.test${TIMELINE_SUMMARIES_ROUTE}`, {
    method: "POST", body: new Uint8Array([0xff]),
  }))
  expect([response.status, await response.json()]).toEqual([400, { code: "invalid_request" }])
  expect(await sql(sql => sql`SELECT message_id FROM timeline_summaries`)).toEqual([])
})

test("the first claim of an answer's revision takes it for every tab, device and person; its summary lands on the message", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const other = await harness(runtime, answers("Hi"), { actor: person("summary-other") })
  const { answer } = await exchange()
  const rev = await currentRevision(answer)
  const claim = { op: "claim", messageId: answer, revision: rev, reason: "long_answer" }
  const first = await poster(h)(claim)
  expect([first.status, await first.json()]).toEqual([200, { claimed: true }])
  // The same person's other tab, and another person, are told it is taken.
  for (const who of [poster(h, rival), poster(other, rival)]) expect(await (await who(claim)).json()).toEqual({ claimed: false })
  // Only the claimant records it, onto the message every device syncs.
  expect((await poster(other)({ op: "record", messageId: answer, revision: rev, summary: "Retry kept both attempts" })).status).toBe(409)
  const recorded = await poster(h)({ op: "record", messageId: answer.toUpperCase(), revision: rev, summary: "Retry kept both attempts" })
  expect([recorded.status, await recorded.json()]).toEqual([200, { recorded: true }])
  // Recording again (a replay) writes the same summary.
  expect((await poster(h)({ op: "record", messageId: answer, revision: rev, summary: "Retry kept both attempts" })).status).toBe(200)
  expect(await sql(sql => sql`SELECT summary, summary_revision AS revision FROM messages WHERE id = ${answer}`))
    .toEqual([{ summary: "Retry kept both attempts", revision: rev }])
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
  const rev = await currentRevision(question)
  expect(await (await poster(h)({ op: "claim", messageId: question, revision: rev, reason: "question" })).json()).toEqual({ claimed: true })
  expect((await poster(h)({ op: "record", messageId: question, revision: rev, summary: "Check the retry" })).status).toBe(200)
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
  const rev = await currentRevision(answer)
  const key = { messageId: answer, revision: rev }
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
  expect((await poster(h)({ op: "claim", messageId: next.answer, revision: rev, reason: "answer" })).status).toBe(429)
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
  await Effect.runPromise(Effect.sleep(300))
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
  const rev = await currentRevision(answer)
  const claim = { op: "claim", messageId: answer, revision: rev, reason: "answer" }
  expect(await (await poster(h)(claim)).json()).toEqual({ claimed: true })
  // At the cap, and back after a crash: the attempt is already paid for.
  expect(await (await poster(h)(claim)).json()).toEqual({ claimed: true })
  expect(h.line("timeline.summary.claim").at(-1)!.annotations).toMatchObject({ outcome: "resumed" })
  expect((await poster(h, rival)({ op: "record", messageId: answer, revision: rev, summary: "Stolen" })).status).toBe(409)
  await poster(h, rival)({ op: "release", messageId: answer, revision: rev })
  expect((await poster(h)({ op: "record", messageId: answer, revision: rev, summary: "Retried twice" })).status).toBe(200)
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

/** The conversation a message is in. */
const conversationOf = (messageId: string) =>
  sql(sql => sql<{ readonly conversationId: string }>`SELECT conversation_id AS "conversationId" FROM messages WHERE id = ${messageId}`)
    .then(rows => rows[0]!.conversationId)

test("a recorded summary also reaches the conversation's shard, after Postgres commits it, and a replay adds nothing", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const host = yield* shardHost()
    const h = yield* Effect.promise(() => harness(runtime, answers("Hi"), { actor, messagesShard: MessagesShardBridge.make(host.forward) }))
    const post = poster(h)
    const { question, answer } = yield* Effect.promise(() => exchange())
    const conversationId = yield* Effect.promise(() => conversationOf(answer))
    // The pair as an answer brings it to the shard (worker/attach/LiveMount.ts): the notes below are written on it.
    yield* MessagesShardSource.answered(question).pipe(
      Effect.provideService(MessagesShardBridge, MessagesShardBridge.make(host.forward)),
      (bridged) => Effect.promise(() => runtime.runPromise(bridged)),
    )
    // "" is a mark the message lacks, as no mark at all is.
    const noted = () => Effect.map(host.state(conversationId), ({ chat }) =>
      chat.messages.map(message => [message.id, message.summary, message.summaryRevision, message.phase || undefined]))
    expect(yield* noted()).toEqual([[question, undefined, undefined, undefined], [answer, undefined, undefined, undefined]])
    const head = () => Effect.map(host.head(conversationId), at => at.seq)
    const before = yield* head()

    // A summary: nothing reaches the shard on a claim, or on a record Postgres refuses; one entry once it commits.
    const key = { messageId: answer, revision: yield* Effect.promise(() => currentRevision(answer)) }
    yield* Effect.promise(() => post({ op: "claim", ...key, reason: "answer" }))
    expect((yield* Effect.promise(() => post({ op: "record", ...key, revision: revision(9), summary: "Unclaimed" }))).status).toBe(409)
    expect(yield* head()).toBe(before)
    expect((yield* Effect.promise(() => post({ op: "record", ...key, summary: "Retried twice" }))).status).toBe(200)
    expect(yield* noted()).toEqual([[question, undefined, undefined, undefined], [answer, "Retried twice", key.revision, undefined]])
    expect(yield* head()).toBe(before + 1)
    // A replay is acknowledged, and is its key's receipt in the shard.
    expect((yield* Effect.promise(() => post({ op: "record", ...key, summary: "Changed replay" }))).status).toBe(200)
    expect(yield* noted()).toEqual([[question, undefined, undefined, undefined], [answer, "Retried twice", key.revision, undefined]])
    expect(yield* head()).toBe(before + 1)
    expect(h.line("chat.shard.bridge")).toEqual([])
  }))))

test("a recorded segmentation's marks reach the shard as Postgres holds them, and so does the next one's rewrite", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    const h = yield* Effect.promise(() => harness(runtime, answers("Hi"), { actor, messagesShard: bridge }))
    const ids = yield* Effect.promise(() => exchanges(9))
    const conversationId = yield* Effect.promise(() => conversationOf(ids[0]!))
    const bring = (questions: ReadonlyArray<string>) =>
      Effect.promise(() => runtime.runPromise(Effect.forEach(questions, MessagesShardSource.answered, { discard: true }).pipe(
        Effect.provideService(MessagesShardBridge, bridge),
      )))
    yield* bring(ids)
    /** Each question's phase, in Postgres and in the shard: `null` and `undefined` or `""` are both no mark. */
    const phases = (of: ReadonlyArray<string>) => Effect.gen(function* () {
      const inPostgres = (yield* Effect.promise(() => marks(of))).map(row => row.phase)
      const { chat } = yield* host.state(conversationId)
      const inShard = of.map(id => chat.messages.find(message => message.id === id)!.phase || null)
      return { inPostgres, inShard }
    })
    const first = call(ids[0]!, 8)
    yield* Effect.promise(() => poster(h)({ op: "claim_spans", ...first }))
    const before = (yield* host.head(conversationId)).seq
    expect((yield* Effect.promise(() => poster(h)({ op: "record_spans", ...first, spans: [span(ids[0]!, "Researching issue"), span(ids[4]!, "Fixing tests")] }))).status).toBe(200)
    const marked = yield* phases(ids)
    expect(marked.inShard).toEqual(marked.inPostgres)
    expect(marked.inShard.map(phase => phase === null ? null : (JSON.parse(phase) as { readonly title: string }).title))
      .toEqual(["Researching issue", null, null, null, "Fixing tests", null, null, null, null])
    // One entry per marked message, and none for a replay: it bridges the messages its record marked again, each the
    // same notes under the same version, which is its key's receipt.
    expect((yield* host.head(conversationId)).seq).toBe(before + 2)
    expect((yield* Effect.promise(() => poster(h)({ op: "record_spans", ...first, spans: [span(ids[0]!, "Rewritten")] }))).status).toBe(200)
    expect((yield* host.head(conversationId)).seq).toBe(before + 2)

    // More of the conversation, and the next segmentation from the open phase: its mark is taken away and written
    // again, closed, and a new one starts. The shard follows both.
    const more: Array<string> = []
    for (let n = 0; n < 4; n++) more.push((yield* Effect.promise(() => exchange("done", conversationId))).question)
    yield* bring(more)
    const next = call(ids[4]!, 9)
    yield* Effect.promise(() => poster(h)({ op: "claim_spans", ...next }))
    const rewritten = yield* Effect.promise(() => poster(h)({ op: "record_spans", ...next, spans: [span(ids[4]!, "Fixing tests"), span(ids[8]!, "Shipping")] }))
    expect(rewritten.status).toBe(200)
    const after = yield* phases([...ids, ...more])
    expect(after.inShard).toEqual(after.inPostgres)
    expect(after.inShard.filter(phase => phase !== null).map(phase => JSON.parse(phase!) as { readonly title: string; readonly closed: boolean }).map(mark => [mark.title, mark.closed]))
      .toEqual([["Researching issue", true], ["Fixing tests", true], ["Shipping", false]])
    expect(h.line("chat.shard.bridge")).toEqual([])
  }))), 30_000)

test("a summary recorded before its message reached the shard brings the message with it", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const host = yield* shardHost()
    const h = yield* Effect.promise(() => harness(runtime, answers("Hi"), { actor, messagesShard: MessagesShardBridge.make(host.forward) }))
    const post = poster(h)
    // An exchange no bridge ever told the shard of: asked before the bridge, or its bridge was lost.
    const { question, answer } = yield* Effect.promise(() => exchange())
    const conversationId = yield* Effect.promise(() => conversationOf(answer))
    expect((yield* host.head(conversationId)).seq).toBe(0)
    const key = { messageId: answer, revision: yield* Effect.promise(() => currentRevision(answer)) }
    yield* Effect.promise(() => post({ op: "claim", ...key, reason: "answer" }))
    expect((yield* Effect.promise(() => post({ op: "record", ...key, summary: "Retried twice" }))).status).toBe(200)
    // The note was never refused for a message the shard lacked: the pair landed first, as Postgres holds it.
    expect((yield* host.state(conversationId)).chat.messages.map(message => [message.id, message.status, message.summary, message.noteVersion])).toEqual([
      [question, "posted", undefined, undefined],
      [answer, "complete", "Retried twice", 1],
    ])
    expect(h.line("chat.shard.bridge")).toEqual([])
  }))))

test("a segmentation whose bridge was lost stays owed, and the next read of the shard delivers it: nobody records it again", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const host = yield* shardHost()
    // The Worker cannot reach the conversation's object for a while: every write to it fails on the way.
    let down = false
    let target = host
    const bridge = MessagesShardBridge.make((shard, request) => down ? Effect.fail("unreachable") : target.forward(shard, request))
    const h = yield* Effect.promise(() => harness(runtime, answers("Hi"), { actor, messagesShard: bridge }))
    const ids = yield* Effect.promise(() => exchanges(9))
    const conversationId = yield* Effect.promise(() => conversationOf(ids[0]!))
    yield* Effect.promise(() => runtime.runPromise(Effect.forEach(ids, MessagesShardSource.answered, { discard: true }).pipe(
      Effect.provideService(MessagesShardBridge, bridge),
    )))
    const inShard = (column: "phase" | "arc" = "phase") => Effect.map(target.state(conversationId), ({ chat }) =>
      ids.map(id => chat.messages.find(message => message.id === id)?.[column] || null))
    const owed = () => Effect.promise(() => sql(sql => sql<{ readonly id: string }>`
      SELECT message_id AS id FROM messages_shard_pending WHERE conversation_id = ${conversationId} ORDER BY enqueued_at, message_id`))
    /** A reader's Pull of the conversation's shard, through ChatApi's route, which sends what the shard is owed first. */
    const pull = () => Effect.promise(() => runtime.runPromise(
      MessagesShardRoutes.dispatch(
        (shard, request) => down ? Effect.fail("unreachable") : target.forward(shard, request),
        (_, id) => Effect.succeed(branchOf(id, { access: "view" })),
        undefined,
        (id) => MessagesShardSource.drain(id).pipe(Effect.provideService(MessagesShardBridge, bridge)),
      ).pipe(
        Effect.provide(signedIn(person("a-reader"))),
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
          `https://smithers.example/api/conversations/${conversationId}/messages/pull?${ShardProtocol.pullQuery({ version: 2, shard: shardOf(conversationId), epoch: 0, after: 0, limit: 256 })}`,
        ))),
        Effect.flatMap((response) => Effect.promise(async () => ({ status: response.status, body: await HttpServerResponse.toWeb(response).text() }))),
      ),
    ))
    const first = call(ids[0]!, 8)
    const record = () => poster(h)({ op: "record_spans", ...first, spans: [span(ids[0]!, "Researching issue"), span(ids[4]!, "Fixing tests")] })
    yield* Effect.promise(() => poster(h)({ op: "claim_spans", ...first }))
    down = true
    // The record is answered as recorded: Postgres has it. Its caller's step is done, and is never run again.
    expect((yield* Effect.promise(record)).status).toBe(200)
    // Postgres committed the marks, what they were written on, and that the shard is owed each; the shard heard nothing.
    const inPostgres = (yield* Effect.promise(() => marks(ids))).map(row => row.phase)
    expect(inPostgres.filter(phase => phase !== null)).toHaveLength(2)
    expect(yield* inShard()).toEqual(ids.map(() => null))
    expect(yield* Effect.promise(() => sql(sql => sql<{ readonly marked: ReadonlyArray<string> }>`
      SELECT marked FROM timeline_phase_claims WHERE anchor_id = ${ids[0]!} AND revision = ${first.revision}`)))
      .toEqual([{ marked: [ids[0]!, ids[4]!] }])
    expect((yield* owed()).map(row => row.id).sort()).toEqual([ids[0]!, ids[4]!].sort())
    const said = () => h.line("chat.shard.bridge").map((line) => {
      const { span_id: _, trace_id: __, ...annotations } = line.annotations as Record<string, unknown>
      return annotations
    })
    expect(said()).toEqual([
      // Each note's exchange is replayed first, and the object cannot be reached: no note is sent.
      { write: "replayed", conversationId, outcome: "unavailable", reason: "unreachable" },
      { write: "replayed", conversationId, outcome: "unavailable", reason: "unreachable" },
      { write: "noted", outcome: "pending", pending: 2 },
    ])
    // A reader asks while the object is still down: the read fails as the object does, and the notes stay owed.
    expect((yield* pull()).status).toBe(503)
    expect((yield* owed())).toHaveLength(2)
    // A note that committed in a request that died before it sent anything: only the row and what it owes exist, as
    // a crash between the commit and the send leaves them, or a Worker deployed before the bridge wrote it.
    const arc = JSON.stringify({ title: "Shipping", summary: "The crash.", closed: false, covered: 1 })
    yield* Effect.promise(() => sql(sql => sql`UPDATE messages SET arc = ${arc} WHERE id = ${ids[2]!}`))
    expect((yield* owed())).toHaveLength(3)
    // The object wakes again, having lost nothing it held. Nobody records anything again: the next reader's Pull
    // sends the shard what it is owed before it is answered, so that very read already carries the notes.
    yield* host.restart
    down = false
    const read = yield* pull()
    expect(read.status).toBe(200)
    expect(read.body).toContain("Researching issue")
    expect(read.body).toContain("Fixing tests")
    expect(read.body).toContain("The crash.")
    expect(yield* inShard()).toEqual(inPostgres)
    expect(yield* inShard("arc")).toEqual(ids.map(id => id === ids[2] ? arc : null))
    expect(yield* owed()).toEqual([])
    // A second read sends nothing more, and the record's replay adds nothing and takes nothing back.
    const head = (yield* host.head(conversationId)).seq
    expect((yield* pull()).status).toBe(200)
    expect((yield* Effect.promise(record)).status).toBe(200)
    expect((yield* host.head(conversationId)).seq).toBe(head)
    expect(yield* owed()).toEqual([])
    // A claim that marked nothing owes nothing.
    yield* Effect.promise(() => sql(sql => sql`UPDATE timeline_phase_claims SET marked = '[]'::jsonb WHERE anchor_id = ${ids[0]!}`))
    expect((yield* Effect.promise(record)).status).toBe(200)
    expect((yield* host.head(conversationId)).seq).toBe(head)

    // A claim recorded before the marked messages were kept names none. Its replay is reconciled with what Postgres
    // holds: every message of the conversation that carries a note is owed to the shard, whichever write noted it.
    // Here the conversation's shard is one that never held any of it, so everything it is given comes from Postgres:
    // each noted message with the exchange it belongs to, and nothing else.
    yield* Effect.promise(() => sql(sql => sql`UPDATE timeline_phase_claims SET marked = NULL WHERE anchor_id = ${ids[0]!}`))
    target = yield* shardHost()
    expect((yield* target.head(conversationId)).seq).toBe(0)
    expect((yield* Effect.promise(record)).status).toBe(200)
    expect(yield* inShard()).toEqual(inPostgres)
    expect(yield* inShard("arc")).toEqual(ids.map(id => id === ids[2] ? arc : null))
    expect((yield* target.state(conversationId)).chat.messages.filter(message => message.role === "user").map(message => message.id))
      .toEqual([ids[0]!, ids[2]!, ids[4]!])
    expect(yield* owed()).toEqual([])
    // The claim keeps what it was reconciled with, in the conversation's order, so its next replay names them.
    expect(yield* Effect.promise(() => sql(sql => sql<{ readonly marked: ReadonlyArray<string> }>`
      SELECT marked FROM timeline_phase_claims WHERE anchor_id = ${ids[0]!} AND revision = ${first.revision}`)))
      .toEqual([{ marked: [ids[0]!, ids[2]!, ids[4]!] }])
  }))), 30_000)
