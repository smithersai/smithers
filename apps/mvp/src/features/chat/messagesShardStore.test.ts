import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Metric, Option } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, expect, test, vi } from "vitest"
import { shaOf } from "../../../worker/test/branch"
import { DEVICE_PRINCIPAL, member, type NodeDevice, nodeDevice, openTab, openTestApp, type TabOptions, TestChatApi } from "../../test/chatApi"
import { boundFetch } from "../../device/identity.vibe"
import { ada, ownerIn } from "../../test/messagesShardHost"
import { failWrites, fillStorage } from "../../test/writeFailure"
import { AuthStore } from "../auth/store.vibe"
import { SESSION_ROUTE } from "../auth/contract"
import { Branch } from "../branch/branch.vibe"
import { BranchStore } from "../branch/store.vibe"
import { retry } from "./actions"
import { Chat } from "./chat"
import { QUESTIONS_ROUTE, SHAPE_ROUTE } from "./contract"
import { readDenials } from "./messagesShardClient"
import { CONNECTION, HISTORY, type Message, PLACE } from "./schema"
import { ChatStore } from "./store"
import { StatusStore } from "../status/store"
import { ViewsStore } from "../views/store"
import { ConversationOwners } from "../conversations/owners"
import * as Marks from "../conversations/marks"

// Chat's store reading a branch conversation from its messages shard (`ChatConfig.shard`, decision 0170 slices 5a and
// 5b), end to end with nothing replaced: a tab asks through ChatApi's real handler, Postgres stores the question,
// ChatApi's bridge sequences it into the conversation's real shard over SQLite, and the tab reads it back through
// ChatApi's real shard route as the row its pages show, column for column what Postgres holds. No tab asks Electric for
// any conversation's messages. Faults are the network's, injected at the tab's `fetch`.

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const quick: TabOptions = {
  unreachableAfter: "300 millis",
  confirmWithin: "5 seconds",
  shard: { follow: "20 millis", within: "2 seconds" },
}
/** A tab whose branch conversations are read from their shards, asked every 20 milliseconds. */
const fromShard: TabOptions = { ...quick, shard: { follow: "20 millis", within: "2 seconds" } }

const until = (assertion: () => void | Promise<void>, timeout = 20_000) =>
  vi.waitFor(assertion, { timeout, interval: 20 })

/** A ChatApi that serves the messages shards and bridges its own writes into them, with two branches to open. */
const openApi = async () => {
  const runtime = openTestApp({ answers: false })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), feature: shaOf("feature"), other: shaOf("other") },
  })
  return api
}

/**
 * What the network does to a tab's request, by its path: `offline` never leaves the device; `stall` is never answered,
 * until the tab gives it up; a status answers it.
 */
type Fault = (path: string) => "offline" | "stall" | number | undefined

/**
 * A tab on `device`, with every request it makes recorded and, while `net.fault` says so, failed: from its first
 * request with `fault`. `page` is the page's own transport around that network, as main.tsx puts `boundFetch` around
 * the browser's `fetch`.
 */
