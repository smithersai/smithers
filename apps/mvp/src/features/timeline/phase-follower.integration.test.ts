import { SyncPolicy } from "@smthrs/effect-electric"
import { Model, type ModelEvent } from "@smthrs/model"
import { Deferred, Effect, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test, vi } from "vitest"
import { nodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"

// Real Postgres, Electric and browser-hosted durable flows. Only the model's provider is scripted.
test("the phase follower persists one open goal across the rolling input window", async () => {
  const answer = "Checkout validation passed all regression tests."
  let phaseCalls = 0
  const summaryModel = Model.make({
    stream: request => {
      const phases = request.system.some(({ text }) => text.includes("You divide"))
      if (phases) phaseCalls++
      return Stream.fromIterable<ModelEvent.ModelEvent>([
        { type: "text-delta", id: "summary", text: phases
          ? JSON.stringify({ spans: [{ from: 1, title: "Fixing checkout validation", summary: answer }] })
          : "Check checkout validation regression tests" },
        { type: "settle", stopReason: "stop" },
      ])
    },
  })
  const root = openTestApp({ answers: false })
  let tab: ReturnType<typeof openTab> | undefined
  const until = (check: () => void) => vi.waitFor(check, { timeout: 30_000, interval: 25 })
  try {
    const api = await root.runPromise(Effect.service(TestChatApi))
    tab = openTab(api, {
      host: nodeDevice({ agent: api, summaryModel }),
      retry: SyncPolicy.backoff({ initial: "20 millis", max: "50 millis" }),
    })
    const chat = await tab.runPromise(Effect.service(Chat))
    const store = await tab.runPromise(Effect.service(ChatStore))
    for (const query of [store.shown, store.latest, store.everything]) query.tanstack.startSyncImmediate()
    let first: string | undefined
    for (let n = 0; n < 6; n++) {
      const asked = await chat.actions.ask(`Check checkout validation case ${n}`)
      if (!asked.asked) throw new Error(asked.reason)
      first ??= asked.questionId
      const agent = await root.runPromise(api.attachFor(asked.questionId))
      expect(await agent.respond(answer)).toEqual({ answered: true, answerId: asked.answerId })
      await until(() => expect(chat.queries.conversation.toArray.find(row => row.id === asked.answerId)).toMatchObject({ status: "done", text: answer }))
    }
    await until(() => {
      const phase = store.messages.tanstack.get(first!)?.phase
      expect(phase).toBeTruthy()
      expect(JSON.parse(phase!)).toMatchObject({ title: "Fixing checkout validation", summary: answer, closed: false, covered: 4 })
    })
    expect(phaseCalls).toBe(1)
    // Seed settled exchanges on real Postgres in one transaction. Electric delivers the backlog as it would another
    // device's recorded conversation; the real follower, durable engine, model step and HTTP ledger do all the rest.
    await root.runPromise(api.github.run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(Effect.gen(function* () {
        const [conversation] = yield* sql<{ conversationId: string }>`SELECT conversation_id AS "conversationId" FROM messages WHERE id = ${first!}`
        for (let n = 6; n < 28; n++) {
          const questionId = crypto.randomUUID(), answerId = crypto.randomUUID()
          yield* sql`INSERT INTO messages (id, role, text, status, conversation_id)
            VALUES (${questionId}, 'user', ${`Check checkout validation case ${n}`}, 'done', ${conversation!.conversationId})`
          yield* sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id)
            VALUES (${answerId}, 'assistant', ${answer}, 'done', ${questionId}, ${conversation!.conversationId})`
        }
      }))
    })))
    await vi.waitFor(() => {
      const marks = store.messages.tanstack.toArray.flatMap(row => row.phase ? [JSON.parse(row.phase)] : [])
      expect(marks).toHaveLength(1)
      expect(marks[0]).toMatchObject({ title: "Fixing checkout validation", summary: answer, closed: false, covered: 28 })
    }, { timeout: 60_000, interval: 50 })
    // Coverage advances 4 → 24 → 28 through the weighted durable payload and the server's real recording path.
    expect(phaseCalls).toBe(3)
    expect(await tab.runPromise(Deferred.isDone(store.summaryLane.stopped))).toBe(false)
    await tab.runPromise(Effect.sleep("3500 millis"))
    expect(phaseCalls).toBe(3)
  } finally {
    await tab?.dispose()
    await root.dispose()
  }
}, 180_000)
