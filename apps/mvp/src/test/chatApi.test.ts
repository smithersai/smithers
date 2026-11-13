import { testChatDatabase } from "./chatApi"
import { ShapeSource } from "@smthrs/effect-electric"
import { DatabaseSync } from "node:sqlite"
import { Clock, Context, Effect, Layer, ManagedRuntime, Option } from "effect"
import { expect, test, vi } from "vitest"
import { Chat } from "../features/chat/chat"
import { asPerson, member, nodeDevice, openTab, openTestApi, TestChatApi } from "./chatApi"
import { FlowDispatch } from "../flows/dispatch"
import { SqlClient } from "effect/sql"
import { TEST_REPOSITORY } from "./chatApi"
import * as Conversations from "../../worker/branch/Conversations"

test("the shared deployment fixture seeds and routes its home on the scripted GitHub repository", async () => {
  const server = openTestApi()
  try {
    const api = await server.runPromise(Effect.service(TestChatApi))
    expect(await server.runPromise(Conversations.homeRepository)).toBe(`github/${TEST_REPOSITORY}`)
    const rows = await server.runPromise(Effect.flatMap(SqlClient.SqlClient, sql =>
      sql`SELECT repo_id FROM conversations`))
    expect(rows).toEqual([{ repo_id: `github/${TEST_REPOSITORY}` }])
    expect(api.github.scripted.owner + "/" + api.github.scripted.name).toBe(TEST_REPOSITORY)
    await server.runPromise(api.askElsewhere("A home conversation question"))
    expect(await server.runPromise(api.rows)).toContainEqual(expect.objectContaining({ text: "A home conversation question" }))
  } finally { await server.dispose() }
})

test("a server fixture opens no unused browser app", async () => {
  const server = openTestApi()
  try {
    const context = await server.runPromise(Effect.context())
    expect(Option.isNone(Context.getOption(context, Chat))).toBe(true)
    const api = await server.runPromise(Effect.service(TestChatApi))
    expect((await api.fetch(`${api.origin}/api/auth/session`)).status).toBe(200)
    expect(api.telemetry).toEqual([])
  } finally { await server.dispose() }
})

test("a tab's injected display clock leaves its real server available", async () => {
  const server = openTestApi()
  let tab: ReturnType<typeof openTab> | undefined
  try {
    const api = await server.runPromise(Effect.service(TestChatApi))
    const live = await server.runPromise(Clock.clockWith(Effect.succeed))
    let now = 1_000
    const clock: Clock.Clock = {
      ...live,
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      sleep: duration => live.sleep(duration),
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.sync(() => now),
      currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    }
    tab = openTab(api, { answers: false, clock })
    expect(await tab.runPromise(Clock.currentTimeMillis)).toBe(1_000)
    now = 5_001
    expect(await tab.runPromise(Clock.currentTimeMillis)).toBe(5_001)
    await tab.runPromise(Effect.sleep("1 millis"))
    expect((await api.fetch(`${api.origin}/api/auth/session`)).status).toBe(200)
  } finally {
    await tab?.dispose()
    await server.dispose()
  }
})

test("a device keeps its durable engine in real local SQLite and replays after a tab reload", async () => {
  const server = ManagedRuntime.make(TestChatApi.layer.pipe(Layer.provideMerge(testChatDatabase("local_engine"))))
  let tab: ReturnType<typeof openTab> | undefined
  try {
    const api = await server.runPromise(Effect.service(TestChatApi))
    const store = api.engineStore()
    const host = nodeDevice({ agent: { ...api, engineStore: () => store } })
    const executionId = crypto.randomUUID()
    const execute = () => tab!.runPromise(Effect.flatMap(FlowDispatch, flows =>
      flows.dispatch("app/theme/set", { mode: "dark" }, { executionId, door: "button" })))
    tab = openTab(api, { host })
    const first = await execute()
    expect(first._tag).toBe("Done")
    expect(typeof store.filename).toBe("string")
    await tab.dispose()
    tab = openTab(api, { host })
    expect(await execute()).toEqual(first)
    const database = new DatabaseSync(store.filename, { readOnly: true })
    try {
      expect(database.prepare("SELECT status FROM flows_runs WHERE run_id = ?").all(executionId))
        .toEqual([{ status: "completed" }])
      const journal = database.prepare("SELECT count(*) AS n FROM flows_journal_events WHERE run_id = ?").get(executionId) as { n: number }
      expect(journal.n).toBeGreaterThan(0)
    } finally { database.close() }
  } finally {
    await tab?.dispose()
    await server.dispose()
  }
})

