import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, Logger } from "effect"
import { expect, test } from "vitest"
import { OutboxWrites } from "../../outbox"
import { IssuesClient } from "./api"
import { Requested, type Sending } from "./schema"
import { ISSUE_WRITE, IssueWrites, keep, keepParked } from "./writes"

const row: Sending = { id: "w", repo: "octo/hello", repoId: "github/octo/hello", op: "issue/create", title: "t", body: "", number: 0, queuedAt: 1, v: 3 }

test("failed persistence keeps a refused write retryable", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const real = yield* Collection.local<Requested, string>({ id: crypto.randomUUID(), schema: Requested, getKey: (r) => r.id })
    // Fault injection at the Effect collection boundary: the device refuses persistence.
    const faulty: Collection.Collection<Requested, string> = { ...real, insert: (value) => real.insert(value).pipe(Effect.map((transaction) => ({ ...transaction, persisted: Effect.fail(new Collection.TransactionFailed({ cause: "disk full" })) }))) }
    return yield* Effect.result(keep(faulty, row, "not_sent", "forbidden"))
  })))
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Retry" } })
})

test.each([undefined, {}, { ...row, repo: null }, { ...row, op: "pr/merge" }, { ...row, op: "issue/triage" }, { ...row, op: "issue/commitment" }])("malformed restored rows never reach the transport: %j", async (restored) => {
  let sent = 0
  const client = Layer.succeed(IssuesClient, IssuesClient.of({ write: () => { sent++; return Effect.die("malformed write reached transport") } }))
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const writes = yield* OutboxWrites
    return yield* Effect.result(writes.mutations[ISSUE_WRITE]!({ rows: [restored] } as never))
  }).pipe(Effect.provide(IssueWrites.layer.pipe(Layer.provide(client), Layer.provide(Persistence.memory))))))
  expect(sent).toBe(0)
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Refused", status: 400 } })
})

test("parked writes stay parked after storage failure and settle after persistence recovers", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const real = yield* Collection.local<Requested, string>({ id: crypto.randomUUID(), schema: Requested, getKey: (r) => r.id })
    const faulty: Collection.Collection<Requested, string> = { ...real, insert: (value) => real.insert(value).pipe(Effect.map((transaction) => ({ ...transaction, persisted: Effect.fail(new Collection.TransactionFailed({ cause: "disk full" })) }))) }
    const parked = { id: row.id, name: ISSUE_WRITE, reason: "version", rows: [row] }
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logged = Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))]))
    expect(yield* keepParked(faulty, parked).pipe(logged)).toBe(false)
    // Not kept: logged once with the device's code, never the write's text.
    expect(logs).toEqual([expect.objectContaining({
      message: "issues.write.parked.keep",
      level: "WARN",
      annotations: expect.objectContaining({ feature: "issues", outcome: "not_kept", errorCode: "TransactionFailed", writeId: row.id, op: row.op }),
    })])
    expect(yield* keepParked(real, parked)).toBe(true)
  })))
})

test("an opaque restored credential keeps its forbidden refusal without transport", async () => {
  let sent = 0
  const client = Layer.succeed(IssuesClient, IssuesClient.of({ write: () => { sent++; return Effect.die("unrenewable write reached transport") } }))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const writes = yield* OutboxWrites
    const issues = yield* IssueWrites
    expect(yield* Effect.result(writes.mutations[ISSUE_WRITE]!({ rows: [{ ...row, credential: "opaque-legacy-credential" }] } as never)))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "Refused", status: 403 } })
    expect(yield* issues.requested.get(row.id)).toMatchObject({ value: { status: "not_sent", reason: "forbidden" } })
  }).pipe(Effect.provide(IssueWrites.layer.pipe(Layer.provide(client), Layer.provide(Persistence.memory))))))
  expect(sent).toBe(0)
})