const openOn = async (
  api: TestChatApi["Service"],
  device: NodeDevice,
  options: TabOptions,
  fault: Fault = () => undefined,
  page: (network: typeof globalThis.fetch) => typeof globalThis.fetch = (network) => network,
) => {
  const requests: Array<string> = []
  const net: { fault: Fault } = { fault }
  const transport = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => page(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}${url.search}`)
    const fault = net.fault(url.pathname)
    if (fault === "offline") throw new TypeError("fetch failed")
    if (fault === "stall") {
      return new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)))
    }
    return fault === undefined ? fetch(request) : new Response(null, { status: fault })
  })
  const runtime = openTab(api, { ...options, host: device, transport })
  runtimes.push(runtime)
  const { queries, actions } = await runtime.runPromise(Effect.service(Chat))
  const store = await runtime.runPromise(Effect.service(ChatStore))
  if (fault(SESSION_ROUTE) === undefined) await runtime.runPromise(store.messages.whole)
  for (const query of [store.shown, store.queued, store.composerState, store.connectionState, store.historyState]) {
    query.tanstack.startSyncImmediate()
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => runtime.runPromise(effect as never) as Promise<A>
  /** Shows branch `name` of `octo/hello`, as its route does, and answers its conversation's id. */
  const show = async (name: string) => {
    const branch = await run(Effect.service(Branch))
    await branch.actions.open("octo", "hello", name)
    return Option.getOrThrow(await run(store.place.get(PLACE))).conversationId!
  }
  /** Conversation `conversationId` as a person reads it on this tab, through the data gate: role, status and text. */
  const shown = async (conversationId: string) =>
    (await run(store.opened(conversationId)!.conversation.toArray)).map(({ role, status, text }) => `${role} ${status} ${text}`)
  /** The conversation's synced rows as its collection holds them, in Postgres's order, without TanStack DB's `$` fields. */
  const rows = async (conversationId: string) =>
    [...await run(store.opened(conversationId)!.messages.toArray)]
      .sort((left, right) => left.position - right.position)
      .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$"))) as unknown as Message)
  /** The questions of conversation `conversationId` this device holds and Postgres does not yet, as the page shows them. */
  const queued = async (conversationId: string) =>
    (await run(store.opened(conversationId)!.conversation.toArray)).filter((row) => row.status === "queued").map((row) => row.text)
  return {
    queries, actions, store, run, show, shown, rows, queued, requests, net,
    connection: () => queries.connection.toArray.find((row) => row.id === CONNECTION)!,
    close: async () => {
      runtimes.splice(runtimes.indexOf(runtime), 1)
      await runtime.dispose()
    },
  }
}

/** The requests for a conversation's messages: Electric's shape of them, which no tab sends, and its shard. */
const shapeOf = (requests: ReadonlyArray<string>) => requests.filter((request) => request.includes(SHAPE_ROUTE))
const shardOf = (requests: ReadonlyArray<string>, conversationId: string) =>
  requests.filter((request) => request.includes(`/api/conversations/${conversationId}/messages/`))

/** Asks `text` in the conversation the tab shows and has the attached agent answer it. */
const exchange = async (api: TestChatApi["Service"], tab: Awaited<ReturnType<typeof openOn>>, text: string, answer: string) => {
  const asked = await tab.actions.ask(text)
  if (!asked.asked) throw new Error(asked.reason)
  const attached = await tab.run(api.attachFor(asked.questionId))
  expect(await attached.respond(answer)).toEqual({ answered: true, answerId: asked.answerId })
  return asked
}

/** Conversation `conversationId`'s rows as Postgres holds them, its times as Postgres prints them in UTC, by position. */
const postgresRows = (api: TestChatApi["Service"], conversationId: string) =>
  Effect.runPromise(api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<Record<string, unknown>>`
    SELECT id, role, text, status, question_id AS "questionId", failure, model_id AS "modelId",
      stop_reason AS "stopReason", input_tokens AS "inputTokens", output_tokens AS "outputTokens",
      position::int AS position, (created_at AT TIME ZONE 'UTC')::text || '+00' AS "createdAt",
      (updated_at AT TIME ZONE 'UTC')::text || '+00' AS "updatedAt", conversation_id AS "conversationId", summary,
      summary_revision AS "summaryRevision", phase, arc
    FROM messages WHERE conversation_id = ${conversationId} ORDER BY position`))))

test("a question asked through ChatApi is read back from the shard, with no shape of any conversation's messages, as Postgres holds it", async () => {
  const api = await openApi()
  const reader = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const other = await openOn(api, nodeDevice({ agent: api }), quick)
  const conversationId = await reader.show("feature")
  expect(await other.show("feature")).toBe(conversationId)

  // Asked on one tab: the send is confirmed by the row arriving from the shard, and nothing else delivers it there.
  const asked = await exchange(api, reader, "What is a shard?", "One conversation, sequenced.")
  const whole = ["user done What is a shard?", "assistant done One conversation, sequenced."]
  await until(async () => expect(await reader.shown(conversationId)).toEqual(whole))
  await until(async () => expect(await other.shown(conversationId)).toEqual(whole))
  expect(await reader.queued(conversationId)).toEqual([])
  expect(reader.connection()).toMatchObject({ status: "up", retry: false })

  // No Electric on the read path of either tab: neither asked for a shape of any conversation's messages, the home's
  // included. Each pulled the shard.
  for (const tab of [reader, other]) {
    expect(shapeOf(tab.requests)).toEqual([])
    expect(shardOf(tab.requests, conversationId).length).toBeGreaterThan(0)
    expect(shardOf(tab.requests, conversationId).every((request) => request.startsWith("GET "))).toBe(true)
  }

  // Row for row, column for column, what the shard gave is what Postgres holds: ids, text, status, the question each
  // answer answers, Postgres's position and its times as it prints them.
  const fromShardRows = await reader.rows(conversationId)
  expect(fromShardRows.map((row) => row.id)).toEqual([asked.questionId, asked.answerId])
  const columns = (row: Message) => ({
    id: row.id, role: row.role, text: row.text, status: row.status, questionId: row.questionId, failure: row.failure,
    modelId: row.modelId, stopReason: row.stopReason, inputTokens: row.inputTokens, outputTokens: row.outputTokens,
    position: row.position, createdAt: row.createdAt, updatedAt: row.updatedAt, conversationId: row.conversationId,
    summary: row.summary ?? null, summaryRevision: row.summaryRevision ?? null, phase: row.phase ?? null, arc: row.arc ?? null,
  })
  expect(fromShardRows.map(columns)).toEqual(await postgresRows(api, conversationId))
  expect(fromShardRows[1]!.position).toBe(fromShardRows[0]!.position + 1)
  expect(fromShardRows[1]!.updatedAt).not.toBe(fromShardRows[1]!.createdAt)

  // A second exchange, asked on the other tab: the first follows it without being told.
  await exchange(api, other, "And a replica?", "A copy that follows.")
  const both = [...whole, "user done And a replica?", "assistant done A copy that follows."]
  await until(async () => expect(await reader.shown(conversationId)).toEqual(both))
  await until(async () => expect(await other.shown(conversationId)).toEqual(both))
  expect((await reader.rows(conversationId)).map(columns)).toEqual(await postgresRows(api, conversationId))
  expect((await other.rows(conversationId)).map(columns)).toEqual(await postgresRows(api, conversationId))

  // A tab configured with nothing about the shard asks at once, then once a second: it opens whole.
  const defaults = await openOn(api, nodeDevice({ agent: api }), { unreachableAfter: "300 millis", confirmWithin: "5 seconds" })
  expect(await defaults.show("feature")).toBe(conversationId)
  await until(async () => expect(await defaults.shown(conversationId)).toEqual(both))
  expect(shapeOf(defaults.requests)).toEqual([])
}, 90_000)

test("a question asked offline is sent when the network returns, and read back from the shard; the pill follows", async () => {
  const api = await openApi()
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "Before the tunnel", "Answered.")
  const before = ["user done Before the tunnel", "assistant done Answered."]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(before))
  await until(() => expect(tab.connection().status).toBe("up"))

  // The network goes: the shard's pulls fail like every other request, and after `unreachableAfter` the pill says so.
  tab.net.fault = () => "offline"
  await until(() => expect(tab.connection()).toMatchObject({ status: "offline", retry: true }))
  const asked = await tab.actions.ask("Asked in the tunnel")
  if (!asked.asked) throw new Error(asked.reason)
  // Queued on the device, shown at once after what the shard gave before, which is still shown.
  await until(async () => expect(await tab.shown(conversationId)).toEqual([...before, "user queued Asked in the tunnel"]))
  await until(async () => expect(await tab.queued(conversationId)).toEqual(["Asked in the tunnel"]))
  // Nothing of it has left the device: the shard holds the first exchange and no more.
  expect((await Effect.runPromise(Effect.scoped(api.shards!.state(conversationId)))).chat.messages).toHaveLength(2)

  // The network returns: the outbox sends the question, Postgres stores it, the bridge sequences it, and the tab
  // reads it from the shard, which confirms the send. Nothing stays queued, and the pill hides.
  tab.net.fault = () => undefined
  await tab.run(retry("online"))
  await until(async () =>
    expect(await tab.shown(conversationId)).toEqual([...before, "user done Asked in the tunnel", "assistant streaming "]))
  await until(async () => expect(await tab.queued(conversationId)).toEqual([]))
  expect((await Effect.runPromise(Effect.scoped(api.shards!.state(conversationId)))).chat.messages.map((message) => message.body))
    .toEqual(["Before the tunnel", "Answered.", "Asked in the tunnel", ""])
  await until(() => expect(tab.connection()).toMatchObject({ status: "up", retry: false }))
  expect(shapeOf(tab.requests)).toEqual([])
}, 90_000)

test("a shard ChatApi refuses shows Sync failed, which the home shape syncing doesn't clear; Retry does", async () => {
  const api = await openApi()
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "Still here?", "Yes.")
  await until(async () => expect(await tab.shown(conversationId)).toEqual(["user done Still here?", "assistant done Yes."]))
  await until(() => expect(tab.connection().status).toBe("up"))

  // A gateway refuses the shard's requests, and only those: the home conversation's shape keeps syncing.
  tab.net.fault = (path) => (path.includes(`/api/conversations/${conversationId}/messages/`) ? 403 : undefined)
  await until(() => expect(tab.connection()).toMatchObject({ status: "failed", retry: true }))
  // Stopped: no request follows on its own.
  const stoppedAt = shardOf(tab.requests, conversationId).length
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(shardOf(tab.requests, conversationId).length).toBe(stoppedAt)
  expect(tab.connection()).toMatchObject({ status: "failed", retry: true })
  // Retry while it is still refused asks again and stays failed; Retry once it is back syncs, and the pill hides.
  await tab.run(tab.store.retryNow)
  await until(() => expect(shardOf(tab.requests, conversationId).length).toBeGreaterThan(stoppedAt))
  await until(() => expect(tab.connection()).toMatchObject({ status: "failed", retry: true }))
  // Refused, for all the tab can tell, by ChatApi: the conversation is not shown while it is.
  expect(await tab.shown(conversationId)).toEqual([])
  tab.net.fault = () => undefined
  await tab.run(tab.store.retryNow)
  await until(() => expect(tab.connection()).toMatchObject({ status: "up", retry: false }))
  await until(async () => expect(await tab.shown(conversationId)).toEqual(["user done Still here?", "assistant done Yes."]))
}, 90_000)

test("each branch reads its own shard as the tab switches between them, on two tabs at once, and a tab opened after one closed reads it all again", async () => {
  const api = await openApi()
  const device = nodeDevice({ agent: api })
  const first = await openOn(api, device, fromShard)
  const feature = await first.show("feature")
  await exchange(api, first, "In feature", "Feature's answer.")
  const other = await first.show("other")
  expect(other).not.toBe(feature)
  await exchange(api, first, "In other", "Other's answer.")
  const inFeature = ["user done In feature", "assistant done Feature's answer."]
  const inOther = ["user done In other", "assistant done Other's answer."]
  // Both stay open and followed; each holds its own conversation and nothing of the other's.
  await until(async () => expect(await first.shown(other)).toEqual(inOther))
  await until(async () => expect(await first.shown(feature)).toEqual(inFeature))
  expect(await first.show("feature")).toBe(feature)
  expect(await first.shown(feature)).toEqual(inFeature)

  // A second tab on the same device, and a tab on another: each reads the shards itself.
  const second = await openOn(api, device, fromShard)
  const elsewhere = await openOn(api, nodeDevice({ agent: api }), fromShard)
  expect(await second.show("feature")).toBe(feature)
  expect(await elsewhere.show("feature")).toBe(feature)
  await until(async () => expect(await second.shown(feature)).toEqual(inFeature))
  await until(async () => expect(await elsewhere.shown(feature)).toEqual(inFeature))

  // The first tab closes mid-conversation. The others lose nothing, and follow what is asked after it.
  await first.close()
  await exchange(api, second, "After the first tab closed", "Still sequenced.")
  const after = [...inFeature, "user done After the first tab closed", "assistant done Still sequenced."]
  await until(async () => expect(await second.shown(feature)).toEqual(after))
  await until(async () => expect(await elsewhere.shown(feature)).toEqual(after))
  // A tab opened on the first tab's device afterwards kept none of these messages there: it reads them from the shard.
  const reopened = await openOn(api, device, fromShard)
  expect(await reopened.show("feature")).toBe(feature)
  await until(async () => expect(await reopened.shown(feature)).toEqual(after))
  expect(await reopened.rows(feature)).toEqual(await elsewhere.rows(feature))
  for (const tab of [second, elsewhere, reopened]) expect(shapeOf(tab.requests)).toEqual([])
}, 120_000)

test("a branch share taken away empties the open conversation at once, though the person is still in the repository; shared again, Retry brings it back", async () => {
  const api = await openApi()
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  // The same person's other device, following the shard once a second.
  const control = await openOn(api, nodeDevice({ agent: api }), { ...quick, shard: {} })
  const conversationId = await tab.show("feature")
  expect(await control.show("feature")).toBe(conversationId)
  await exchange(api, tab, "Still shared?", "For now.")
  const populated = ["user done Still shared?", "assistant done For now."]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))
  await until(async () => expect(await control.shown(conversationId)).toEqual(populated))
  await until(() => expect(tab.connection().status).toBe("up"))

  // The branch's share is removed, as its owner removes one (worker/branch/Shares.vibe): the branch is someone
  // else's, and no longer shared with the repository. The person's membership of the repository is untouched.
  const sql = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
  const [branch] = await sql((sql) => sql<{ readonly id: string }>`SELECT branch_id AS id FROM conversations WHERE id = ${conversationId}`)
  await sql((sql) => sql`UPDATE branches SET created_by = 'someone-else' WHERE id = ${branch!.id}`)
  await sql((sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branch!.id}`)

  // The next Pull is refused, and what the tab showed of the conversation is gone with that answer: its rows, and
  // the page's reading of them. The pill says the sync failed.
  await until(() => expect(tab.connection()).toMatchObject({ status: "failed", retry: true }))
  await until(async () => expect(await tab.rows(conversationId)).toEqual([]))
  await until(async () => expect(await tab.shown(conversationId)).toEqual([]))
  const everything = tab.store.opened(conversationId)!.everything
  everything.tanstack.startSyncImmediate()
  await until(async () => expect(await tab.run(everything.toArray)).toEqual([]))
  // ChatApi refused it, and the tab stopped asking: no request follows on its own.
  const stoppedAt = shardOf(tab.requests, conversationId).length
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(shardOf(tab.requests, conversationId).length).toBe(stoppedAt)
  // The repository is still the person's, and the data gate still shows its conversations: only ChatApi's answer to
  // a read of the shard takes the conversation away, so the other device loses it with its own next read.
  await until(async () => expect(await control.shown(conversationId)).toEqual([]))
  // Asking again while it is still not shared shows nothing. Retry starts the read and does not wait for it: the
  // read is sent, and refused.
  const retriedFrom = shardOf(tab.requests, conversationId).length
  await tab.run(tab.store.retryNow)
  await until(() => expect(shardOf(tab.requests, conversationId).length).toBeGreaterThan(retriedFrom))
  await new Promise((resolve) => setTimeout(resolve, 200))
  await until(() => expect(tab.connection()).toMatchObject({ status: "failed", retry: true }))
  expect(await tab.shown(conversationId)).toEqual([])

  // Shared with the repository again: nothing returns on its own, and Retry, answered by ChatApi, brings it all back.
  await sql((sql) => sql`INSERT INTO branch_shares (branch_id, grantee, access) VALUES (${branch!.id}, 'repository', 'edit')`)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(await tab.shown(conversationId)).toEqual([])
  await tab.run(tab.store.retryNow)
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))
  await until(() => expect(tab.connection()).toMatchObject({ status: "up", retry: false }))
  expect(shapeOf(tab.requests)).toEqual([])
}, 120_000)

