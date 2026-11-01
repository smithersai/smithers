import { Action, FlowRuntime } from "@smthrs/flow"
import { EngineStore, RunStore } from "@smthrs/flows"
import { Model, ModelError, type ModelEvent } from "@smthrs/model"
import { Cause, Context, Deferred, Effect, Exit, Layer, Metric, Scope, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, expect, test } from "vitest"
import { ClientEngine, FlowDispatch } from "../src/flows/dispatch.ts"
import { FlowRegistry } from "../src/flows/registry.ts"
import { Phases, Summarize, SummaryFailed } from "../src/features/timeline/flow.ts"
import { segmentRevision } from "../src/features/timeline/identity.ts"
import { phaseRetry, summaryRetry } from "../src/features/timeline/store.ts"
import { registration, SummaryLedger, SummarySeat } from "../src/features/timeline/steps.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import { build, type HostOptions } from "./test/flowHost.ts"
import { answers, harness, testFile } from "./test/harness.ts"

// The timeline's durable flows on the real ledger: ChatApi's route over Postgres, each device with its own durable
// engine, faults injected at a service, and no ledger stand-in, because races and restarts are what the ledger is for.

const runtime = testFile("timeline_engine")
const scopes: Array<Scope.Closeable> = []
afterEach(async () => { for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void)) })
const person = (id: string) => ({ subject: { kind: "person" as const, id }, role: "member" as const })
const actor = person("engine-person")
const sql = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use))
type Server = Awaited<ReturnType<typeof harness>>

/** The real `SummaryLedger` client, talking to `server`'s real route. */
const ledgerOn = (server: Server) => SummaryLedger.layer("http://chat.test").pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(request =>
  Effect.promise(async () => {
    const url = new URL(request.url)
    const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
    return HttpClientResponse.fromWeb(request, await server.fetch(url.pathname, { method: request.method, ...(body === undefined ? {} : { body }) }))
  })))))
/** A model that writes `text`, counting its calls. */
const writing = (text: string) => {
  const model = { calls: 0, model: Model.make({ stream: () => {
    model.calls++
    return Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "s", text }, { type: "settle", stopReason: "stop" }])
  } }) }
  return model
}
/** A device: its own durable engine and dispatch, over `ledger` and `model`. */
const device = async (ledger: Layer.Layer<SummaryLedger>, model: Model.Model, options: HostOptions = {}, scope = Effect.runSync(Scope.make())) => {
  scopes.push(scope)
  const { context, engine } = await Effect.runPromise(Scope.provide(scope)(build(registration.pipe(
    Layer.provide(Layer.merge(SummarySeat.layer("http://chat.test", model), ledger)), Layer.provideMerge(Action.layerImplementations),
  ), options)))
  const server = await Effect.runPromise(TestDatabase.serverUrl)
  const inspection = EngineStore.RunInspection.layer.pipe(Layer.provide(ExecutionHost.readDatabase(server.toString(), engine.schema)))
  const dispatching = await Effect.runPromise(Scope.provide(scope)(Layer.build(
    FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer), Layer.provide(ClientEngine.layerRuntime([Summarize, Phases])), Layer.provide(Layer.merge(Layer.succeedContext(context), inspection))),
  )))
  const on = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect.pipe(Effect.provide(context as Context.Context<never>), Effect.provideService(Metric.MetricRegistry, new Map())))
  return { scope, engine, runtime: Context.get(context, FlowRuntime.FlowRuntime), dispatch: Context.get(dispatching, FlowDispatch), on }
}

