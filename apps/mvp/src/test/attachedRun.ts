import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, vi } from "vitest"
import { RUNS_ROUTE } from "../features/status/contract"
import type { Need, Report } from "../features/status/schema"
import type { TestChatApi } from "./chatApi"

const query = <A, E>(api: TestChatApi["Service"], effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(api.github.run(effect))

const questionFor = (api: TestChatApi["Service"], answerId: string) =>
  vi.waitFor(async () => {
    const [answer] = await query(api, Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ question_id: string }>`
      SELECT question_id FROM messages WHERE id = ${answerId}`))
    expect(answer, "ChatApi stored the question and answer").toBeDefined()
    return answer!.question_id
  }, { timeout: 15_000, interval: 20 })

export const reportRun = async (api: TestChatApi["Service"], answerId: string, report: Report) => {
  await questionFor(api, answerId)
  const response = await api.fetch(`${api.origin}${RUNS_ROUTE}/${answerId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  })
  expect(await response.json(), `Run report returned HTTP ${response.status}`).toEqual({ txid: expect.any(Number) })
  expect(response.status).toBe(200)
}

export const waitOnPerson = (api: TestChatApi["Service"], answerId: string, need: Need) =>
  reportRun(api, answerId, { status: "needs_you", wait: { ...need, execution: crypto.randomUUID(), options: need.options ?? [] } })

export const personAnswered = (api: TestChatApi["Service"], answerId: string) =>
  vi.waitFor(async () => {
    const [row] = await query(api, Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ answer: unknown }>`
      SELECT answer FROM runs WHERE id = ${answerId}`))
    expect(row?.answer).toMatchObject({ value: expect.anything() })
  }, { timeout: 30_000, interval: 20 })

export const finishRun = async (api: TestChatApi["Service"], answerId: string, text: string, answered = false) => {
  if (answered) await personAnswered(api, answerId)
  const agent = await Effect.runPromise(api.attachFor(await questionFor(api, answerId)))
  expect(await agent.respond(text)).toEqual({ answered: true, answerId })
  await reportRun(api, answerId, { status: "done" })
}

/** Load an existing transcript with a model failure recorded before BYOA. */
export const recordedModelFailure = async (api: TestChatApi["Service"], answerId: string) => {
  await questionFor(api, answerId)
  await query(api, Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    UPDATE messages SET status = 'failed', failure = 'model_error', updated_at = now() WHERE id = ${answerId}`))
}

export const latestAnswerFor = (api: TestChatApi["Service"], text: string, earlierAnswer: string) =>
  vi.waitFor(async () => {
    const [row] = await query(api, Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ id: string }>`
      SELECT a.id FROM messages a JOIN messages q ON a.question_id = q.id
      WHERE q.text = ${text} AND a.id <> ${earlierAnswer} ORDER BY q.position DESC LIMIT 1`))
    expect(row, "ChatApi stored the retried question").toBeDefined()
    return row!.id
  }, { timeout: 15_000, interval: 20 })