test("a branch share taken away hides the whole conversation, not its messages alone: a view the device kept and a question it queued go with the refusal, and return with the rows", async () => {
  const api = await openApi()
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "Still shared?", "For now.")
  const sql = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
  // A view in the conversation: Electric syncs it, and the device keeps it beside the messages the shard gave.
  const viewId = crypto.randomUUID()
  await sql((sql) => sql`
    INSERT INTO views (id, template, props, conversation_id)
    VALUES (${viewId}, 'link', '{"url":"https://example.com/"}'::jsonb, ${conversationId})`)
  const transcript = ["user done Still shared?", "assistant done For now.", "view done "]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(transcript))
  await until(() => expect(tab.connection().status).toBe("up"))
  const views = await tab.run(Effect.service(ViewsStore))
  const viewRows = views.rowsIn(conversationId)
  viewRows.tanstack.startSyncImmediate()
  const cachedViews = async () => (await tab.run(viewRows.toArray)).map((row) => row.id)
  await until(async () => expect(await cachedViews()).toEqual([viewId]))
  // A question the device queued: ChatApi's question route cannot be reached, so it stays on this device. Every
  // other request, the shard's pulls among them, goes through.
  tab.net.fault = (path) => (path === QUESTIONS_ROUTE ? "offline" : undefined)
  const asked = await tab.actions.ask("Queued on this device")
  if (!asked.asked) throw new Error(asked.reason)
  const populated = [...transcript, "user queued Queued on this device"]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))
  await until(async () => expect(await tab.queued(conversationId)).toEqual(["Queued on this device"]))

  // The branch's share is removed. The person's membership of the repository is untouched, so the data gate alone
  // still lets every row of the conversation show: the repository's own page of it would.
  const [branch] = await sql((sql) => sql<{ readonly id: string }>`SELECT branch_id AS id FROM conversations WHERE id = ${conversationId}`)
  await sql((sql) => sql`UPDATE branches SET created_by = 'someone-else' WHERE id = ${branch!.id}`)
  await sql((sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branch!.id}`)

  // ChatApi refuses the next Pull, and everything the tab showed of the conversation goes with that answer: the
  // transcript, the view the device still holds from Electric, and the question it queued. Nothing a deduplicated
  // copy hid comes back in their place.
  await until(() => expect(tab.connection()).toMatchObject({ status: "failed", retry: true }))
  await until(async () => expect(await tab.shown(conversationId)).toEqual([]))
  expect(await tab.rows(conversationId)).toEqual([])
  expect(await tab.queued(conversationId)).toEqual([])
  expect(await cachedViews()).toEqual([])
  const opened = tab.store.opened(conversationId)!
  for (const query of [opened.everything, opened.latest]) query.tanstack.startSyncImmediate()
  await until(async () => expect(await tab.run(opened.everything.toArray)).toEqual([]))
  expect(await tab.run(opened.latest.toArray)).toEqual([])
  // The device still holds both: the view Electric delivered, and the question in its outbox. Only showing stopped.
  expect((await tab.run((await tab.run(views.forConversation(conversationId))).toArray)).map((row) => row.id)).toEqual([viewId])
  expect((await tab.run(tab.store.asking.toArray)).map((row) => row.text)).toEqual(["Queued on this device"])
  // Nothing returns while ChatApi still refuses, however long the tab waits and whatever Retry asks.
  await new Promise((resolve) => setTimeout(resolve, 120))
  await tab.run(tab.store.retryNow)
  await until(() => expect(tab.connection()).toMatchObject({ status: "failed", retry: true }))
  expect(await tab.shown(conversationId)).toEqual([])
  expect(await cachedViews()).toEqual([])

  // Shared again: Retry, answered whole by ChatApi, brings back the transcript, and with it the view and the
  // queued question, each once.
  await sql((sql) => sql`INSERT INTO branch_shares (branch_id, grantee, access) VALUES (${branch!.id}, 'repository', 'edit')`)
  await tab.run(tab.store.retryNow)
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))
  expect(await cachedViews()).toEqual([viewId])
  expect(await tab.queued(conversationId)).toEqual(["Queued on this device"])
  // The question route returns: the queued question is sent, stored, bridged and read back from the shard.
  tab.net.fault = () => undefined
  await tab.run(retry("online"))
  await until(async () =>
    expect(await tab.shown(conversationId)).toEqual([...transcript, "user done Queued on this device", "assistant streaming "]))
  await until(async () => expect(await tab.queued(conversationId)).toEqual([]))
  expect(shapeOf(tab.requests)).toEqual([])
}, 120_000)

/** Runs SQL on ChatApi's Postgres. */
const sqlOn = (api: TestChatApi["Service"]) => <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))

/** Takes the branch of conversation `conversationId` from the person, whose repository stays theirs; `share` gives it back. */
const unshare = async (api: TestChatApi["Service"], conversationId: string) => {
  const sql = sqlOn(api)
  const [branch] = await sql((sql) => sql<{ readonly id: string }>`SELECT branch_id AS id FROM conversations WHERE id = ${conversationId}`)
  await sql((sql) => sql`UPDATE branches SET created_by = 'someone-else' WHERE id = ${branch!.id}`)
  await sql((sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branch!.id}`)
  return {
    branchId: branch!.id,
    share: () => sql((sql) => sql`INSERT INTO branch_shares (branch_id, grantee, access) VALUES (${branch!.id}, 'repository', 'edit')`),
  }
}

test("a Pull answered 401 hides the whole conversation with that answer, and it stays hidden though the session read after it never answers and the read ends unanswered", async () => {
  const api = await openApi()
  // The page's transport is main.tsx's: `boundFetch`, which reads the session again after a 401 and returns the 401
  // only then, over a `fetch` that tells each read's 401 as it arrives.
  const denials = readDenials()
  const page = (network: typeof globalThis.fetch) =>
    boundFetch(denials.observing(network), { origin: api.origin, principal: () => "person-member", reauthorize: async () => false })
  const tab = await openOn(api, nodeDevice({ agent: api }), { ...quick, shard: { follow: "20 millis", within: "300 millis" }, readDenials: denials }, undefined, page)
  // Another branch of the same repository, open on the same tab: what the repository's own gate still shows.
  const other = await tab.show("other")
  await exchange(api, tab, "In other", "Other's answer.")
  const inOther = ["user done In other", "assistant done Other's answer."]
  await until(async () => expect(await tab.shown(other)).toEqual(inOther))
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "Still signed in?", "For now.")
  const viewId = crypto.randomUUID()
  await sqlOn(api)((sql) => sql`
    INSERT INTO views (id, template, props, conversation_id)
    VALUES (${viewId}, 'link', '{"url":"https://example.com/"}'::jsonb, ${conversationId})`)
  const transcript = ["user done Still signed in?", "assistant done For now.", "view done "]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(transcript))
  const views = await tab.run(Effect.service(ViewsStore))
  const viewRows = views.rowsIn(conversationId)
  viewRows.tanstack.startSyncImmediate()
  const cachedViews = async () => (await tab.run(viewRows.toArray)).map((row) => row.id)
  await until(async () => expect(await cachedViews()).toEqual([viewId]))
  const reads = `/api/conversations/${conversationId}/messages/`
  const questions: Fault = (path) => (path === QUESTIONS_ROUTE ? "offline" : undefined)
  tab.net.fault = questions
  const asked = await tab.actions.ask("Queued on this device")
  if (!asked.asked) throw new Error(asked.reason)
  const populated = [...transcript, "user queued Queued on this device"]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))
  await until(() => expect(tab.connection().status).toBe("up"))

  // ChatApi answers this conversation's reads 401, and every session read from then on is never answered: the
  // transport waits on one past the read's deadline, and the 401 it holds never reaches the shard's client.
  const sessionReadsBefore = tab.requests.filter((request) => request.includes(SESSION_ROUTE)).length
  tab.net.fault = (path) => (path.startsWith(reads) ? 401 : path === SESSION_ROUTE ? "stall" : questions(path))
  await until(async () => expect(await tab.shown(conversationId)).toEqual([]))
  expect(await tab.queued(conversationId)).toEqual([])
  expect(await cachedViews()).toEqual([])
  // The rows themselves, which no page reads as they are, go a turn after what shows of them.
  await until(async () => expect(await tab.rows(conversationId)).toEqual([]))
  // The transport did read the session again after the 401, and that read is the one that never answers.
  await until(() => expect(tab.requests.filter((request) => request.includes(SESSION_ROUTE)).length).toBeGreaterThan(sessionReadsBefore))
  // Past the deadline, several times over: the read ended with no answer from the transport, and nothing has returned.
  await until(() => expect(tab.connection()).toMatchObject({ status: "failed", retry: true }))
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  expect(await tab.shown(conversationId)).toEqual([])
  expect(await tab.queued(conversationId)).toEqual([])
  expect(await cachedViews()).toEqual([])
  await tab.run(tab.store.retryNow)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(await tab.shown(conversationId)).toEqual([])
  expect(await cachedViews()).toEqual([])
  // The device still holds the view and the question, and the repository's other branch shows as before: only this
  // conversation was refused.
  expect((await tab.run((await tab.run(views.forConversation(conversationId))).toArray)).map((row) => row.id)).toEqual([viewId])
  expect((await tab.run(tab.store.asking.toArray)).map((row) => row.text)).toEqual(["Queued on this device"])
  expect(await tab.shown(other)).toEqual(inOther)

  // ChatApi serves the read again: Retry, answered whole, brings back the transcript, the view and the queued question.
  tab.net.fault = questions
  await tab.run(tab.store.retryNow)
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))
  expect(await cachedViews()).toEqual([viewId])
  expect(shapeOf(tab.requests)).toEqual([])
}, 120_000)

