import { Effect, Layer, Option } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { Sessions } from "./Actor.ts"
import { BranchRoles } from "./branch/Access.ts"
import * as Pins from "./Pins.vibe"
import { answers, harness, testFile } from "./test/harness.ts"

const runtime = testFile("pins")
const actor = { subject: { kind: "person" as const, id: "pin-person" }, role: "member" as const }

test("a conflicting local question never pins the different message that occupies its UUID", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const id = crypto.randomUUID(), actualAnswer = crypto.randomUUID(), localAnswer = crypto.randomUUID()
  const conversationId = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql<{ id: string }>`SELECT id FROM conversations LIMIT 1`).pipe(Effect.map(rows => rows[0]!.id)))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO messages (id, role, text, status, conversation_id)
    VALUES (${id}, 'user', 'Different synced question', 'done', ${conversationId})`))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id)
    VALUES (${actualAnswer}, 'assistant', 'Answer', 'done', ${id}, ${conversationId})`))
  const post = (questionAnswerId: string) => h.fetch("/api/message-pin", { method: "POST", body: JSON.stringify({ conversationId, messageId: id, questionAnswerId, awaitAdmission: true, at: Date.now() }) })
  expect((await post(localAnswer)).status).toBe(425)
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT * FROM message_pins`))).toEqual([])
  expect((await post(actualAnswer)).status).toBe(200)
})

test("a local question waits for admission; a newer unpin settles its obsolete wait", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const messageId = crypto.randomUUID(), at = Date.now()
  const post = (body: unknown) => h.fetch("/api/message-pin", { method: "POST", body: JSON.stringify(body) })
  expect((await post({ messageId, at, awaitAdmission: true })).status).toBe(425)
  const unpinned = await post({ messageId: null, at: at + 1 })
  expect(unpinned.status).toBe(200)
  const saved = await unpinned.json() as { conversationId: string }
  expect(saved.conversationId).toMatch(/^[0-9a-f-]{36}$/)
  const obsolete = await post({ messageId, at, awaitAdmission: true })
  expect(obsolete.status).toBe(200)
  expect(await obsolete.json()).toMatchObject({ messageId: null, conversationId: saved.conversationId })
})

test("pin, replace and unpin are personal and stale retries cannot restore a pin", async () => {
  const h = await harness(runtime, answers("Hello"), { actor })
  const [first, second] = [crypto.randomUUID(), crypto.randomUUID()]
  const conversationId = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql<{id: string}>`SELECT id FROM conversations LIMIT 1`).pipe(Effect.map(rows => rows[0]!.id)))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${second}, 'user', 'My message', 'done', ${conversationId})`))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id) VALUES (${first}, 'assistant', 'Pinned answer', 'done', ${second}, ${conversationId})`))
  const post = (messageId: string | null, at: number, client = h) => client.fetch("/api/message-pin", { method: "POST", body: JSON.stringify({ conversationId, messageId, at }) })
  expect((await post(first, 1)).status).toBe(200)
  expect((await post(second, 2)).status).toBe(200)
  expect((await post(first, 1)).status).toBe(200)
  const rows = () => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT * FROM message_pins ORDER BY person_id`))
  expect(await rows()).toMatchObject([{ person_id: actor.subject.id, message_id: second }])
  const other = await harness(runtime, answers("Hi"), { actor: { ...actor, subject: { kind: "person", id: "second-person" } } })
  expect((await post(first, 3, other)).status).toBe(200)
  expect((await post(null, 4)).status).toBe(200)
  expect((await post(second, 2)).status).toBe(200)
  expect(await rows()).toMatchObject([{ person_id: actor.subject.id, message_id: null }, { person_id: "second-person", message_id: first }])
})

