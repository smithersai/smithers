import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Exit, Layer, Logger, Metric, Tracer } from "effect"
import { expect, test } from "vitest"
import { ChatDraftsStore } from "../../device/registry"
import { nodeDevice } from "../../test/chatApi"
import { persistDraft } from "./draftWrite"
import { draftWrites } from "./metrics"
import { HOME_DRAFT } from "./schema"

test.each([false, true])("draft persistence records correlated stages without content (disk fails: %s)", async (fault) => {
  const host = nodeDevice()
  let failWrites = false
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({ span: (options) => {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  } })
  const records: Array<{ message: unknown; level: string; attributes: Record<string, unknown> }> = []
  const logger = Logger.make((entry) => {
    const formatted = Logger.formatStructured.log(entry)
    records.push({ message: formatted.message, level: formatted.level, attributes: formatted.annotations })
  })
  const persistence = Persistence.layer({
    ...host.persistence,
    open: async () => {
      const database = await host.persistence.open()
      return { ...database, execute: <T>(sql: string, params?: ReadonlyArray<unknown>) =>
        failWrites && /INSERT INTO/i.test(sql)
          ? Promise.reject(new Error("private disk detail"))
          : database.execute<T>(sql, params) }
    },
  })
  const key = fault ? "branch-draft" : HOME_DRAFT
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const drafts = yield* Collection.persisted(ChatDraftsStore)
    yield* drafts.restored
    failWrites = fault
    const write = yield* drafts.insert({ id: key, text: "private draft text" })
    const before = yield* Metric.value(Metric.withAttributes(draftWrites, { stage: fault ? "failed" : "stored" }))
    const exit = yield* Effect.exit(persistDraft(write, key))
    const after = yield* Metric.value(Metric.withAttributes(draftWrites, { stage: fault ? "failed" : "stored" }))
    expect(after.count - before.count).toBe(1)
    return { writeId: write.id, exit }
  })).pipe(Effect.provide(Layer.merge(persistence, Logger.layer([logger]))), Effect.provideService(Tracer.Tracer, tracer)))
  expect(Exit.isFailure(result.exit)).toBe(fault)
  const stages = records.filter(({ message }) => String(message).startsWith("chat draft "))
  expect(stages.map(({ message }) => message)).toEqual(["chat draft saving", fault ? "chat draft failed" : "chat draft stored"])
  expect(stages.map(({ attributes }) => attributes)).toEqual([
    { feature: "chat", transactionId: result.writeId, conversation: fault ? "branch" : "home" },
    {
      feature: "chat",
      transactionId: result.writeId,
      conversation: fault ? "branch" : "home",
      // A failed write is named by its code, so the counting logger counts it; never the disk's message.
      ...(fault ? { outcome: "failed", errorCode: "TransactionFailed" } : {}),
    },
  ])
  expect(stages.map(({ level }) => level)).toEqual(["INFO", fault ? "WARN" : "INFO"])
  expect(JSON.stringify(records)).not.toContain("private")
  const saved = spans.filter((span) => span.name === "chat.draft.save")
  expect(saved).toHaveLength(1)
  expect(saved[0]!.attributes.get("outcome")).toBe(fault ? "Failure" : "Success")
  expect(saved[0]!.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Success" } })
  expect(JSON.stringify([...saved[0]!.attributes])).not.toContain("private")
  expect(JSON.stringify(saved[0]!.events)).not.toContain("private")
  await host.wipe()
})
