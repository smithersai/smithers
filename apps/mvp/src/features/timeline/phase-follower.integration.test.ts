import { SyncPolicy } from "@smthrs/effect-electric"
import { Deferred, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test, vi } from "vitest"
import { OPENAI_ORIGIN } from "../../../worker/personal/test/provider.ts"
import { member, nodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"
import { PersonalModel } from "../personal-model/personalModel"

// Real Postgres, Electric and browser-hosted durable flows. Only the model's provider is scripted.
test("the phase follower persists one open goal across the rolling input window", async () => {
  let api: TestChatApi["Service"] | undefined
  const answer = "Checkout validation passed all regression tests."
  const root = openTestApp({ answers: false }, {
    actor: member,
    provider: index => {
      const input = JSON.stringify(api?.providerCalls[index]?.body ?? {})
      return { text: input.includes("You divide")
        ? JSON.stringify({ spans: [{ from: 1, title: "Fixing checkout validation", summary: answer }] })
        : input.includes("navigation summary") ? "Checkout validation regression tests passed"
        : "```cell\nctx.done(" + JSON.stringify(answer) + ")\n```" }
    },
  })
  let tab: ReturnType<typeof openTab> | undefined
  const until = (check: () => void) => vi.waitFor(check, { timeout: 30_000, interval: 25 })
  try {
    api = await root.runPromise(Effect.service(TestChatApi))
    const shapeFailures: Array<{ path: string; status: number; fields: string[]; reason: string }> = []
    // Preserve the real response. Record only field names and a fixed category, never a response body or user data.
    const observed = { ...api, fetch: (async (input, init) => {
      const response = await api!.fetch(input, init)
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (path.startsWith("/api/shapes/") && response.status >= 400 && shapeFailures.length < 3) {
        const text = await response.clone().text()
        let fields: string[] = []
        try {
          const body = JSON.parse(text)
          fields = Object.keys(body).concat(body.errors && typeof body.errors === "object" ? Object.keys(body.errors).map(key => `errors.${key}`) : [])
        } catch { fields = ["non-json"] }
        const reason = /secret|source_id|unauthorized/i.test(text) ? "source-auth"
          : /column.*not.*exist|unknown column/i.test(text) ? "missing-column"
          : /does not exist|unknown table|unknown relation/i.test(text) ? "missing-relation"
          : /offset/i.test(text) ? "invalid-offset" : /where|param/i.test(text) ? "invalid-filter" : "shape-refused"
        shapeFailures.push({ path, status: response.status, fields, reason })
      }
      return response
    }) as typeof api.fetch }
    tab = openTab(observed, { host: nodeDevice({ agent: api }), retry: SyncPolicy.backoff({ initial: "20 millis", max: "50 millis" }) })
    const chat = await tab.runPromise(Effect.service(Chat))
    const store = await tab.runPromise(Effect.service(ChatStore))
    for (const query of [store.shown, store.latest, store.everything]) query.tanstack.startSyncImmediate()
    const model = await tab.runPromise(Effect.service(PersonalModel))
    for (const query of Object.values(model.queries)) query.startSyncImmediate()
    expect(model.actions.save({
      connections: [{ kind: "api_key", protocol: "openai-chat", baseUrl: `${OPENAI_ORIGIN}/v1/`, key: "sk-test-phase-follower", models: { fast: "gpt-test" } }],
    })).toBe(true)
    await until(() => expect(model.queries.form.toArray[0], JSON.stringify(shapeFailures)).toMatchObject({ state: "done" }))
    let first: string | undefined
    for (let n = 0; n < 6; n++) {
      const asked = await chat.actions.ask(`Check checkout validation case ${n}`)
      if (!asked.asked) throw new Error(asked.reason)
      first ??= asked.questionId
      await until(() => expect(chat.queries.conversation.toArray.find(row => row.id === asked.answerId)).toMatchObject({ status: "done", text: answer }))
    }
    await until(() => {
      const phase = store.messages.tanstack.get(first!)?.phase
      expect(phase).toBeTruthy()
      expect(JSON.parse(phase!)).toMatchObject({ title: "Fixing checkout validation", summary: answer, closed: false, covered: 4 })
    })
    const phaseCalls = () => api!.providerCalls.filter(call => JSON.stringify(call.body).includes("You divide")).length
    expect(phaseCalls()).toBe(1)
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
    expect(phaseCalls()).toBe(3)
    expect(await tab.runPromise(Deferred.isDone(store.summaryLane.stopped))).toBe(false)
    await tab.runPromise(Effect.sleep("3500 millis"))
    expect(phaseCalls()).toBe(3)
  } finally {
    await tab?.dispose()
    await root.dispose()
  }
}, 180_000)