test("the route validates identity, method, bytes, timestamp, branch access, and message membership", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const post = (body: unknown, who = h) => who.fetch("/api/message-pin", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
  expect((await h.fetch("/api/message-pin")).status).toBe(405)
  const signedOut = await harness(runtime, answers("Hi"))
  expect((await post({}, signedOut)).status).toBe(401)
  for (const body of ["bad", "null", {}, { at: -1 }, { at: 1.1 }, { at: Date.now() + 172_800_000 }, { at: 1, messageId: "bad" }]) expect((await post(body)).status).toBe(400)
  expect((await post("a".repeat(513))).status).toBe(413)
  expect((await h.fetch("/api/message-pin", { method: "POST", body: new Uint8Array([255]) })).status).toBe(400)
  expect((await post({ at: 1, conversationId: crypto.randomUUID() })).status).toBe(404)
  expect((await post({ at: 1 })).status).toBe(404) // no completed answer
  expect((await post({ at: 1, messageId: crypto.randomUUID() })).status).toBe(404)
  const { tracked } = await import("./test/branch.ts")
  const privateBranch = await tracked(runtime, "github/octocat/spoon-knife", "private-pin", "open", "somebody-else")
  expect((await post({ at: 1, conversationId: privateBranch.conversationId, messageId: null })).status).toBe(403)
  expect(h.line("chat.pin").at(-1)!.annotations).toMatchObject({ status: 403, outcome: "refused" })
})

test("pin that resolves before the current agent answer, and refuses forged or unrelated targets", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const conversationId = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql<{id: string}>`SELECT id FROM conversations LIMIT 1`).pipe(Effect.map(rows => rows[0]!.id)))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO messages (id, role, text, status, asked_by, conversation_id) VALUES
    (${ids[0]}, 'user', 'First', 'done', ${actor.subject.id}, ${conversationId}), (${ids[2]}, 'user', 'Pin that', 'done', ${actor.subject.id}, ${conversationId})`))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id) VALUES
    (${ids[1]}, 'assistant', 'Previous', 'done', ${ids[0]}, ${conversationId}), (${ids[3]}, 'assistant', 'Pinning', 'streaming', ${ids[2]}, ${conversationId})`))
  const agent = await harness(runtime, answers("Hi"), { actor: { ...actor, act: { kind: "agent", id: ids[3]! } } })
  const post = (body: unknown, client = agent) => client.fetch("/api/message-pin", { method: "POST", body: JSON.stringify(body) })
  expect(await (await post({ at: 1, answerId: ids[3] })).json()).toMatchObject({ messageId: ids[1], conversationId })
  expect((await post({ at: 2, answerId: ids[1] })).status).toBe(403)
  expect((await post({ at: 2, answerId: ids[3], conversationId: crypto.randomUUID() })).status).toBe(403)
  expect((await post({ at: 2, answerId: crypto.randomUUID() }, h)).status).toBe(404)
  const stranger = await harness(runtime, answers("Hi"), { actor: { ...actor, subject: { kind: "person", id: "stranger" } } })
  expect((await post({ at: 2, answerId: ids[3] }, stranger)).status).toBe(403)
  expect(await (await post({ at: 3 }, h)).json()).toMatchObject({ messageId: ids[1], conversationId })
})