test("a refused branch stays hidden through a reload offline, though its repository is still the person's: the view and the question the device kept show only once ChatApi answers a read whole", async () => {
  const api = await openApi()
  let online = true
  const device = nodeDevice({ agent: api, isOnline: () => online })
  const tab = await openOn(api, device, fromShard)
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "Still shared?", "For now.")
  const viewId = crypto.randomUUID()
  await sqlOn(api)((sql) => sql`
    INSERT INTO views (id, template, props, conversation_id)
    VALUES (${viewId}, 'link', '{"url":"https://example.com/"}'::jsonb, ${conversationId})`)
  const transcript = ["user done Still shared?", "assistant done For now.", "view done "]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(transcript))
  const questions: Fault = (path) => (path === QUESTIONS_ROUTE ? "offline" : undefined)
  tab.net.fault = questions
  const asked = await tab.actions.ask("Queued on this device")
  if (!asked.asked) throw new Error(asked.reason)
  const populated = [...transcript, "user queued Queued on this device"]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))
  // Nothing is kept of a conversation ChatApi serves.
  expect(device.stored("conversation-refusals")).toBe(0)

  // The branch's share is taken away, the repository stays the person's, and ChatApi refuses the next Pull: the
  // conversation is hidden, and the device keeps the refusal beside the view, the question and the branch's route.
  const branch = await unshare(api, conversationId)
  await until(async () => expect(await tab.shown(conversationId)).toEqual([]))
  await until(() => expect(device.storedRows("conversation-refusals")).toEqual([expect.objectContaining({ conversationId })]))
  expect(device.stored("branch-conversations")).toBe(1)
  await tab.close()

  // A fresh tab on the device, with no network at all: it opens the branch from the route the device kept.
  online = false
  const offline = await openOn(api, device, { ...fromShard, unreachableAfter: "100 millis" }, () => "offline")
  expect(await offline.show("feature")).toBe(conversationId)
  const views = await offline.run(Effect.service(ViewsStore))
  // The device restored what it kept of the conversation: the view Electric had delivered, and the queued question.
  const held = await offline.run(views.forConversation(conversationId))
  await offline.run(held.restored)
  await until(async () => expect((await offline.run(held.toArray)).map((row) => row.id)).toEqual([viewId]))
  await until(async () => expect((await offline.run(offline.store.asking.toArray)).map((row) => row.text)).toEqual(["Queued on this device"]))
  // And shows none of it: not the view, not the question, not a row, on any query a page reads.
  const viewRows = views.rowsIn(conversationId)
  viewRows.tanstack.startSyncImmediate()
  const opened = offline.store.opened(conversationId)!
  for (const query of [opened.everything, opened.latest]) query.tanstack.startSyncImmediate()
  const nothingShows = async () => {
    expect(await offline.shown(conversationId)).toEqual([])
    expect(await offline.queued(conversationId)).toEqual([])
    expect(await offline.run(viewRows.toArray)).toEqual([])
    expect(await offline.run(opened.everything.toArray)).toEqual([])
    expect(await offline.run(opened.latest.toArray)).toEqual([])
  }
  await nothingShows()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await nothingShows()
  // The repository's own gate is open on this tab: another conversation of the repository is one of the person's shown.
  const owners = await offline.run(Effect.service(ConversationOwners))
  owners.shown.tanstack.startSyncImmediate()
  expect((await offline.run(owners.mine.toArray)).map((row) => row.conversationId)).toContain(conversationId)
  expect((await offline.run(owners.shown.toArray)).map((row) => row.conversationId)).not.toContain(conversationId)

  // The network returns and ChatApi still refuses: nothing shows, and the device still keeps the refusal.
  online = true
  offline.net.fault = questions
  await offline.run(retry("online"))
  await until(() => expect(shardOf(offline.requests, conversationId).length).toBeGreaterThan(0))
  await until(() => expect(offline.connection()).toMatchObject({ status: "failed", retry: true }))
  await nothingShows()
  expect(device.stored("conversation-refusals")).toBeGreaterThan(0)

  // Shared again: the read ChatApi answers whole brings back the transcript, the view and the queued question, and
  // the device keeps the refusal no longer.
  await branch.share()
  const workspace = await offline.run(Effect.service(Branch))
  await workspace.actions.open("octo", "hello", "feature")
  await until(() => expect(owners.routeDenied("github/octo/hello", "feature")).toBe(false))
  await offline.run(offline.store.retryNow)
  await until(async () => expect(await offline.shown(conversationId)).toEqual(populated))
  expect((await offline.run(viewRows.toArray)).map((row) => row.id)).toEqual([viewId])
  expect((await offline.run(owners.shown.toArray)).map((row) => row.conversationId)).toContain(conversationId)
  await until(() => expect(device.stored("conversation-refusals")).toBe(0))
  await offline.close()

  // The next load, offline again, shows what the device kept: the refusal went with ChatApi's answer.
  online = false
  const later = await openOn(api, device, { ...fromShard, unreachableAfter: "100 millis" }, () => "offline")
  expect(await later.show("feature")).toBe(conversationId)
  await until(async () => expect(await later.shown(conversationId)).toEqual(["view done ", "user queued Queued on this device"]))
}, 180_000)

