// The statements ChatApi runs on `messages` (worker/Messages.ts), against the compose Postgres in this file's own schema.
import { Deferred, Effect, Fiber } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { beforeAll, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as Messages from "./Messages.ts"
import { eventually, homeConversation, row, rowCount, testFile, uuid } from "./test/harness.ts"

const runtime = testFile("messages")

/** The conversation every question here is asked in: the home conversation, as an ask that names none. */
let conversationId: string
beforeAll(async () => {
  conversationId = await homeConversation(runtime)
})

/** Who asks, unless a test says otherwise: a person id, as ChatApi takes it from the session. */
const asker = "person-asker"

/** Runs `effect` on a connection of its own, as ChatApi does for each request. */
const alone = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const scratch = yield* TestDatabase.Scratch
      return yield* Effect.provide(effect, scratch.database)
    }),
  )

/** Settles a streaming answer with `text`, to set up the completed-answer case. */
const settle = (answerId: string, text: string) =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`UPDATE messages SET status = 'done', text = ${text}
          WHERE id = ${answerId} AND status = 'streaming'`,
    ),
  )

/** The ids of every message, in the conversation's order. */
const order = () =>
  runtime.runPromise(
    Effect.map(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly id: string }>`SELECT id FROM messages ORDER BY position`,
      ),
      (rows) => rows.map((found) => found.id),
    ),
  )

/** Every message's id and asker, in the conversation's order. */
const askers = () =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{ readonly id: string; readonly askedBy: string | null }>`
          SELECT id, asked_by AS "askedBy" FROM messages ORDER BY position`,
    ),
  )

describe("ask", () => {
  test("inserts the question and its empty streaming answer in one transaction, the answer next", async () => {
    const ids = { id: uuid(), answerId: uuid() }
    const asked = await runtime.runPromise(Messages.ask({ ...ids, text: "Say hi.", askedBy: asker, conversationId }))
    const question = await row(runtime, ids.id)
    const answer = await row(runtime, ids.answerId)
    expect(question).toMatchObject({
      role: "user",
      text: "Say hi.",
      status: "done",
      questionId: null,
      xmin: asked.txid,
    })
    expect(answer).toMatchObject({
      role: "assistant",
      text: "",
      status: "streaming",
      questionId: ids.id,
      xmin: asked.txid,
      position: question.position + 1,
    })
  })

  test("a later pair cannot commit ahead of an earlier allocated pair", async () => {
    const first = { id: uuid(), answerId: uuid() }
    const second = { id: uuid(), answerId: uuid() }
    const locked = await runtime.runPromise(Deferred.make<void>())
    const go = await runtime.runPromise(Deferred.make<void>())
    const other = runtime.runFork(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* Messages.ask({ ...first, text: "first", askedBy: asker, conversationId })
        yield* Deferred.succeed(locked, undefined)
        yield* Deferred.await(go)
      }))
    }))
    await runtime.runPromise(Deferred.await(locked))
    const asking = alone(Messages.ask({ ...second, text: "second", askedBy: asker, conversationId }))
    try {
      // Wait for the second connection either to block or to commit. The old
      // implementation commits, making an invisible predecessor bypassable.
      await eventually(async () => {
        if ((await order()).includes(second.id)) return true
        return runtime.runPromise(Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const scratch = yield* TestDatabase.Scratch
          const rows = yield* sql`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND a.application_name = ${scratch.name}`
          return rows.length > 0
        }))
      })
      expect(await order()).not.toContain(second.id)
    } finally {
      await runtime.runPromise(Deferred.succeed(go, undefined))
      await runtime.runPromise(Fiber.join(other))
      await asking
    }
    expect(await order()).toEqual([first.id, first.answerId, second.id, second.answerId])
  })

  test("a retry of the same question changes nothing, whether its answer streams or has settled", async () => {
    const question = { id: uuid(), answerId: uuid(), text: "Ask me once.", askedBy: asker, conversationId }
    await runtime.runPromise(Messages.ask(question))
    expect(await runtime.runPromise(Messages.ask(question))).toEqual({ txid: null })
    await settle(question.answerId, "Once.")
    expect(await runtime.runPromise(Messages.ask(question))).toEqual({ txid: null })
    expect(await rowCount(runtime)).toBe(2)
    expect(await row(runtime, question.answerId)).toMatchObject({ status: "done", text: "Once." })
  })

  test("records the asker on the question only, and the same question from another person is IdTaken", async () => {
    const question = { id: uuid(), answerId: uuid(), text: "Whose is this?", askedBy: asker, conversationId }
    await runtime.runPromise(Messages.ask(question))

    const error = await runtime.runPromise(Effect.flip(Messages.ask({ ...question, askedBy: "person-other", conversationId })))

    expect(error).toBeInstanceOf(Messages.IdTaken)
    expect(await askers()).toEqual([
      { id: question.id, askedBy: asker },
      { id: question.answerId, askedBy: null },
    ])
  })

  test("an answer id another message has fails the statement, and the question isn't written either", async () => {
    const answerId = uuid()
    await runtime.runPromise(Messages.ask({ id: uuid(), answerId, text: "first", askedBy: asker, conversationId }))
    const clash = uuid()
    const error = await runtime.runPromise(Effect.flip(Messages.ask({ id: clash, answerId, text: "second", askedBy: asker, conversationId })))
    expect(SqlError.isSqlError(error) && error.reason._tag).toBe("UniqueViolation")
    expect(await rowCount(runtime)).toBe(2)
    expect(await order()).not.toContain(clash)
  })
})