// A scratch database is a separate deployment, including Electric's URL-keyed replay state. Simulated tabs also need separate cache keys because real
// tabs have separate JavaScript realms; no fixture or tab may inherit another realm's cursor or handle.
test("independent ChatApis and tabs sync independently, including a reopened API", async () => {
  const servers = [0, 1].map(() => ManagedRuntime.make(
    TestChatApi.layer.pipe(Layer.provideMerge(testChatDatabase("test_shape_isolation"))),
  ))
  const tabs: Array<{ dispose: () => Promise<void> }> = []
  const origins: Array<Set<string>> = []
  const namespaces: Array<string | undefined> = []
  const tabOn = (api: TestChatApi["Service"]) => {
    const seen = new Set<string>()
    origins.push(seen)
    const tab = openTab({ ...api, fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/api/shapes/messages") seen.add(url.origin)
      return api.fetch(input, init)
    } }, { answers: false })
    tabs.push(tab)
    return tab
  }
  try {
    const [first, second] = await Promise.all(servers.map((server) => server.runPromise(Effect.service(TestChatApi))))
    expect(first!.origin).toBe(second!.origin)
    for (const [index, api] of [first!, second!].entries()) {
      await servers[index]!.runPromise(api.askElsewhere(`fixture ${index}`))
      const tab = tabOn(api)
      namespaces.push((await tab.runPromise(Effect.service(ShapeSource.ShapeSource))).cacheNamespace)
      const chat = await tab.runPromise(Effect.service(Chat))
      chat.queries.conversation.startSyncImmediate()
      await vi.waitFor(() => expect(chat.queries.conversation.toArray.filter((row) => row.role === "user")
        .map((row) => row.text)).toEqual([`fixture ${index}`]), { timeout: 15_000 })
    }
    const reloaded = tabOn(first!)
    namespaces.push((await reloaded.runPromise(Effect.service(ShapeSource.ShapeSource))).cacheNamespace)
    const chat = await reloaded.runPromise(Effect.service(Chat))
    chat.queries.conversation.startSyncImmediate()
    await vi.waitFor(() => expect(chat.queries.conversation.toArray.filter((row) => row.role === "user")
      .map((row) => row.text)).toEqual(["fixture 0"]), { timeout: 15_000 })
    expect(origins.map((seen) => seen.size)).toEqual([1, 1, 1])
    expect(new Set(origins.flatMap((seen) => [...seen]))).toEqual(new Set([first!.origin]))
    expect(namespaces.every((namespace) => typeof namespace === "string")).toBe(true)
    expect(new Set(namespaces).size).toBe(3)
  } finally {
    for (const tab of tabs.reverse()) await tab.dispose()
    for (const server of servers.reverse()) await server.dispose()
  }
})

// The session endpoint and protected routes must read the same live authority, across tabs and reloads.
test("session reads follow a person's changed role without changing identity", async () => {
  const people = { reader: { ...member, role: "admin" as const } as typeof member }
  const server = ManagedRuntime.make(TestChatApi.layerWith({ people }).pipe(
    Layer.provideMerge(testChatDatabase("test_session_authority")),
  ))
  try {
    const api = asPerson(await server.runPromise(Effect.service(TestChatApi)), "reader")
    const session = async () => (await api.fetch(`${api.origin}/api/auth/session`)).json()
    expect(await session()).toMatchObject({ signedIn: true, personId: member.subject.id, role: "admin" })
    people.reader = { ...member, role: "member" }
    expect(await session()).toMatchObject({ signedIn: true, personId: member.subject.id, role: "member" })
    people.reader = { ...member, role: "guest" }
    expect(await session()).toMatchObject({ signedIn: true, personId: member.subject.id, role: "guest" })
  } finally {
    await server.dispose()
  }
})