test.each([
  ["from the moment ChatApi refuses", false],
  ["from before the device first heard of the branch, with room made after the refusal", true],
])("a refusal neither the device's store nor its Web Storage could take still hides the branch through a reload offline, Web Storage full %s: the view, the queued question and the conversation's row show only once ChatApi answers a read whole", async (_when, fullFromTheStart) => {
  const api = await openApi()
  let online = true
  const device = nodeDevice({ agent: api, isOnline: () => online })
  // The device's store takes every write but a refusal's, and its Web Storage is over its quota, from the moment
  // ChatApi refuses: it reads, it removes, and it takes no new key.
  const { device: unwritable, faults } = failWrites(device, "conversation-refusals")
  const { device: faulty, quota } = fillStorage(unwritable)
  // Full before boot: the first answer cannot open the branch. A fresh answer can once there is room.
  quota.full = fullFromTheStart
  const tab = await openOn(api, faulty, fromShard)
  if (fullFromTheStart) {
    const branch = await tab.run(Effect.service(Branch))
    const owners = await tab.run(Effect.service(ConversationOwners))
    expect(owners.fence().epoch).toBeNull()
    expect(await branch.actions.open("octo", "hello", "feature")).toBeUndefined()
    expect(branch.actions.writable()).toBe(false)
    expect(device.stored("branch-conversations")).toBe(0)
    quota.full = false
    expect(owners.fence().epoch).toMatch(/^[0-9a-f]{16}$/)
  }
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "Still shared?", "For now.")
  const viewId = crypto.randomUUID()
  await sqlOn(api)((sql) => sql`
    INSERT INTO views (id, template, props, conversation_id)
    VALUES (${viewId}, 'link', '{"url":"https://example.com/"}'::jsonb, ${conversationId})`)
  const transcript = ["user done Still shared?", "assistant done For now.", "view done "]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(transcript))
  const questions: Fault = (path) => (path === QUESTIONS_ROUTE ? "offline" : undefined)
  tab.net.fault = questions
  const asked = await tab.actions.ask("Queued on this device")
  if (!asked.asked) throw new Error(asked.reason)
  const populated = [...transcript, "user queued Queued on this device"]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))
  // Online and read whole, the conversation is open as Web Storage keeps it, where it had the room.
  const open = Marks.keyOf("open", DEVICE_PRINCIPAL, conversationId)
  await until(() => expect(device.webStorage.entries.has(open)).toBe(true))

  // The branch's share is taken away and ChatApi refuses the next Pull: the conversation is hidden, the device's
  // store refuses the refusal's row, and Web Storage its key. The tab closes with neither holding a refusal. What
  // full storage still took is that the conversation is open.
  faults.fail = true
  quota.full = true
  const branch = await unshare(api, conversationId)
  await until(async () => expect(await tab.shown(conversationId)).toEqual([]))
  await until(async () => expect((await tab.run(Metric.value(Metric.withAttributes(Persistence.writeFailures, { collection: "conversation-refusals", operation: "insert" })))).count).toBe(1))
  expect(device.stored("conversation-refusals")).toBe(0)
  expect(device.refusalMarks!.read()).toEqual([])
  expect(device.webStorage.entries.has(open)).toBe(false)
  expect(device.stored("branch-conversations")).toBe(1)
  await tab.close()
  faults.fail = false
  // Room is made in Web Storage after the refusal no store took: with no key of the conversation there, the next
  // load must not take it for one the device never heard of.
  if (fullFromTheStart) quota.full = false

  // A fresh tab on the device, with no network at all: it opens the branch from the route the device kept, and
  // restores the view, the queued question and the person's row of the conversation that the device kept.
  online = false
  const offline = await openOn(api, { ...device, refusalMarks: faulty.refusalMarks! }, { ...fromShard, unreachableAfter: "100 millis" }, () => "offline")
  // The conversation is opened as its page does once the route is read, with no `branch/track`: the device's engine
  // reaches ChatApi whatever the page's network does here, and a refusal it heard would be another record.
  expect((await offline.run(Effect.flatMap(Effect.service(BranchStore), ({ conversations }) =>
    Effect.andThen(Effect.ignore(conversations.restored), conversations.toArray)))).map((row) => row.conversationId)).toEqual([conversationId])
  await offline.run(offline.store.open(conversationId))
  const views = await offline.run(Effect.service(ViewsStore))
  const held = await offline.run(views.forConversation(conversationId))
  await offline.run(held.restored)
  await until(async () => expect((await offline.run(held.toArray)).map((row) => row.id)).toEqual([viewId]))
  await until(async () => expect((await offline.run(offline.store.asking.toArray)).map((row) => row.text)).toEqual(["Queued on this device"]))
  // It shows none of it, on any query a page reads, and the conversation is none of the person's shown, though no
  // store holds a refusal of it: nothing says it is open, and nothing has answered a read of it on this load.
  const viewRows = views.rowsIn(conversationId)
  viewRows.tanstack.startSyncImmediate()
  const opened = offline.store.opened(conversationId)!
  for (const query of [opened.everything, opened.latest]) query.tanstack.startSyncImmediate()
  const owners = await offline.run(Effect.service(ConversationOwners))
  owners.shown.tanstack.startSyncImmediate()
  const nothingShows = async () => {
    expect(await offline.shown(conversationId)).toEqual([])
    expect(await offline.queued(conversationId)).toEqual([])
    expect(await offline.run(viewRows.toArray)).toEqual([])
    expect(await offline.run(opened.everything.toArray)).toEqual([])
    expect(await offline.run(opened.latest.toArray)).toEqual([])
    expect((await offline.run(owners.shown.toArray)).map((row) => row.conversationId)).not.toContain(conversationId)
  }
  await nothingShows()
  await new Promise((resolve) => setTimeout(resolve, 700))
  await nothingShows()
  await until(async () => expect((await offline.run(owners.mine.toArray)).map((row) => row.conversationId)).toContain(conversationId))
  await nothingShows()
  expect(device.stored("conversation-refusals")).toBe(0)
  expect(device.refusalMarks!.read()).toEqual([])

  // The network returns and ChatApi still refuses: nothing shows.
  online = true
  offline.net.fault = questions
  await offline.run(retry("online"))
  await until(() => expect(shardOf(offline.requests, conversationId).length).toBeGreaterThan(0))
  await until(() => expect(offline.connection()).toMatchObject({ status: "failed", retry: true }))
  await nothingShows()

  // Shared again: the read ChatApi answers whole brings back the transcript, the view and the queued question.
  quota.full = false
  await branch.share()
  const workspace = await offline.run(Effect.service(Branch))
  await workspace.actions.open("octo", "hello", "feature")
  await until(() => expect(owners.routeDenied("github/octo/hello", "feature")).toBe(false))
  await offline.run(offline.store.retryNow)
  await until(async () => expect(await offline.shown(conversationId)).toEqual(populated), 60_000)
  expect((await offline.run(viewRows.toArray)).map((row) => row.id)).toEqual([viewId])
  expect((await offline.run(owners.shown.toArray)).map((row) => row.conversationId)).toContain(conversationId)
}, 180_000)

test("a refused branch's run leaves the person's runs, and its wait leaves core/waits, though the repository is still theirs", async () => {
  const api = await openApi()
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const other = await tab.show("other")
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "Still shared?", "For now.")
  await until(async () => expect(await tab.shown(conversationId)).toEqual(["user done Still shared?", "assistant done For now."]))
  // Two of the person's runs wait for them, one in each branch of the repository. Each asks a question with options.
  const sql = sqlOn(api)
  const waitIn = async (conversation: string, prompt: string) => {
    const runId = crypto.randomUUID()
    await sql((sql) => sql`
      INSERT INTO runs (id, flow, status, waiting, wait, version, launched_by, conversation_id)
      VALUES (${runId}, 'agent', 'needs_you', 'input',
        ${JSON.stringify({ execution: `ask-${runId}`, kind: "question", prompt, options: ["Ship", "Hold"] })}::jsonb, 1,
        'person-member', ${conversation})`)
    return runId
  }
  const refusedRun = await waitIn(conversationId, "Ship the secret plan?")
  const otherRun = await waitIn(other, "Ship the other plan?")
  const status = await tab.run(Effect.service(StatusStore))
  // `core/waits` publishes the status store's waits (src/plugins/plugins.ts), and a run page lists its shown runs.
  for (const query of [status.waits, status.shownRuns]) query.tanstack.startSyncImmediate()
  const waits = async () => (await tab.run(status.waits.toArray)).map((row) => `${row.runId} ${row.prompt} ${row.options.join("/")}`).sort()
  const runs = async () => (await tab.run(status.shownRuns.toArray)).map((row) => row.id).sort()
  const kept = `${otherRun} Ship the other plan? Ship/Hold`
  const both = [`${refusedRun} Ship the secret plan? Ship/Hold`, kept].sort()
  await until(async () => expect(await waits()).toEqual(both))
  await until(async () => expect(await runs()).toEqual([refusedRun, otherRun].sort()))

  // The branch's share is taken away; the repository stays the person's. ChatApi refuses the next Pull, and the
  // refused branch's run and its wait, prompt and options, go with the conversation. The other branch's stay.
  const branch = await unshare(api, conversationId)
  await until(async () => expect(await tab.shown(conversationId)).toEqual([]))
  await until(async () => expect(await waits()).toEqual([kept]))
  await until(async () => expect(await runs()).toEqual([otherRun]))
  // Electric still delivers the run's row to its launcher, and the repository still shows: only the refusal hides it.
  expect((await tab.run(status.runs.toArray)).map((row) => row.id).sort()).toEqual([refusedRun, otherRun].sort())
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(await waits()).toEqual([kept])
  expect(await runs()).toEqual([otherRun])

  // Shared again: Retry, answered whole by ChatApi, returns the run and its wait.
  await branch.share()
  await tab.run(tab.store.retryNow)
  await until(async () => expect(await waits()).toEqual(both))
  await until(async () => expect(await runs()).toEqual([refusedRun, otherRun].sort()))
}, 120_000)

test("a refusal the device's store could not take still hides the branch through a reload offline: the view and the question the device kept show only once ChatApi answers a read whole", async () => {
  const api = await openApi()
  let online = true
  const device = nodeDevice({ agent: api, isOnline: () => online })
  // The device's store takes every write but a refusal's, from the moment ChatApi refuses.
  const { device: faulty, faults } = failWrites(device, "conversation-refusals")
  const tab = await openOn(api, faulty, fromShard)
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "Still shared?", "For now.")
  const viewId = crypto.randomUUID()
  await sqlOn(api)((sql) => sql`
    INSERT INTO views (id, template, props, conversation_id)
    VALUES (${viewId}, 'link', '{"url":"https://example.com/"}'::jsonb, ${conversationId})`)
  const transcript = ["user done Still shared?", "assistant done For now.", "view done "]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(transcript))
  const questions: Fault = (path) => (path === QUESTIONS_ROUTE ? "offline" : undefined)
  tab.net.fault = questions
  const asked = await tab.actions.ask("Queued on this device")
  if (!asked.asked) throw new Error(asked.reason)
  const populated = [...transcript, "user queued Queued on this device"]
  await until(async () => expect(await tab.shown(conversationId)).toEqual(populated))

  // The branch's share is taken away and ChatApi refuses the next Pull: the conversation is hidden, and the device's
  // store refuses the refusal's row. The tab closes with the store holding none.
  faults.fail = true
  const branch = await unshare(api, conversationId)
  await until(async () => expect(await tab.shown(conversationId)).toEqual([]))
  await until(async () => expect((await tab.run(Metric.value(Metric.withAttributes(Persistence.writeFailures, { collection: "conversation-refusals", operation: "insert" })))).count).toBe(1))
  expect(device.stored("conversation-refusals")).toBe(0)
  expect(device.stored("branch-conversations")).toBe(1)
  await tab.close()
  faults.fail = false

  // A fresh tab on the device, with no network at all: it opens the branch from the route the device kept, and
  // restores the view and the queued question the device kept of it.
  online = false
  const offline = await openOn(api, device, { ...fromShard, unreachableAfter: "100 millis" }, () => "offline")
  expect(await offline.show("feature")).toBe(conversationId)
  const views = await offline.run(Effect.service(ViewsStore))
  const held = await offline.run(views.forConversation(conversationId))
  await offline.run(held.restored)
  await until(async () => expect((await offline.run(held.toArray)).map((row) => row.id)).toEqual([viewId]))
  await until(async () => expect((await offline.run(offline.store.asking.toArray)).map((row) => row.text)).toEqual(["Queued on this device"]))
  // It shows none of it, on any query a page reads, and the conversation is none of the person's shown: the refusal
  // the store never took still stands on this load.
  const viewRows = views.rowsIn(conversationId)
  viewRows.tanstack.startSyncImmediate()
  const opened = offline.store.opened(conversationId)!
  for (const query of [opened.everything, opened.latest]) query.tanstack.startSyncImmediate()
  const owners = await offline.run(Effect.service(ConversationOwners))
  owners.shown.tanstack.startSyncImmediate()
  const nothingShows = async () => {
    expect(await offline.shown(conversationId)).toEqual([])
    expect(await offline.queued(conversationId)).toEqual([])
    expect(await offline.run(viewRows.toArray)).toEqual([])
    expect(await offline.run(opened.everything.toArray)).toEqual([])
    expect(await offline.run(opened.latest.toArray)).toEqual([])
    expect((await offline.run(owners.shown.toArray)).map((row) => row.conversationId)).not.toContain(conversationId)
  }
  await nothingShows()
  await new Promise((resolve) => setTimeout(resolve, 700))
  await nothingShows()
  await until(async () => expect((await offline.run(owners.mine.toArray)).map((row) => row.conversationId)).toContain(conversationId))
  await nothingShows()
  // This load stores the refusal the last one could not.
  await until(() => expect(device.storedRows("conversation-refusals")).toEqual([expect.objectContaining({ conversationId })]))

  // The network returns and ChatApi still refuses: nothing shows.
  online = true
  offline.net.fault = questions
  await offline.run(retry("online"))
  await until(() => expect(shardOf(offline.requests, conversationId).length).toBeGreaterThan(0))
  await until(() => expect(offline.connection()).toMatchObject({ status: "failed", retry: true }))
  await nothingShows()

  // Shared again: the read ChatApi answers whole brings back the transcript, the view and the queued question, and
  // neither record keeps a refusal.
  await branch.share()
  const workspace = await offline.run(Effect.service(Branch))
  await workspace.actions.open("octo", "hello", "feature")
  await until(() => expect(owners.routeDenied("github/octo/hello", "feature")).toBe(false))
  await offline.run(offline.store.retryNow)
  await until(async () => expect(await offline.shown(conversationId)).toEqual(populated), 60_000)
  expect((await offline.run(viewRows.toArray)).map((row) => row.id)).toEqual([viewId])
  await until(() => expect(device.stored("conversation-refusals")).toBe(0))
  expect(device.refusalMarks!.read()).toEqual([])
}, 180_000)

