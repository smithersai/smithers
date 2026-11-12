import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RunMetrics, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { randomUUID } from "node:crypto"
import { CloudflareRuntime, ExecutionObject } from "../src/index.ts"
import { Answer, Record, registration, runtime } from "./fixtures/AnswerFlow.ts"
import * as MemoryStorage from "./fixtures/MemoryStorage.ts"
import * as Objects from "./fixtures/Objects.ts"
import * as Postgres from "./fixtures/Postgres.ts"

class AskFailed extends Schema.TaggedError<AskFailed>()("AskFailed", {}) {}

/** What a `settled` handler fails with while the caller's own database is down. */
class RecordUnavailable extends Schema.TaggedError<RecordUnavailable>()("RecordUnavailable", {}) {}

/** A `settled` handler that records each execution id it was handed and fails while `down()` says so. */
const handler = (down: () => boolean) => {
  const handed: Array<string> = []
  const settled: ExecutionObject.Settled = (executionId) =>
    Effect.suspend(() => {
      handed.push(executionId)
      return down() ? Effect.fail(new RecordUnavailable()) : Effect.void
    })
  return { handed, settled }
}

/** A runtime whose construction fails, as one over an unreachable database does. */
const unbuildable = () => Layer.unwrap(Effect.fail(new AskFailed())) as Layer.Layer<ExecutionObject.Services, AskFailed>

/** A flow that waits for a reply no timer delivers; its body is the registered implementation. */
const Awaiting = Flow.make("cloudflare-test/Awaiting", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, (): Node.Node<never> => {
    throw new Error("Awaiting runs its registered implementation")
  })
})

const awaitingRegistration = Layer.effectDiscard(Effect.gen(function*() {
  const runtime = yield* FlowRuntime.FlowRuntime
  yield* runtime.register(
    Awaiting,
    () => DurableDeferred.await(DurableDeferred.make("reply", { success: Schema.String }))
  )
}))

/**
 * The next build's {@link Answer}: the same flow with a required field a
 * payload recorded by the build before it lacks.
 */
const AnswerWithLocale = Flow.make("cloudflare-test/Answer", {
  payload: { question: Schema.String, pauseMs: Schema.Number, locale: Schema.String },
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, ({ pauseMs, question }) =>
    Record.call({ label: `ask:${question}` }).pipe(
      Node.andThen(Sleep.action.call({ millis: pauseMs })),
      Node.andThen(Record.call({ label: "answer" }))
    ))
})

/** A `Settled` outcome, whatever window it was armed to forget at. */
const settled = { _tag: "Settled", forgetAtMs: expect.any(Number) }

