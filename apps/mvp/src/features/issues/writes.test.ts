import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, Logger, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import { boundFetch } from "../../device/identity"
import { OutboxWrites } from "../../outbox"
import { SESSION_ROUTE } from "../auth/contract"
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
  const client = Layer.succeed(IssuesClient, IssuesClient.of({ search: () => Effect.die("no search"), write: () => { sent++; return Effect.die("malformed write reached transport") } }))
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
  const client = Layer.succeed(IssuesClient, IssuesClient.of({ search: () => Effect.die("no search"), write: () => { sent++; return Effect.die("unrenewable write reached transport") } }))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const writes = yield* OutboxWrites
    const issues = yield* IssueWrites
    expect(yield* Effect.result(writes.mutations[ISSUE_WRITE]!({ rows: [{ ...row, credential: "opaque-legacy-credential" }] } as never)))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "Refused", status: 403 } })
    expect(yield* issues.requested.get(row.id)).toMatchObject({ value: { status: "not_sent", reason: "forbidden" } })
  }).pipe(Effect.provide(IssueWrites.layer.pipe(Layer.provide(client), Layer.provide(Persistence.memory))))))
  expect(sent).toBe(0)
})

test("a 401 holds a write sent in the person's session, never one sent with its run's credential", async () => {
  const origin = "http://issues.test"
  // ChatApi can't tell who asked: every write is refused 401, while the session still names Alice.
  const next: typeof fetch = async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname
    if (path === SESSION_ROUTE) return Response.json({ signedIn: true, personId: "alice", login: "alice", role: "member" })
    if (path.endsWith("/credential")) return Response.json({ token: "renewed-proof" })
    return Response.json({ code: "authentication" }, { status: 401 })
  }
  const transport = boundFetch(next, { origin, principal: () => "alice", reauthorize: async () => true })
  const client = IssuesClient.layer({ origin, within: "5 seconds" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, transport)),
  )
  const credential = `${Buffer.from(JSON.stringify({ run: "answer-1", chain: ["issue/create"] })).toString("base64url")}.sig`
  const [session, run, kept] = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const writes = yield* OutboxWrites
    const { requested } = yield* IssueWrites
    const send = (sent: Sending) => Effect.result(writes.mutations[ISSUE_WRITE]!({ rows: [sent], idempotencyKey: sent.id }))
    const session = yield* send({ ...row, id: "session" })
    const run = yield* send({ ...row, id: "run", credential })
    return [session, run, [yield* requested.get("session"), yield* requested.get("run")]] as const
  }).pipe(Effect.provide(IssueWrites.layer.pipe(Layer.provide(client), Layer.provide(Persistence.memory))))))
  // The person's write is held for their sign-in: sent again, and not Not sent.
  expect(session).toMatchObject({ _tag: "Failure", failure: { _tag: "Retry", status: 401 } })
  expect(kept[0]).toEqual(Option.none())
  // The run's 401 is about the run: Not sent, as before.
  expect(run).toMatchObject({ _tag: "Failure", failure: { _tag: "Refused", status: 401 } })
  expect(kept[1]).toEqual(Option.some(expect.objectContaining({ status: "not_sent", reason: "authentication" })))
})