/** Two of the person's runs that wait for them, one in each conversation: each asks a question with options. */
const waitIn = async (api: TestChatApi["Service"], conversation: string, prompt: string) => {
  const runId = crypto.randomUUID()
  await sqlOn(api)((sql) => sql`
    INSERT INTO runs (id, flow, status, waiting, wait, version, launched_by, conversation_id)
    VALUES (${runId}, 'agent', 'needs_you', 'input',
      ${JSON.stringify({ execution: `ask-${runId}`, kind: "question", prompt, options: ["Ship", "Hold"] })}::jsonb, 1,
      'person-member', ${conversation})`)
  return runId
}

/** What `core/waits` publishes and a run page lists on `tab`: the status store's waits and shown runs. */
const globalOf = async (tab: Awaited<ReturnType<typeof openOn>>) => {
  const status = await tab.run(Effect.service(StatusStore))
  for (const query of [status.waits, status.shownRuns]) query.tanstack.startSyncImmediate()
  return {
    waits: async () => (await tab.run(status.waits.toArray)).map((row) => `${row.runId} ${row.prompt} ${row.options.join("/")}`).sort(),
    runs: async () => (await tab.run(status.shownRuns.toArray)).map((row) => row.id).sort(),
    synced: async () => (await tab.run(status.runs.toArray)).map((row) => row.id).sort(),
  }
}

test("a tab that never opened the branch loses its run and its wait as another tab of the device is refused, and has them back when that tab is answered", async () => {
  const api = await openApi()
  const device = nodeDevice({ agent: api })
  const reader = await openOn(api, device, fromShard)
  const other = await reader.show("other")
  const conversationId = await reader.show("feature")
  await exchange(api, reader, "Still shared?", "For now.")
  await until(async () => expect(await reader.shown(conversationId)).toEqual(["user done Still shared?", "assistant done For now."]))
  const refusedRun = await waitIn(api, conversationId, "Ship the secret plan?")
  const otherRun = await waitIn(api, other, "Ship the other plan?")
  // A second tab of the device, on the home conversation: it opens neither branch, and reads no shard. Its pages list
  // the person's runs and waits in every conversation.
  const sibling = await openOn(api, device, fromShard)
  const global = await globalOf(sibling)
  const kept = `${otherRun} Ship the other plan? Ship/Hold`
  const both = [`${refusedRun} Ship the secret plan? Ship/Hold`, kept].sort()
  await until(async () => expect(await global.waits()).toEqual(both))
  await until(async () => expect(await global.runs()).toEqual([refusedRun, otherRun].sort()))
  expect(shardOf(sibling.requests, conversationId)).toEqual([])

  // The branch's share is taken away. ChatApi refuses the first tab's next Pull, and the second tab, told by the
  // device alone, shows neither the run nor its wait, prompt and options.
  const branch = await unshare(api, conversationId)
  await until(async () => expect(await reader.shown(conversationId)).toEqual([]))
  await until(async () => expect(await global.waits()).toEqual([kept]))
  await until(async () => expect(await global.runs()).toEqual([otherRun]))
  // Electric still delivers the run's row to its launcher, and the tab still asked no shard of anything.
  expect(await global.synced()).toEqual([refusedRun, otherRun].sort())
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(await global.waits()).toEqual([kept])
  expect(await global.runs()).toEqual([otherRun])
  expect(shardOf(sibling.requests, conversationId)).toEqual([])

  // Shared again: the first tab's read, answered whole, returns the run and its wait to both tabs.
  await branch.share()
  await reader.run(reader.store.retryNow)
  await until(async () => expect(await global.waits()).toEqual(both))
  await until(async () => expect(await global.runs()).toEqual([refusedRun, otherRun].sort()))
}, 180_000)

test("opening a branch ChatApi answers forbidden records the refusal before the route goes: its run and its wait leave the person's pages, though their rows still sync", async () => {
  const api = await openApi()
  const device = nodeDevice({ agent: api })
  const first = await openOn(api, device, fromShard)
  const conversationId = await first.show("feature")
  await exchange(api, first, "Still shared?", "For now.")
  await until(async () => expect(await first.shown(conversationId)).toEqual(["user done Still shared?", "assistant done For now."]))
  const refusedRun = await waitIn(api, conversationId, "Ship the secret plan?")
  await until(() => expect(device.stored("branch-conversations")).toBe(1))
  await first.close()
  // The share is taken away while no tab of the device is open: no read is refused, and the device keeps no refusal.
  await unshare(api, conversationId)
  expect(device.stored("conversation-refusals")).toBe(0)

  // A fresh tab, online. Before it opens the branch, the person's synced rows still show the run and its wait.
  const tab = await openOn(api, device, fromShard)
  const global = await globalOf(tab)
  const wait = `${refusedRun} Ship the secret plan? Ship/Hold`
  await until(async () => expect(await global.waits()).toEqual([wait]))
  await until(async () => expect(await global.runs()).toEqual([refusedRun]))
  const owners = await tab.run(Effect.service(ConversationOwners))
  owners.shown.tanstack.startSyncImmediate()
  // What the device holds of the refusal at the moment the route leaves it.
  const routes = (await tab.run(Effect.service(BranchStore))).conversations
  const atRemoval: Array<ReadonlyArray<string>> = []
  const watching = routes.tanstack.subscribeChanges((changes) => {
    if (changes.some((change) => change.type === "delete")) atRemoval.push(device.refusalMarks!.read().map((mark) => mark.conversationId))
  }, { includeInitialState: true })
  // Opening the branch is answered forbidden.
  const branch = await tab.run(Effect.service(Branch))
  branch.queries.current.startSyncImmediate()
  expect(await branch.actions.open("octo", "hello", "feature")).toBeUndefined()
  expect(branch.queries.current.toArray[0]).toMatchObject({ status: "forbidden", conversationId: null })
  watching.unsubscribe()
  // The refusal was recorded before the route that named the conversation was discarded, and the device keeps it.
  expect(atRemoval).toEqual([[conversationId]])
  expect(routes.tanstack.size).toBe(0)
  await until(() => expect(device.storedRows("conversation-refusals")).toEqual([expect.objectContaining({ conversationId })]))
  // The person's own rows still name the conversation and still deliver the run; neither shows.
  expect((await tab.run(owners.mine.toArray)).map((row) => row.conversationId)).toContain(conversationId)
  expect((await tab.run(owners.shown.toArray)).map((row) => row.conversationId)).not.toContain(conversationId)
  await until(async () => expect(await global.waits()).toEqual([]))
  await until(async () => expect(await global.runs()).toEqual([]))
  expect(await global.synced()).toEqual([refusedRun])
}, 180_000)