/** A conversation of its own with `count` finished exchanges: their questions' ids and one answer's. */
const conversation = async (count: number) => {
  const { tracked } = await import("./test/branch.ts")
  const { conversationId } = await tracked(runtime, "github/octocat/spoon-knife", `engine-${crypto.randomUUID()}`, "open")
  const questions: Array<string> = []
  let answer = ""
  for (let n = 0; n < count; n++) {
    const question = crypto.randomUUID()
    answer = crypto.randomUUID()
    await sql(sql => sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${question}, 'user', 'Did it retry?', 'done', ${conversationId})`)
    await sql(sql => sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id) VALUES (${answer}, 'assistant', 'It retried.', 'done', ${question}, ${conversationId})`)
    questions.push(question)
  }
  return { questions, answer }
}
const REVISION = "ab".repeat(32)
const summaryOf = (id: string) => ({ id, revision: REVISION, role: "assistant" as const, text: "It retried twice.", reason: "answer" as const })
const planOver = (ids: ReadonlyArray<string>) => ({
  level: 1 as const, anchorId: ids[0]!, revision: segmentRevision(ids[0]!, 1, ids.length), items: ids.map(id => ({ id, text: "Asked: a" })), full: false,
})
const stored = (id: string) => sql(sql => sql<{ readonly summary: string | null; readonly phase: string | null }>`SELECT summary, phase FROM messages WHERE id = ${id}`).then(rows => rows[0]!)
const attempts = (messageId: string) => sql(sql => sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM timeline_attempts WHERE message_id = ${messageId}`).then(rows => rows[0]!.n)

test("two devices racing one summary make one call, and the loser completes taken", async () => {
  const server = await harness(runtime, answers("Hi"), { actor })
  const { answer } = await conversation(1)
  const model = writing("Release retry check completed")
  const [one, two] = await Promise.all([device(ledgerOn(server), model.model), device(ledgerOn(server), model.model)])
  const run = (from: typeof one) => from.on(Effect.exit(from.runtime.execute(Summarize, { executionId: `timeline-${REVISION}`, payload: summaryOf(answer) })))
  const ends = await Promise.all([run(one), run(two)])
  expect(model.calls).toBe(1)
  expect(ends).toContainEqual(Exit.succeed({ summary: "Release retry check completed" }))
  expect(ends).toContainEqual(Exit.succeed({ outcome: "taken" }))
  expect((await stored(answer)).summary).toBe("Release retry check completed")
  expect(await attempts(answer)).toBe(1)
})

test("a segmentation claims first, then its spans land on the messages they start at, with coverage the server counted", async () => {
  const server = await harness(runtime, answers("Hi"), { actor })
  const { questions } = await conversation(4)
  const model = writing(JSON.stringify({ spans: [{ from: 1, title: "Researching issue 450", summary: "Found the cause." }, { from: 3, title: "Fixing the test", summary: "It passed." }] }))
  const one = await device(ledgerOn(server), model.model)
  expect(await one.on(Effect.exit(one.runtime.execute(Phases, { executionId: "phases-ready", payload: planOver(questions) })))).toEqual(Exit.succeed({ spans: 2 }))
  expect(JSON.parse((await stored(questions[0]!)).phase!)).toMatchObject({ title: "Researching issue 450", covered: 2, closed: false })
  expect(JSON.parse((await stored(questions[2]!)).phase!)).toMatchObject({ title: "Fixing the test", covered: 2, closed: false })
})

test("a segmentation another device took makes no call", async () => {
  const server = await harness(runtime, answers("Hi"), { actor })
  const { questions } = await conversation(4)
  const model = writing("{}")
  await sql(sql => sql`
    INSERT INTO timeline_phase_claims (anchor_id, level, revision, person_id, owner) VALUES (${questions[0]!}, 1, ${planOver(questions).revision}, ${actor.subject.id}, ${crypto.randomUUID()})`)
  const one = await device(ledgerOn(server), model.model)
  expect(await one.on(Effect.exit(one.runtime.execute(Phases, { executionId: "phases-taken", payload: planOver(questions) })))).toEqual(Exit.succeed({ outcome: "taken" }))
  expect(model.calls).toBe(0)
})

test("a crash between claim and record resumes on restart: its journaled answer is recorded, with no second call or attempt", async () => {
  const server = await harness(runtime, answers("Hi"), { actor })
  const { answer } = await conversation(1)
  const model = writing("Release retry check completed")
  // The fault: this engine dies with the model's answer journaled and the record not sent.
  const reached = Deferred.makeUnsafe<void>()
  const dying = Layer.effect(SummaryLedger, Effect.map(SummaryLedger, real => SummaryLedger.of({
    ...real, record: () => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
  }))).pipe(Layer.provide(ledgerOn(server)))
  // This engine holds the schema, so the two below can come and go on it, as one device's storage outlives its worker.
  const storage = await device(ledgerOn(server), model.model)
  const host = { hostId: "one-device", schema: storage.engine.schema, isAlive: RunStore.Ownership.singleIncarnationLiveness }
  const first = await device(dying, model.model, host)
  const executionId = `timeline-${REVISION}`
  const run = first.on(Effect.exit(first.runtime.execute(Summarize, { executionId, payload: summaryOf(answer) })))
  await Effect.runPromise(Deferred.await(reached))
  await Effect.runPromise(Scope.close(first.scope, Exit.void))
  await run.catch(() => undefined)
  const second = await device(ledgerOn(server), model.model, host)
  expect(await second.on(Effect.exit(second.runtime.execute(Summarize, { executionId, payload: summaryOf(answer) })))).toEqual(Exit.succeed({ summary: "Release retry check completed" }))
  expect(model.calls).toBe(1)
  expect((await stored(answer)).summary).toBe("Release retry check completed")
  expect(await attempts(answer)).toBe(1)
})

test("a failure that freed its claim is retried on a later open through the engine's retry, and a success is not", async () => {
  const server = await harness(runtime, answers("Hi"), { actor })
  const { answer } = await conversation(1)
  let works = false
  let calls = 0
  const flaky = Model.make({ stream: () => {
    calls++
    return works
      ? Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "s", text: "Release retry check completed" }, { type: "settle", stopReason: "stop" }])
      : Stream.fail(new ModelError.ModelError({ code: "no_route", message: "no summary model" }))
  } })
  const one = await device(ledgerOn(server), flaky)
  const open = () => one.on(one.dispatch.dispatch("timeline/summarize", summaryOf(answer), { door: "sync", executionId: `timeline-${REVISION}`, retry: summaryRetry }))
  expect(await open()).toEqual({ _tag: "Failed", error: new SummaryFailed({ code: "unconfigured" }) })
  works = true
  // Before this, the same id answered the old failure for ever.
  expect(await open()).toEqual({ _tag: "Done", value: { summary: "Release retry check completed" } })
  expect((await stored(answer)).summary).toBe("Release retry check completed")
  expect(calls).toBe(2)
  expect(await attempts(answer)).toBe(2)
  await open()
  expect(calls).toBe(2)
})

test("an unusable segmentation is asked again on a later open", async () => {
  const server = await harness(runtime, answers("Hi"), { actor })
  const { questions } = await conversation(4)
  let reply = "I can't help."
  const model = Model.make({ stream: () => Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "s", text: reply }, { type: "settle", stopReason: "stop" }]) })
  const one = await device(ledgerOn(server), model)
  const open = () => one.on(one.dispatch.dispatch("timeline/phases", planOver(questions), { door: "sync", executionId: "timeline-phases", retry: phaseRetry }))
  expect(await open()).toEqual({ _tag: "Failed", error: new SummaryFailed({ code: "invalid" }) })
  reply = JSON.stringify({ spans: [{ from: 1, title: "Researching issue 450", summary: "Found the cause." }] })
  expect(await open()).toEqual({ _tag: "Done", value: { spans: 1 } })
})

test("a run whose claim lapsed to another device can't record over it", async () => {
  const server = await harness(runtime, answers("Hi"), { actor })
  const { answer } = await conversation(1)
  const model = writing("Late answer here")
  // The fault: this device stalls between its model call and its record until the claim has lapsed and gone elsewhere.
  const stalled = Layer.effect(SummaryLedger, Effect.map(SummaryLedger, real => SummaryLedger.of({
    ...real,
    record: record => Effect.promise(() => lapse(answer)).pipe(Effect.andThen(real.record(record))),
  }))).pipe(Layer.provide(ledgerOn(server)))
  const one = await device(stalled, model.model)
  const exit = await one.on(Effect.exit(one.runtime.execute(Summarize, { executionId: "fenced", payload: summaryOf(answer) })))
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new SummaryFailed({ code: "refused" }))
  expect((await stored(answer)).summary).toBeNull()
})
const lapse = (answer: string) => sql(sql => sql`UPDATE timeline_summaries SET owner = ${crypto.randomUUID()}, claimed_at = now() WHERE message_id = ${answer}`)