test("answer diagnostics work before any lazy engine has initialized", async () => {
  const server = openTestApi()
  try {
    const api = await server.runPromise(Effect.service(TestChatApi))
    expect(await server.runPromise(api.answerDiagnostics(crypto.randomUUID())))
      .toEqual({ answer: null, report: null, engines: [] })
    const { answerId } = await server.runPromise(api.askElsewhere("A question without a device"))
    expect(await server.runPromise(api.answerDiagnostics(answerId)))
      .toEqual({ answer: { status: "streaming", failure: null }, report: null, engines: [] })
  } finally { await server.dispose() }
})

test("answer diagnostics retain a stalled local answer's run and journal without remote engines", async () => {
  const server = openTestApi()
  let tab: ReturnType<typeof openTab> | undefined
  try {
    const api = await server.runPromise(Effect.service(TestChatApi))
    tab = openTab(api, { host: nodeDevice({ agent: api }) })
    const chat = await tab.runPromise(Effect.service(Chat))
    const asked = await chat.actions.ask("Hold this answer for diagnostics")
    if (!asked.asked) throw new Error("not asked")
    const reply = await server.runPromise(api.answerTo("Hold this answer for diagnostics"))
    const diagnostics = await server.runPromise(api.answerDiagnostics(asked.answerId))
    expect(diagnostics.answer).toMatchObject({ status: "streaming", failure: null })
    expect(diagnostics.engines).toHaveLength(1)
    expect(diagnostics.engines[0]).toMatchObject({
      status: "running",
      attempts: expect.arrayContaining([expect.objectContaining({ state: expect.any(String), count: expect.any(Number) })]),
      records: expect.arrayContaining([expect.objectContaining({ type: expect.any(String), count: expect.any(Number) })]),
    })
    reply.say("Finished after inspection.")
    reply.done()
    await vi.waitFor(async () => {
      const completed = await server.runPromise(api.answerDiagnostics(asked.answerId))
      expect(completed.answer?.status).toBe("done")
      expect(completed.engines).toEqual([expect.objectContaining({ status: "completed" })])
    }, { timeout: 15_000 })
  } finally {
    await tab?.dispose()
    await server.dispose()
  }
})

test("answer diagnostics keep local evidence when an initialized remote store is unavailable", async () => {
  const server = openTestApi()
  let tab: ReturnType<typeof openTab> | undefined
  try {
    const api = await server.runPromise(Effect.service(TestChatApi))
    const runId = crypto.randomUUID()
    await server.runPromise(api.remote.run(Effect.flatMap(SqlClient.SqlClient, sql =>
      sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES (${runId}, 'pending', ${Date.now()}, ${JSON.stringify({ version: 1, flowName: "ops/SpendAlert", payload: {} })})`)))
    expect((await server.runPromise(api.answerDiagnostics(runId))).engines)
      .toEqual([expect.objectContaining({ status: "pending", attempts: [], records: [] })])
    tab = openTab(api, { host: nodeDevice({ agent: api }) })
    const result = await tab.runPromise(Effect.flatMap(FlowDispatch, flows =>
      flows.dispatch("app/theme/set", { mode: "dark" }, { executionId: runId, door: "button" })))
    expect(result._tag).toBe("Done")
    expect((await server.runPromise(api.answerDiagnostics(runId))).engines.map(engine => engine.status))
      .toEqual(["pending", "completed"])
    await server.runPromise(api.remote.run(Effect.flatMap(SqlClient.SqlClient, sql =>
      sql`ALTER TABLE flows_attempts RENAME TO unavailable_attempts`)))
    try {
      const partial = await server.runPromise(api.answerDiagnostics(runId))
      expect(partial).toMatchObject({ answer: null, report: null })
      expect(partial.engines).toEqual([expect.objectContaining({
        status: "completed",
        attempts: expect.arrayContaining([expect.objectContaining({ count: expect.any(Number) })]),
        records: expect.arrayContaining([expect.objectContaining({ count: expect.any(Number) })]),
      })])
    } finally {
      await server.runPromise(api.remote.run(Effect.flatMap(SqlClient.SqlClient, sql =>
        sql`ALTER TABLE unavailable_attempts RENAME TO flows_attempts`)))
    }
    expect((await server.runPromise(api.answerDiagnostics(runId))).engines.map(engine => engine.status))
      .toEqual(["pending", "completed"])
  } finally {
    await tab?.dispose()
    await server.dispose()
  }
})