test("the header's latest answer is the transcript's: of two answers at one place, the one the shard sequenced last", async () => {
  const api = await openApi()
  await Effect.runPromise(api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT setval(pg_get_serial_sequence('messages', 'position'), 1000)`))))
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "First question", "First answer.")
  await until(async () => expect(await tab.shown(conversationId)).toEqual(["user done First question", "assistant done First answer."]))
  // Two posts straight to the shard, the second one an answer: the shard places them after the exchange, one place
  // each, which are the places Postgres gives the next question and its answer. The direct answer's id sorts after
  // every id Postgres gives.
  const OWNER = await ownerIn(conversationId, ada)
  const shard = `conv:${conversationId}`
  const direct = (command: string, payload: object) =>
    api.shards!.fetchAs(ada)(`https://smithers.example/api/conversations/${conversationId}/messages/submit`, {
      method: "POST",
      body: JSON.stringify({ version: 2, shard, epoch: 0, command: { key: [`${OWNER}/laptop`, command], stream: shard, payload } }),
    })
  expect((await direct("1", { _tag: "PostMessage", messageId: "zz-direct-question", author: OWNER, body: "Posted between" })).status).toBe(200)
  expect((await direct("2", { _tag: "PostMessage", messageId: "zz-direct-answer", author: OWNER, body: "An answer posted between", role: "assistant" })).status).toBe(200)
  await until(async () => expect((await tab.rows(conversationId)).map((row) => row.id)).toContain("zz-direct-answer"))
  const next = await tab.actions.ask("Second question")
  if (!next.asked) throw new Error(next.reason)
  await until(async () => expect((await tab.rows(conversationId)).map((row) => row.id)).toContain(next.answerId))
  // Two answers at one place: the one posted to the shard directly, and the one Postgres placed there afterwards.
  const rows = await tab.rows(conversationId)
  const posted = rows.find((row) => row.id === "zz-direct-answer")!
  const answer = rows.find((row) => row.id === next.answerId)!
  expect([posted.role, answer.role]).toEqual(["assistant", "assistant"])
  expect(answer.position).toBe(posted.position)
  expect(next.answerId < "zz-direct-answer").toBe(true)

  // The transcript reads the direct answer first, as the shard holds them, so its latest answer is Postgres's.
  const opened = tab.store.opened(conversationId)!
  opened.everything.tanstack.startSyncImmediate()
  const transcript = async () => (await tab.run(opened.everything.toArray)).filter((row) => row.role === "assistant").map((row) => row.id)
  await until(async () => expect((await transcript()).slice(-2)).toEqual(["zz-direct-answer", next.answerId]))
  // The header reads the same one, and its statuses the same order: never the one whose id sorts last.
  const status = (await tab.run(Effect.service(StatusStore))).opened(conversationId)!
  for (const query of [status.statuses, status.latest]) query.tanstack.startSyncImmediate()
  await until(async () => expect((await tab.run(status.statuses.toArray)).map((row) => row.id)).toEqual(await transcript()))
  await until(async () => expect((await tab.run(status.latest.toArray)).map((row) => row.id)).toEqual([next.answerId]))
  expect((await transcript()).at(-1)).toBe(next.answerId)
  expect((await tab.run(status.latest.toArray))[0]).toMatchObject({ id: next.answerId, position: posted.position, state: "working" })
}, 120_000)

test("two rows at one place read in the order the shard holds them, on every query a page reads, never by their ids", async () => {
  const api = await openApi()
  // Postgres has stored messages before, as any deployment has: its places are past the few entries this shard holds.
  await Effect.runPromise(api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT setval(pg_get_serial_sequence('messages', 'position'), 1000)`))))
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const conversationId = await tab.show("feature")
  await exchange(api, tab, "First question", "First answer.")
  await until(async () => expect(await tab.shown(conversationId)).toEqual(["user done First question", "assistant done First answer."]))
  // A page's own post, straight to the conversation's shard: the shard places it after the exchange, where the next
  // message Postgres stores will be placed too. Its id sorts after every id Postgres gives.
  const OWNER = await ownerIn(conversationId, ada)
  const shard = `conv:${conversationId}`
  const posted = await api.shards!.fetchAs(ada)(`https://smithers.example/api/conversations/${conversationId}/messages/submit`, {
    method: "POST",
    body: JSON.stringify({
      version: 2, shard, epoch: 0,
      command: { key: [`${OWNER}/laptop`, "1"], stream: shard, payload: { _tag: "PostMessage", messageId: "zz-direct", author: OWNER, body: "Posted between" } },
    }),
  })
  expect(posted.status).toBe(200)
  await until(async () => expect((await tab.rows(conversationId)).map((row) => row.id)).toContain("zz-direct"))
  // The next exchange: Postgres gives its question the very place the shard gave the page's post.
  const next = await tab.actions.ask("Second question")
  if (!next.asked) throw new Error(next.reason)
  await until(async () => expect((await tab.rows(conversationId)).map((row) => row.id)).toContain(next.answerId))
  const rows = await tab.rows(conversationId)
  const direct = rows.find((row) => row.id === "zz-direct")!
  const question = rows.find((row) => row.id === next.questionId)!
  expect(question.position).toBe(direct.position)
  expect(next.questionId < "zz-direct").toBe(true)
  // The post was there first, so it reads first: in the conversation, in the window a page shows, newest first and
  // oldest first, and in everything the timeline spans.
  const whole = [
    "user done First question", "assistant done First answer.", "user done Posted between", "user done Second question", "assistant streaming ",
  ]
  const opened = tab.store.opened(conversationId)!
  const texts = (all: ReadonlyArray<{ readonly role: string; readonly status: string; readonly text: string }>) =>
    all.map(({ role, status, text }) => `${role} ${status} ${text}`)
  for (const query of [opened.latest, opened.shown, opened.everything]) query.tanstack.startSyncImmediate()
  await until(async () => expect(await tab.shown(conversationId)).toEqual(whole))
  await until(async () => expect(texts(await tab.run(opened.everything.toArray))).toEqual(whole))
  await until(async () => expect(texts(await tab.run(opened.shown.toArray))).toEqual(whole))
  await until(async () => expect(texts(await tab.run(opened.latest.toArray))).toEqual([...whole].reverse()))
  // A tab opened afterwards reads the same order from the shard.
  const later = await openOn(api, nodeDevice({ agent: api }), fromShard)
  expect(await later.show("feature")).toBe(conversationId)
  await until(async () => expect(await later.shown(conversationId)).toEqual(whole))
  const reopened = later.store.opened(conversationId)!
  reopened.shown.tanstack.startSyncImmediate()
  await until(async () => expect(texts(await later.run(reopened.shown.toArray))).toEqual(whole))
}, 120_000)

test("a conversation read a page at a time opens once it is whole: never on the first rows of several pages", async () => {
  const api = await openApi()
  const writer = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const conversationId = await writer.show("feature")
  await exchange(api, writer, "One", "First.")
  await exchange(api, writer, "Two", "Second.")
  const whole = ["user done One", "assistant done First.", "user done Two", "assistant done Second."]
  await until(async () => expect(await writer.shown(conversationId)).toEqual(whole))
  // A tab that reads the shard one entry a request: the rows arrive one change at a time, over a dozen requests.
  const tab = await openOn(api, nodeDevice({ agent: api }), { ...quick, shard: { follow: "20 millis", within: "2 seconds", limit: 1 } })
  // What its collection holds at the moment the conversation is marked opened, for every conversation it opens.
  const heldWhenOpened: Array<number> = []
  await tab.run(tab.store.forEachOpened((opened) =>
    Effect.gen(function* () {
      while (!Option.getOrThrow(yield* opened.history.get(HISTORY)).opened) yield* Effect.sleep(1)
      heldWhenOpened.push((yield* opened.messages.toArray).length)
    }).pipe(Effect.forkIn(tab.store.scope), Effect.asVoid)))
  expect(await tab.show("feature")).toBe(conversationId)
  await until(() => expect(heldWhenOpened.length).toBeGreaterThan(0))
  expect(heldWhenOpened).toEqual([4])
  expect(await tab.shown(conversationId)).toEqual(whole)
  expect(shardOf(tab.requests, conversationId).filter((request) => request.includes("limit=1")).length).toBeGreaterThan(4)
}, 120_000)

test("a cold unconfirmed session keeps home history unopened until its authorized first pull", async () => {
  const api = await openApi()
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard, path => path === SESSION_ROUTE ? "stall" : undefined)
  const owners = await tab.run(Effect.service(ConversationOwners))
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(owners.home()).toBeUndefined()
  expect(Option.getOrThrow(await tab.run(tab.store.history.get(HISTORY))).opened).toBe(false)
  expect(tab.requests.filter(request => /messages\/pull/.test(request))).toEqual([])
})

test.each([401, 403, 404])("a late home %s refuses A after the active home switched to B", async status => {
  const api = await openApi()
  const denials = readDenials()
  let home: string | undefined
  let armed = false
  let start!: () => void
  let finish!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const finished = new Promise<void>(resolve => { finish = resolve })
  const tab = await openOn(api, nodeDevice({ agent: api }), { ...fromShard, readDenials: denials }, () => undefined, network => denials.observing(async (input, init) => {
    const request = new Request(input, init)
    if (armed && new URL(request.url).pathname === `/api/conversations/${home}/messages/pull`) {
      armed = false
      start()
      await finished
      return new Response(null, { status })
    }
    return network(request)
  }))
  const owners = await tab.run(Effect.service(ConversationOwners))
  await until(() => expect(owners.home()).toBeDefined())
  home = owners.home()!
  await tab.run(tab.store.messages.whole)
  const other = await tab.show("other")
  armed = true
  await started
  const auth = await tab.run(Effect.service(AuthStore))
  await tab.run(auth.session.update("session", row => { row.homeConversationId = other }))
  await until(() => expect(owners.home()).toBe(other))
  finish()
  await until(() => expect(owners.refused(home!)).toBe(true))
  expect(owners.home()).toBe(other)
}, 120_000)