/** One Durable Object's worth of state: its storage, its schema and the steps its flow ran. */
const object = (target: Postgres.Target = Postgres.direct) => {
  const schema = Postgres.freshSchema()
  const memory = MemoryStorage.make()
  const steps: Array<string> = []
  const executionId = `answer-${randomUUID()}`
  const hostId = `object-${executionId}`
  const alarm = (settled?: ExecutionObject.Settled) =>
    ExecutionObject.alarm(memory.storage, {
      flows: [Answer],
      runtime: runtime({
        hostId,
        database: Postgres.database(schema, target.url),
        record: (label) => Effect.sync(() => steps.push(label)).pipe(Effect.as(label))
      }),
      router: Objects.unrouted,
      settled
    })
  const intent = (payload: { readonly question: string; readonly pauseMs: number }) =>
    ExecutionObject.intent(Answer, { executionId, payload })
  const status = Effect.promise(() =>
    Postgres.admin(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM ${sql(schema)}.flows_runs WHERE run_id = ${executionId}`
      return rows[0]?.status
    }))
  )
  return { schema, memory, steps, executionId, hostId, alarm, intent, status }
}

for (const target of Postgres.targets) {
  describe.skipIf(!target.available)(`ExecutionObject over ${target.label}`, () => {
    it.live("start stores the intent and moves the alarm to now; the alarm runs the flow and arms the forget alarm", () => {
      const o = object(target)
      return Effect.gen(function*() {
        const value = yield* o.intent({ question: "hi", pauseMs: 0 })
        const before = Date.now()
        expect(yield* ExecutionObject.start(o.memory.storage, value, Effect.succeed("asked"))).toBe("asked")
        expect(o.memory.values.get(ExecutionObject.intentKey)).toEqual(expect.any(String))
        expect(o.memory.alarm()).toBeGreaterThanOrEqual(before)
        expect(o.memory.alarm()).toBeLessThan(before + ExecutionObject.startGraceMs)

        const outcome = yield* o.alarm()
        expect(outcome).toEqual(settled)
        expect(o.steps).toEqual(["ask:hi", "answer"])
        // The object keeps the intent for the retention window, then forgets it.
        const settledAt = o.memory.values.get(ExecutionObject.settledKey) as number
        expect(settledAt).toBeGreaterThanOrEqual(before)
        expect(outcome).toEqual({ _tag: "Settled", forgetAtMs: settledAt + ExecutionObject.settledRetentionMs })
        expect(o.memory.alarm()).toBe(settledAt + ExecutionObject.settledRetentionMs)
        expect(o.memory.values.has(ExecutionObject.failuresKey)).toBe(false)
        expect(yield* o.status).toBe("completed")
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.live("a settlement its handler refused retries the handler, not the drive, and the window starts once it took it", () => {
      const o = object(target)
      let down = true
      const { handed, settled: report } = handler(() => down)
      return Effect.gen(function*() {
        yield* ExecutionObject.start(o.memory.storage, yield* o.intent({ question: "hi", pauseMs: 0 }), Effect.void)
        const before = Date.now()
        // The run completes, but the caller's record of it can't be written: the object retries, never arms the window.
        expect(yield* o.alarm(report)).toEqual({
          _tag: "Retrying",
          attempt: 1,
          retryAtMs: expect.any(Number),
          failure: "RecordUnavailable",
          detail: {}
        })
        expect(yield* o.status).toBe("completed")
        expect(handed).toEqual([o.executionId])
        expect(o.memory.values.has(ExecutionObject.settledKey)).toBe(true)
        expect(o.memory.values.has(ExecutionObject.reportedKey)).toBe(false)
        expect(o.memory.values.get(ExecutionObject.failuresKey)).toBe(1)
        expect(o.memory.alarm()).toBeLessThanOrEqual(Date.now() + 1_000)
        expect(o.memory.alarm()).toBeGreaterThanOrEqual(before + 1_000)
        // The database is back: the next alarm hands the settlement over again, runs no step, and arms the window.
        down = false
        const outcome = yield* o.alarm(report)
        const reportedAt = o.memory.values.get(ExecutionObject.reportedKey) as number
        expect(outcome).toEqual({ _tag: "Settled", forgetAtMs: reportedAt + ExecutionObject.settledRetentionMs })
        expect(o.memory.alarm()).toBe(reportedAt + ExecutionObject.settledRetentionMs)
        expect(handed).toEqual([o.executionId, o.executionId])
        expect(o.steps).toEqual(["ask:hi", "answer"])
        expect(o.memory.values.has(ExecutionObject.failuresKey)).toBe(false)
        // Taken: a duplicate alarm hands it over no more.
        expect(yield* o.alarm(report)).toEqual(outcome)
        expect(handed).toHaveLength(2)
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.live("a flow that fails has settled: the alarm waits to forget it, not to retry", () => {
      const o = object(target)
      return Effect.gen(function*() {
        // A negative pause is the flow's own declared failure, SleepRequestInvalid.
        const value = yield* o.intent({ question: "hi", pauseMs: -1 })
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        const outcome = yield* o.alarm()
        expect(outcome).toEqual(settled)
        expect(o.memory.alarm()).toBe((outcome as { readonly forgetAtMs: number }).forgetAtMs)
        expect(o.steps).toEqual(["ask:hi"])
        expect(yield* o.status).toBe("failed")
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.live("the alarm admits the run under its starter's origin, placed on Cloudflare; another origin is the same intent", () => {
      const named = object(target)
      const unnamed = object(target)
      return Effect.gen(function*() {
        const value = yield* named.intent({ question: "hi", pauseMs: 0 }).pipe(
          RunMetrics.withOrigin({ door: "api", actor: "person" })
        )
        expect(value.origin).toEqual({ door: "api", actor: "person" })
        yield* ExecutionObject.start(named.memory.storage, value, Effect.void)
        // The same flow, execution and payload under another origin is the same intent: no conflict, nothing stored.
        const stored = named.memory.values.get(ExecutionObject.intentKey)
        const again = yield* named.intent({ question: "hi", pauseMs: 0 })
        expect(again.origin).toEqual({ door: "unknown", actor: "unknown" })
        yield* ExecutionObject.start(named.memory.storage, again, Effect.void)
        expect(named.memory.values.get(ExecutionObject.intentKey)).toBe(stored)
        expect(yield* named.alarm()).toEqual(settled)

        // An intent an earlier build stored names no origin: its run is admitted as unknown.
        const { origin: _origin, ...earlier } = yield* unnamed.intent({ question: "yo", pauseMs: 0 })
        yield* ExecutionObject.start(unnamed.memory.storage, earlier, Effect.void)
        expect(yield* unnamed.alarm()).toEqual(settled)

        const counted = (yield* Metric.snapshot)
          .filter((entry) => entry.id === "flows_runs_settled")
          .map((entry) => entry.attributes)
        expect(counted).toEqual(expect.arrayContaining([
          {
            flow: Answer._tag,
            door: "api",
            actor: "person",
            placement: "cloudflare",
            outcome: "succeeded",
            code: "none"
          },
          {
            flow: Answer._tag,
            door: "unknown",
            actor: "unknown",
            placement: "cloudflare",
            outcome: "succeeded",
            code: "none"
          }
        ]))
      }).pipe(
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.ensuring(Effect.promise(() => Postgres.dropSchema(named.schema))),
        Effect.ensuring(Effect.promise(() => Postgres.dropSchema(unnamed.schema)))
      )
    })

    it.live("a duplicate start reruns the caller's effect and stores nothing new; another payload is a conflict", () => {
      const o = object(target)
      return Effect.gen(function*() {
        const value = yield* o.intent({ question: "hi", pauseMs: 0 })
        let asked = 0
        const ask = Effect.sync(() => ++asked)
        yield* ExecutionObject.start(o.memory.storage, value, ask)
        const stored = o.memory.values.get(ExecutionObject.intentKey)
        expect(yield* ExecutionObject.start(o.memory.storage, value, ask)).toBe(2)
        expect(o.memory.values.get(ExecutionObject.intentKey)).toBe(stored)

        const other = yield* o.intent({ question: "something else", pauseMs: 0 })
        const conflict = yield* Effect.flip(ExecutionObject.start(o.memory.storage, other, ask))
        expect(conflict).toBeInstanceOf(ExecutionObject.IntentConflict)
        expect(conflict.executionId).toBe(o.executionId)
        expect(asked).toBe(2)
        expect(o.memory.values.get(ExecutionObject.intentKey)).toBe(stored)

        expect(yield* o.alarm()).toEqual(settled)
        expect(o.steps).toEqual(["ask:hi", "answer"])
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.live("duplicate alarms and a start after settlement run no step twice", () => {
      const o = object(target)
      return Effect.gen(function*() {
        const value = yield* o.intent({ question: "hi", pauseMs: 0 })
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        const outcome = yield* o.alarm()
        expect(outcome).toEqual(settled)
        expect(yield* o.alarm()).toEqual(outcome)
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        expect(o.memory.alarm()).not.toBe((outcome as { readonly forgetAtMs: number }).forgetAtMs)
        expect(yield* o.alarm()).toEqual(outcome)
        expect(o.steps).toEqual(["ask:hi", "answer"])
        expect(o.memory.alarm()).toBe((outcome as { readonly forgetAtMs: number }).forgetAtMs)
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.effect("a settled object forgets its intent after the window; a late start runs no step and forgets again", () => {
      const o = object(target)
      return Effect.gen(function*() {
        yield* TestClock.setTime(Date.now())
        const value = yield* o.intent({ question: "hi", pauseMs: 0 })
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        const settledAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const forgetAtMs = settledAt + ExecutionObject.settledRetentionMs
        expect(yield* o.alarm()).toEqual({ _tag: "Settled", forgetAtMs })
        expect([...o.memory.values.keys()].sort()).toEqual([ExecutionObject.intentKey, ExecutionObject.settledKey])

        // Inside the window a duplicate start or a wake costs no drive: a
        // runtime that cannot even be built still answers the settlement.
        const settledOnly = { flows: [Answer], runtime: unbuildable, router: Objects.unrouted }
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        expect(yield* ExecutionObject.alarm(o.memory.storage, settledOnly)).toEqual({ _tag: "Settled", forgetAtMs })
        expect(yield* ExecutionObject.wake(o.memory.storage)).toBe(true)
        expect(yield* ExecutionObject.alarm(o.memory.storage, settledOnly)).toEqual({ _tag: "Settled", forgetAtMs })
        expect(o.memory.alarm()).toBe(forgetAtMs)
        // The intent still guards its id inside the window.
        const other = yield* o.intent({ question: "something else", pauseMs: 0 })
        expect(yield* Effect.flip(ExecutionObject.start(o.memory.storage, other, Effect.void))).toBeInstanceOf(
          ExecutionObject.IntentConflict
        )

        // The window passes: the final alarm empties the object and arms nothing.
        yield* TestClock.setTime(forgetAtMs)
        expect(yield* ExecutionObject.alarm(o.memory.storage, settledOnly)).toEqual({ _tag: "Forgotten" })
        expect(o.memory.values.size).toBe(0)
        expect(o.memory.alarm()).toBeNull()
        expect(yield* ExecutionObject.wake(o.memory.storage)).toBe(false)
        expect(o.memory.alarm()).toBeNull()

        // A late start of the same intent settles from the run the engine
        // stored, without running a step, and the object forgets it again.
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        const later = forgetAtMs + ExecutionObject.settledRetentionMs
        expect(yield* o.alarm()).toEqual({ _tag: "Settled", forgetAtMs: later })
        expect(o.steps).toEqual(["ask:hi", "answer"])
        expect(yield* o.status).toBe("completed")
        yield* TestClock.setTime(later)
        expect(yield* o.alarm()).toEqual({ _tag: "Forgotten" })
        expect(o.memory.values.size).toBe(0)

        // Past the window the id no longer guards its payload: another one is
        // stored, and the engine answers it with the run it already holds.
        yield* ExecutionObject.start(o.memory.storage, other, Effect.void)
        expect(yield* o.alarm()).toEqual(settled)
        expect(o.steps).toEqual(["ask:hi", "answer"])
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.live("a start that dies before its effect leaves an alarm that still runs the flow", () => {
      const o = object(target)
      return Effect.gen(function*() {
        const value = yield* o.intent({ question: "hi", pauseMs: 0 })
        const before = Date.now()
        const failure = yield* Effect.flip(ExecutionObject.start(o.memory.storage, value, new AskFailed()))
        expect(failure).toEqual(new AskFailed())
        // The alarm stayed at the grace deadline: nothing moved it to now.
        expect(o.memory.alarm()).toBeGreaterThanOrEqual(before + ExecutionObject.startGraceMs)

        expect(yield* o.alarm()).toEqual(settled)
        expect(o.steps).toEqual(["ask:hi", "answer"])
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.live("a runtime configured for another execution leaves this one undriven, and the alarm backs off", () => {
      const o = object(target)
      return Effect.gen(function*() {
        const value = yield* o.intent({ question: "hi", pauseMs: 0 })
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        const options = {
          flows: [Answer],
          runtime: (intent: ExecutionObject.Intent) =>
            CloudflareRuntime.layer(
              { hostId: o.hostId, executionId: `not-${intent.executionId}` },
              registration((label) => Effect.sync(() => o.steps.push(label)).pipe(Effect.as(label)))
            ).pipe(Layer.provide(Postgres.database(o.schema, target.url))),
          router: Objects.unrouted
        }
        const first = yield* ExecutionObject.alarm(o.memory.storage, options)
        expect(first).toMatchObject({ _tag: "Retrying", attempt: 1, failure: "@smthrs/platform-cloudflare/Undriven" })
        expect(yield* ExecutionObject.alarm(o.memory.storage, options)).toMatchObject({ _tag: "Retrying", attempt: 2 })
        expect(o.steps).toEqual([])
        expect(yield* o.status).toBe("pending")
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.live("a deploy that dropped the flow's registration retries until a runtime registers it again", () => {
      const o = object(target)
      const unregistered = () =>
        ExecutionObject.alarm(o.memory.storage, {
          flows: [Answer],
          runtime: (intent) =>
            CloudflareRuntime.layer({ hostId: o.hostId, executionId: intent.executionId }, Layer.empty).pipe(
              Layer.provide(Postgres.database(o.schema, target.url))
            ),
          router: Objects.unrouted
        })
      return Effect.gen(function*() {
        const value = yield* o.intent({ question: "hi", pauseMs: 60_000 })
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        expect(yield* unregistered()).toMatchObject({
          _tag: "Retrying",
          attempt: 1,
          failure: "@smthrs/engine/FlowNotRegistered"
        })
        expect(o.steps).toEqual([])
        // The next deploy registers it again; the count resets once an alarm makes progress.
        const parked = yield* o.alarm()
        expect(parked).toMatchObject({ _tag: "Parked" })
        expect(o.memory.values.has(ExecutionObject.failuresKey)).toBe(false)
        expect(o.steps).toEqual(["ask:hi"])
        // A run with nothing due is left parked without its flow, so an early alarm fails nothing.
        expect(yield* unregistered()).toEqual(parked)
        expect(yield* o.status).toBe("suspended")
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.live("an execution waiting on an event parks with no wake, and the alarm is deleted", () => {
      const o = object(target)
      return Effect.gen(function*() {
        const value = yield* ExecutionObject.intent(Awaiting, { executionId: o.executionId, payload: {} })
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        const outcome = yield* ExecutionObject.alarm(o.memory.storage, {
          flows: [Awaiting],
          runtime: (intent) =>
            CloudflareRuntime.layer({ hostId: o.hostId, executionId: intent.executionId }, awaitingRegistration).pipe(
              Layer.provide(Postgres.database(o.schema, target.url))
            ),
          router: Objects.unrouted
        })
        expect(outcome).toEqual({ _tag: "Parked", wakeAtMs: null })
        expect(o.memory.alarm()).toBeNull()
        expect(yield* o.status).toBe("suspended")
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.effect("a parked durable timer: the alarm returns its due time and a later alarm resumes the flow", () => {
      const o = object(target)
      return Effect.gen(function*() {
        yield* TestClock.setTime(Date.now())
        const value = yield* o.intent({ question: "hi", pauseMs: 60_000 })
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

        const parked = yield* o.alarm()
        expect(parked).toEqual({ _tag: "Parked", wakeAtMs: expect.any(Number) })
        const wakeAtMs = (parked as { readonly wakeAtMs: number }).wakeAtMs
        expect(wakeAtMs).toBeGreaterThanOrEqual(startedAt + 60_000)
        expect(o.memory.alarm()).toBe(wakeAtMs)
        expect(o.steps).toEqual(["ask:hi"])
        expect(yield* o.status).toBe("suspended")

        // An early alarm, as a duplicate start causes, parks again on the same timer.
        expect(yield* o.alarm()).toEqual({ _tag: "Parked", wakeAtMs })
        expect(o.steps).toEqual(["ask:hi"])

        yield* TestClock.setTime(wakeAtMs)
        expect(yield* o.alarm()).toEqual({ _tag: "Settled", forgetAtMs: wakeAtMs + ExecutionObject.settledRetentionMs })
        expect(o.steps).toEqual(["ask:hi", "answer"])
        expect(o.memory.alarm()).toBe(wakeAtMs + ExecutionObject.settledRetentionMs)
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })

    it.effect("a deploy whose payload schema no longer decodes a parked execution's payload settles it payload_changed", () => {
      const o = object(target)
      const nextBuild = (intent: ExecutionObject.Intent) =>
        CloudflareRuntime.layer(
          { hostId: o.hostId, executionId: intent.executionId },
          Interpreter.layerWithImplementations(
            AnswerWithLocale,
            Record.toLayer(({ label }) => Effect.sync(() => o.steps.push(label)).pipe(Effect.as(label)))
          ).pipe(Layer.provideMerge(Action.layerImplementations))
        ).pipe(Layer.provide(Postgres.database(o.schema, target.url)))
      const deployed = () =>
        ExecutionObject.alarm(o.memory.storage, {
          flows: [AnswerWithLocale],
          runtime: nextBuild,
          router: Objects.unrouted
        })
      return Effect.gen(function*() {
        yield* TestClock.setTime(Date.now())
        const value = yield* o.intent({ question: "hi", pauseMs: 60_000 })
        yield* ExecutionObject.start(o.memory.storage, value, Effect.void)
        const parked = yield* o.alarm()
        const wakeAtMs = (parked as { readonly wakeAtMs: number }).wakeAtMs
        expect(o.steps).toEqual(["ask:hi"])

        // An early alarm under the new build leaves the run parked: the store
        // holds it, so the stored intent's payload is never decoded.
        expect(yield* deployed()).toEqual({ _tag: "Parked", wakeAtMs })
        expect(yield* o.status).toBe("suspended")

        // Its timer comes due: the engine refuses the recorded payload, and the
        // run settles instead of retrying a decode that can never succeed.
        yield* TestClock.setTime(wakeAtMs)
        expect(yield* deployed()).toEqual({
          _tag: "Settled",
          forgetAtMs: wakeAtMs + ExecutionObject.settledRetentionMs
        })
        expect(o.memory.values.has(ExecutionObject.failuresKey)).toBe(false)
        expect(o.steps).toEqual(["ask:hi"])
        expect(yield* o.status).toBe("failed")
        const result = yield* Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          return yield* runtime.poll(AnswerWithLocale, o.executionId)
        }).pipe(Effect.provide(nextBuild(value)))
        const settled = Option.getOrThrow(result)
        if (settled._tag !== "Complete" || Exit.isSuccess(settled.exit)) throw new Error("the run did not fail")
        expect(Interpreter.refusalCode(settled.exit.cause)).toEqual(Option.some("payload_changed"))
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(o.schema))))
    })
  })
}

describe("ExecutionObject without a database", () => {
  it.effect("an alarm with no intent stored is idle and deletes the alarm", () =>
    Effect.gen(function*() {
      const memory = MemoryStorage.make()
      const outcome = yield* ExecutionObject.alarm(memory.storage, {
        flows: [Answer],
        runtime: unbuildable,
        router: Objects.unrouted
      })
      expect(outcome).toEqual({ _tag: "Idle" })
      expect(memory.alarm()).toBeNull()
    }))

  it.effect("a settled object re-arms its forget alarm without a runtime, and empties itself once the window passes", () =>
    Effect.gen(function*() {
      const memory = MemoryStorage.make()
      const value = yield* ExecutionObject.intent(Answer, {
        executionId: "settled",
        payload: { question: "hi", pauseMs: 0 }
      })
      yield* ExecutionObject.start(memory.storage, value, Effect.void)
      // What an earlier alarm left: a settlement at 1 s, and an attempt it counted.
      yield* memory.storage.put(ExecutionObject.settledKey, 1_000)
      yield* memory.storage.put(ExecutionObject.failuresKey, 1)
      const options = { flows: [Answer], runtime: unbuildable, router: Objects.unrouted, settledRetentionMs: 60_000 }

      yield* TestClock.setTime(60_999)
      expect(yield* ExecutionObject.alarm(memory.storage, options)).toEqual({ _tag: "Settled", forgetAtMs: 61_000 })
      expect(memory.alarm()).toBe(61_000)
      expect(memory.values.get(ExecutionObject.failuresKey)).toBe(1)

      yield* TestClock.setTime(61_000)
      expect(yield* ExecutionObject.alarm(memory.storage, options)).toEqual({ _tag: "Forgotten" })
      expect(memory.values.size).toBe(0)
      expect(memory.alarm()).toBeNull()
      // Forgotten for good: a late alarm is idle, and a late wake arms nothing.
      expect(yield* ExecutionObject.alarm(memory.storage, options)).toEqual({ _tag: "Idle" })
      expect(yield* ExecutionObject.wake(memory.storage)).toBe(false)
      expect(memory.alarm()).toBeNull()
    }))

  it.effect("a settlement its handler never took is never forgotten, however long it fails", () =>
    Effect.gen(function*() {
      const memory = MemoryStorage.make()
      const value = yield* ExecutionObject.intent(Answer, {
        executionId: "unreported",
        payload: { question: "hi", pauseMs: 0 }
      })
      yield* ExecutionObject.start(memory.storage, value, Effect.void)
      // What an earlier alarm left: a settlement at 1 s that its handler refused.
      yield* memory.storage.put(ExecutionObject.settledKey, 1_000)
      let down = true
      const { handed, settled } = handler(() => down)
      const options = {
        flows: [Answer],
        runtime: unbuildable,
        router: Objects.unrouted,
        settledRetentionMs: 60_000,
        settled
      }

      // Long past the settlement's window, each alarm retries the handler with doubling backoff and keeps the intent.
      yield* TestClock.setTime(1_000_000)
      for (const [attempt, delayMs] of [[1, 1_000], [2, 2_000], [3, 4_000]] as const) {
        expect(yield* ExecutionObject.alarm(memory.storage, options)).toEqual({
          _tag: "Retrying",
          attempt,
          retryAtMs: 1_000_000 + delayMs,
          failure: "RecordUnavailable",
          detail: {}
        })
        expect(memory.alarm()).toBe(1_000_000 + delayMs)
      }
      expect(memory.values.has(ExecutionObject.intentKey)).toBe(true)
      expect(handed).toEqual(["unreported", "unreported", "unreported"])

      // It takes the settlement: the window runs from then, so the object is not forgotten at once.
      down = false
      yield* TestClock.setTime(1_004_000)
      expect(yield* ExecutionObject.alarm(memory.storage, options)).toEqual({ _tag: "Settled", forgetAtMs: 1_064_000 })
      expect(memory.values.get(ExecutionObject.reportedKey)).toBe(1_004_000)
      expect(memory.values.has(ExecutionObject.failuresKey)).toBe(false)
      expect(memory.alarm()).toBe(1_064_000)

      yield* TestClock.setTime(1_064_000)
      expect(yield* ExecutionObject.alarm(memory.storage, options)).toEqual({ _tag: "Forgotten" })
      expect(memory.values.size).toBe(0)
      expect(handed).toHaveLength(4)
    }))

  it.effect("a settled object whose intent no longer decodes hands its handler nothing and keeps its window", () =>
    Effect.gen(function*() {
      const memory = MemoryStorage.make()
      yield* memory.storage.put(ExecutionObject.intentKey, "not an intent")
      yield* memory.storage.put(ExecutionObject.settledKey, 1_000)
      const { handed, settled } = handler(() => true)
      yield* TestClock.setTime(2_000)
      expect(
        yield* ExecutionObject.alarm(memory.storage, {
          flows: [Answer],
          runtime: unbuildable,
          router: Objects.unrouted,
          settledRetentionMs: 60_000,
          settled
        })
      ).toEqual({ _tag: "Settled", forgetAtMs: 62_000 })
      expect(handed).toEqual([])
      expect(memory.values.has(ExecutionObject.failuresKey)).toBe(false)
    }))

  it.effect("a failing runtime re-arms with doubling backoff, and the count survives between alarms", () =>
    Effect.gen(function*() {
      const memory = MemoryStorage.make()
      const value = yield* ExecutionObject.intent(Answer, {
        executionId: "unreachable",
        payload: { question: "hi", pauseMs: 0 }
      })
      yield* ExecutionObject.start(memory.storage, value, Effect.void)
      const options = { flows: [Answer], runtime: unbuildable, router: Objects.unrouted }
      expect(yield* ExecutionObject.alarm(memory.storage, options)).toEqual({
        _tag: "Retrying",
        attempt: 1,
        retryAtMs: 1_000,
        failure: "AskFailed",
        detail: {}
      })
      expect(memory.alarm()).toBe(1_000)
      expect(yield* ExecutionObject.alarm(memory.storage, options)).toEqual({
        _tag: "Retrying",
        attempt: 2,
        retryAtMs: 2_000,
        failure: "AskFailed",
        detail: {}
      })
      expect(memory.values.get(ExecutionObject.failuresKey)).toBe(2)
    }))

  it.effect("an alarm that dies mid-drive leaves its attempt counted and the next one armed after the backoff", () =>
    Effect.gen(function*() {
      const memory = MemoryStorage.make()
      const value = yield* ExecutionObject.intent(Answer, {
        executionId: "dies",
        payload: { question: "hi", pauseMs: 0 }
      })
      yield* ExecutionObject.start(memory.storage, value, Effect.void)
      const building = yield* Deferred.make<void>()
      // The runtime never finishes building, and the fiber is then interrupted:
      // what an isolate reset does to an alarm in the middle of its drive.
      const hung = Layer.unwrap(
        Deferred.succeed(building, undefined).pipe(Effect.andThen(Effect.never))
      ) as Layer.Layer<
        ExecutionObject.Services
      >
      const fiber = yield* Effect.forkChild(
        ExecutionObject.alarm(memory.storage, { flows: [Answer], runtime: () => hung, router: Objects.unrouted })
      )
      yield* Deferred.await(building)
      yield* Fiber.interrupt(fiber)
      expect(memory.values.get(ExecutionObject.failuresKey)).toBe(1)
      expect(memory.alarm()).toBe(1_000)

      yield* TestClock.setTime(1_000)
      expect(
        yield* ExecutionObject.alarm(memory.storage, {
          flows: [Answer],
          runtime: unbuildable,
          router: Objects.unrouted
        })
      ).toEqual({
        _tag: "Retrying",
        attempt: 2,
        retryAtMs: 3_000,
        failure: "AskFailed",
        detail: {}
      })
    }))

  it.effect("an intent naming a flow this object was not given retries rather than settling", () =>
    Effect.gen(function*() {
      const memory = MemoryStorage.make()
      const value = yield* ExecutionObject.intent(Answer, {
        executionId: "renamed",
        payload: { question: "hi", pauseMs: 0 }
      })
      yield* ExecutionObject.start(memory.storage, value, Effect.void)
      const outcome = yield* ExecutionObject.alarm(memory.storage, {
        flows: [],
        runtime: unbuildable,
        router: Objects.unrouted
      })
      expect(outcome).toMatchObject({
        _tag: "Retrying",
        attempt: 1,
        failure: "@smthrs/platform-cloudflare/UnknownFlow"
      })
    }))

  it.effect("wake moves the alarm to now when an intent is stored, and leaves an empty object idle", () =>
    Effect.gen(function*() {
      const empty = MemoryStorage.make()
      expect(yield* ExecutionObject.wake(empty.storage)).toBe(false)
      expect(empty.alarm()).toBeNull()

      const memory = MemoryStorage.make()
      const value = yield* ExecutionObject.intent(Answer, {
        executionId: "woken",
        payload: { question: "hi", pauseMs: 0 }
      })
      yield* ExecutionObject.start(memory.storage, value, new AskFailed()).pipe(Effect.ignore)
      expect(memory.alarm()).toBe(ExecutionObject.startGraceMs)
      yield* TestClock.setTime(1_000)
      expect(yield* ExecutionObject.wake(memory.storage)).toBe(true)
      expect(memory.alarm()).toBe(1_000)
    }))

  it.effect("a stored intent that isn't one conflicts with every start, and nothing runs", () =>
    Effect.gen(function*() {
      const memory = MemoryStorage.make()
      yield* memory.storage.put(ExecutionObject.intentKey, "not an intent")
      const value = yield* ExecutionObject.intent(Answer, { executionId: "e", payload: { question: "q", pauseMs: 5 } })
      let ran = false
      const conflict = yield* Effect.flip(ExecutionObject.start(memory.storage, value, Effect.sync(() => (ran = true))))
      expect(conflict).toBeInstanceOf(ExecutionObject.IntentConflict)
      expect(ran).toBe(false)
      expect(memory.values.get(ExecutionObject.intentKey)).toBe("not an intent")
    }))

  it.effect("an alarm over a stored intent that isn't one retries it, its span and log carrying no execution ids", () =>
    Effect.gen(function*() {
      const o = object()
      yield* o.memory.storage.put(ExecutionObject.intentKey, "not an intent")
      expect(yield* o.alarm()).toMatchObject({ _tag: "Retrying", attempt: 1 })
      expect(o.steps).toEqual([])
    }))

  it.effect("intent encodes the payload with the flow's codec and refuses one the schema rejects", () =>
    Effect.gen(function*() {
      expect(
        yield* ExecutionObject.intent(Answer, { executionId: "e", payload: { question: "q", pauseMs: 5 } })
      ).toEqual({
        flow: "cloudflare-test/Answer",
        executionId: "e",
        requestedAtMs: 0,
        payload: { question: "q", pauseMs: 5 },
        origin: { door: "unknown", actor: "unknown" }
      })
      const refused = yield* Effect.flip(
        ExecutionObject.intent(Answer, { executionId: "", payload: { question: "q", pauseMs: 5 } })
      )
      expect(refused).toBeInstanceOf(Schema.SchemaError)
    }))
})

describe("ExecutionObject.intent payload identity (VIP-44)", () => {
  const Tagged = Flow.make("cloudflare-test/Tagged", {
    payload: { tags: Schema.ReadonlySet(Schema.String) },
    success: Schema.Number,
    body: () => Node.succeed(1)
  })

  it.effect("persists equal sets as one sorted payload", () =>
    Effect.gen(function*() {
      const left = yield* ExecutionObject.intent(Tagged, { executionId: "t", payload: { tags: new Set(["b", "a"]) } })
      const right = yield* ExecutionObject.intent(Tagged, { executionId: "t", payload: { tags: new Set(["a", "b"]) } })
      expect(left.payload).toEqual({ tags: ["a", "b"] })
      expect(right.payload).toEqual(left.payload)
    }))
})