test("run binding comes from the credential even when answerId is omitted; agent stamps advance past clock skew", async () => {
  const h = await harness(runtime, answers("Hi"), { actor })
  const questionId = crypto.randomUUID(), answerId = crypto.randomUUID()
  const conversationId = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql<{id: string}>`SELECT id FROM conversations LIMIT 1`).pipe(Effect.map(rows => rows[0]!.id)))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO messages (id, role, text, status, asked_by, conversation_id)
    VALUES (${questionId}, 'user', 'A message', 'done', ${actor.subject.id}, ${conversationId})`))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id)
    VALUES (${answerId}, 'assistant', 'An answer', 'done', ${questionId}, ${conversationId})`))
  const { tracked } = await import("./test/branch.ts")
  const other = await tracked(runtime, "github/octocat/spoon-knife", "other-pin", "open", actor.subject.id)
  const agent = await harness(runtime, answers("Hi"), { actor: { ...actor, act: { kind: "flow", id: `${answerId}/call/1`, root: answerId } } })
  const post = (path: string, body: unknown, client = agent) => client.fetch(path, { method: "POST", body: JSON.stringify(body) })
  expect((await post("/api/message-pin", { conversationId: other.conversationId, messageId: null, at: 1 })).status).toBe(403)
  expect((await post("/api/message-pin", { messageId: questionId, at: 1 })).status).toBe(200)
  const future = Date.now() + 300_000
  expect((await post("/api/message-pin", { messageId: questionId, at: future }, h)).status).toBe(200)
  const stamped = await (await post("/api/message-pin/stamp", {})).json() as { at: number; conversationId: string }
  expect(stamped.at).toBe(future + 1)
  expect(stamped.conversationId).toBe(conversationId)
  expect((await post("/api/message-pin", { ...stamped, messageId: null })).status).toBe(200)
  const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT message_id FROM message_pins`))
  expect(row!.message_id).toBeNull()
  const noPin = await post("/api/message-pin/stamp", { conversationId: other.conversationId }, h)
  expect((await noPin.json() as { at: number }).at).toBeGreaterThan(0)
  const opaqueAgent = await harness(runtime, answers("Hi"), { actor: { ...actor, act: { kind: "agent", id: "opaque-agent" } } })
  expect((await post("/api/message-pin", { at: 1, messageId: null }, opaqueAgent)).status).toBe(403)
})

test("database failures are unavailable, and an absent home conversation is not found", async () => {
  const Database = await import("../db/Database.ts")
  const { Redacted } = await import("effect")
  const bad = await harness(runtime, answers("Hi"), { actor, database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))) })
  expect((await bad.fetch("/api/message-pin", { method: "POST", body: JSON.stringify({ at: 1, messageId: null }) })).status).toBe(503)
  const noHome = await harness(runtime, answers("Hi"), { actor, config: { GITHUB_REPOSITORY: "missing/home" } })
  expect((await noHome.fetch("/api/message-pin", { method: "POST", body: JSON.stringify({ at: 1, messageId: null }) })).status).toBe(404)
})

test("the Electric shape ignores forged filters and syncs only the session person's rows", async () => {
  const { Scratch } = await import("../db/TestDatabase.ts")
  const scratch = await runtime.runPromise(Effect.service(Scratch))
  const conversationId = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql<{id: string}>`SELECT id FROM conversations LIMIT 1`).pipe(Effect.map(rows => rows[0]!.id)))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO message_pins (conversation_id, person_id, message_id, changed_at) VALUES
    (${conversationId}, ${actor.subject.id}, NULL, now()), (${conversationId}, 'another-person', NULL, now())`))
  const requests: Array<URL> = []
  const electric: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    requests.push(new URL(url))
    url.searchParams.set("table", `${scratch.name}.message_pins`)
    return fetch(url, init)
  }
  for (const person of [actor, undefined]) {
    const h = await harness(runtime, answers("Hi"), { ...(person === undefined ? {} : { actor: person }), fetch: electric })
    const response = await h.fetch("/api/shapes/message-pins?offset=-1&table=messages&where=true&columns=text")
    expect(response.status).toBe(200)
    const values = (await response.json() as Array<{ value?: { person_id: string } }>).flatMap(r => r.value ? [r.value] : [])
    expect(values.map(r => r.person_id)).toEqual(person === undefined ? [] : [actor.subject.id])
    expect(requests.at(-1)!.searchParams.get("where")).toBe("person_id = $1")
    expect(requests.at(-1)!.searchParams.get("params[1]")).toBe(person?.subject.id ?? "")
    expect(requests.at(-1)!.searchParams.get("columns")).toBe("conversation_id,person_id,message_id,changed_at")
  }
})

test("the message-pin handler rejects oversized bodies before writing", async () => {
  const database = Layer.effect(SqlClient.SqlClient, Effect.die("body validation should precede SQL"))
  const routes = await runtime.runPromise(Pins.make(database))
  const request = HttpServerRequest.fromWeb(new Request("http://chat.test/api/message-pin", {
    method: "POST",
    body: "x".repeat(512 + 1),
  }))
  const response = await runtime.runPromise(routes.write.pipe(
    Effect.provideService(BranchRoles, { roleOn: () => Effect.die("body validation should precede branch access") }),
    Effect.provideService(Sessions, { resolve: Effect.succeed(Option.some(actor)) }),
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
  ))
  expect(response.status).toBe(413)
})