test("home refusal hides retained queued, unsent and optimistic pin text through reload without deleting delivery records", async () => {
  const api = await openApi()
  const device = nodeDevice({ agent: api })
  const tab = await openOn(api, device, fromShard)
  const owners = await tab.run(Effect.service(ConversationOwners))
  await tab.run(tab.store.messages.whole)
  const home = owners.home()!
  tab.store.pinned.tanstack.startSyncImmediate()
  tab.store.pinState.pendingState.tanstack.startSyncImmediate()
  tab.net.fault = path => path === QUESTIONS_ROUTE ? "offline" : undefined
  const asked = await tab.actions.ask("Queued private question")
  if (!asked.asked) throw new Error(asked.reason)
  const unsent = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Refused private question", queuedAt: Date.now(), reason: "refused" as const, homeConversationId: home }
  const kept = await tab.run(tab.store.unsent.insert(unsent))
  await tab.run(kept.persisted)
  const pending = { conversationId: "home", serverConversationId: home, personId: "", messageId: asked.questionId, changedAt: "", at: Date.now(), home: true, failed: false, awaitAdmission: true, text: "Pinned private preview" }
  await tab.run((await tab.run(tab.store.pinState.pending.insert(pending))).persisted)
  await until(() => expect(tab.queries.conversation.toArray.map(row => row.text)).toContain("Queued private question"))
  await until(() => expect(tab.queries.pinned.toArray.map(row => row.text)).toEqual(["Pinned private preview"]))
  tab.net.fault = path => path === QUESTIONS_ROUTE ? "offline" : path === `/api/conversations/${home}/messages/pull` ? 403 : undefined
  await until(() => expect(owners.refused(home)).toBe(true))
  const hidden = async (reader: typeof tab) => {
    expect(await reader.run(reader.store.conversation.toArray)).toEqual([])
    expect(await reader.run(reader.store.pinned.toArray)).toEqual([])
    expect(await reader.run(reader.store.pinState.pendingState.toArray)).toEqual([])
    expect((await reader.run(reader.store.asking.toArray)).map(row => row.text)).toContain("Queued private question")
    expect((await reader.run(reader.store.unsent.toArray)).map(row => row.text)).toContain("Refused private question")
    expect((await reader.run(reader.store.pinState.pending.toArray)).map(row => row.text)).toEqual(["Pinned private preview"])
  }
  await hidden(tab)
  await until(() => expect(device.stored("message-pin-pending")).toBe(1))
  await tab.close()
  const restored = await openOn(api, device, fromShard, () => "offline")
  restored.store.pinned.tanstack.startSyncImmediate()
  restored.store.pinState.pendingState.tanstack.startSyncImmediate()
  await until(async () => expect((await restored.run(restored.store.asking.toArray)).length).toBe(1))
  await restored.run(restored.store.unsent.restored)
  await restored.run(restored.store.pinState.pending.restored)
  await hidden(restored)
}, 120_000)

test("a new home grant cannot expose a retained view from the refused old home", async () => {
  const api = await openApi()
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  await tab.run(tab.store.messages.whole)
  const owners = await tab.run(Effect.service(ConversationOwners))
  const home = owners.home()!
  const other = await tab.show("other")
  const views = await tab.run(Effect.service(ViewsStore))
  const id = crypto.randomUUID()
  await sqlOn(api)(sql => sql`INSERT INTO views (id, template, props, conversation_id)
    VALUES (${id}, 'link', '{"url":"https://example.com/private"}'::jsonb, ${home})`)
  views.shownHome.tanstack.startSyncImmediate()
  await until(async () => expect((await tab.run(views.shownHome.toArray)).map(row => row.id)).toEqual([id]))
  owners.refuse(home)
  await tab.run(views.knowHome(other))
  await tab.run(owners.clear(other, owners.fence()))
  expect((await tab.run(views.views.toArray)).map(row => row.id)).toContain(id)
  expect((await tab.run(views.shownHome.toArray)).map(row => row.id)).toEqual([])
  expect(owners.refused(home)).toBe(true)
}, 120_000)

test("a Guest's denied home does not fail the connection on a readable branch", async () => {
  const runtime = openTestApp({ answers: false }, { actor: { ...member, role: "guest" } })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  api.branches.github.publish("octo", "hello", { defaultBranch: "main", branches: { main: shaOf("main"), feature: shaOf("feature") } })
  const branchId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  await sqlOn(api)(sql => sql`INSERT INTO branches (id, repo_id, name, mode, created_by)
    VALUES (${branchId}, 'github/octo/hello', 'feature', 'open', 'person-owner')`)
  await sqlOn(api)(sql => sql`INSERT INTO conversations (id, repo_id, branch_id)
    VALUES (${conversationId}, 'github/octo/hello', ${branchId})`)
  await sqlOn(api)(sql => sql`INSERT INTO branch_shares (branch_id, grantee, login, access)
    VALUES (${branchId}, 'person-member', 'member', 'view')`)
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  const owners = await tab.run(Effect.service(ConversationOwners))
  await until(() => expect(owners.home()).toBeDefined())
  await until(() => expect(owners.refused(owners.home()!)).toBe(true))
  expect(await tab.show("feature")).toBe(conversationId)
  await tab.run(tab.store.opened(conversationId)!.messages.whole)
  await until(() => expect(tab.connection()).toMatchObject({ status: "up", retry: false }))
  expect(Option.getOrThrow(await tab.run(tab.store.history.get(HISTORY))).opened).toBe(true)
}, 120_000)

test.each([false, true])("a newly admitted home never adopts retained local text with no recorded home origin (populated: %s)", async populated => {
  const api = await openApi()
  const tab = await openOn(api, nodeDevice({ agent: api }), fromShard)
  await tab.run(tab.store.messages.whole)
  if (populated) {
    const asked = await tab.actions.ask("Current home content")
    if (!asked.asked) throw new Error(asked.reason)
    await tab.run(tab.store.messages.awaitRow(row => row.id === asked.questionId, "5 seconds"))
    await until(() => expect(tab.queries.conversation.toArray.map(row => row.text)).toContain("Current home content"))
  }
  tab.store.pinned.tanstack.startSyncImmediate()
  tab.store.pinState.pendingState.tanstack.startSyncImmediate()
  const id = crypto.randomUUID()
  const kept = await tab.run(tab.store.unsent.insert({ id, answerId: crypto.randomUUID(), text: "Unknown old home question", queuedAt: 1, reason: "not_admitted" }))
  await tab.run(kept.persisted)
  const intent = await tab.run(tab.store.pinState.pending.insert({ conversationId: "home", personId: "", messageId: id, changedAt: "", at: 1, home: true, failed: false, awaitAdmission: true, text: "Unknown old home preview" }))
  await tab.run(intent.persisted)
  // Projection can retain delivery intent under its effective key, but that is never a preview admission.
  await until(async () => expect((await tab.run(tab.store.pinState.effective.toArray)).find(row => row.messageId === id)?.conversationId)
    .toBe(populated ? tab.store.home() : "home"))
  expect((await tab.run(tab.store.conversation.toArray)).map(row => row.text)).not.toContain("Unknown old home question")
  expect(await tab.run(tab.store.pinned.toArray)).toEqual([])
  expect(await tab.run(tab.store.pinState.pendingState.toArray)).toEqual([])
  expect((await tab.run(tab.store.unsent.toArray)).map(row => row.text)).toEqual(["Unknown old home question"])
  expect((await tab.run(tab.store.pinState.pending.toArray)).map(row => row.text)).toEqual(["Unknown old home preview"])
}, 120_000)

test.each([
  { retained: false, known: false },
  { retained: true, known: false },
  { retained: true, known: true },
])("a local pin preserves its recorded origin without adopting the current home (retained: $retained, known: $known)", async ({ retained, known }) => {
  const { openFaultyTab } = await import("../../test/chatApi")
  const { EngineFaults } = await import("../../test/faults")
  const api = await openApi()
  const tab = openFaultyTab(api, { host: nodeDevice({ agent: api }) })
  runtimes.push(tab)
  const chat = await tab.runPromise(Effect.service(Chat))
  const store = await tab.runPromise(Effect.service(ChatStore))
  await tab.runPromise(store.messages.whole)
  const origin = store.home()!
  expect(origin).toBeDefined()
  const current = await tab.runPromise(api.askElsewhere("Current home content"))
  await until(async () => expect((await tab.runPromise(store.messages.toArray)).some(row => row.id === current.questionId)).toBe(true))
  store.pinned.tanstack.startSyncImmediate()
  await tab.runPromise(Effect.flatMap(EngineFaults, faults => faults.holdStarts))
  const id = crypto.randomUUID()
  await tab.runPromise(store.unsent.insert({
    id, answerId: crypto.randomUUID(), text: "Older local question", queuedAt: 1, reason: "not_admitted",
    ...(known ? { homeConversationId: origin } : {}),
  }))
  if (retained) await tab.runPromise(store.pinState.pending.insert({
    conversationId: "home", personId: "", messageId: id, changedAt: "", at: 1,
    home: true, failed: true, awaitAdmission: true, text: "Retained preview",
    ...(known ? { serverConversationId: origin } : {}),
  }))
  if (known) {
    chat.actions.discardUnsent(id)
    await until(async () => expect(await tab.runPromise(store.unsent.toArray)).toEqual([]))
  }
  chat.actions.pin(id, true)
  await until(async () => expect((await tab.runPromise(store.pinState.pending.toArray))[0]).toMatchObject({
    failed: false, awaitAdmission: true, text: known ? "Retained preview" : "Older local question",
  }))
  const pending = (await tab.runPromise(store.pinState.pending.toArray))[0]!
  expect(pending.serverConversationId).toBe(known ? origin : undefined)
  await until(async () => expect((await tab.runPromise(store.pinned.toArray)).map(row => row.text)).toEqual(known ? ["Retained preview"] : []))
  if (!known) expect((await tab.runPromise(store.unsent.toArray)).map(row => row.text)).toEqual(["Older local question"])
}, 120_000)
