import { describe, expect, it } from "@effect/vitest"
import { FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { ExecutionObject } from "../src/index.ts"
import { Answer, runtime } from "./fixtures/AnswerFlow.ts"
import * as MemoryStorage from "./fixtures/MemoryStorage.ts"
import * as NestedFlows from "./fixtures/NestedFlows.ts"
import * as Objects from "./fixtures/Objects.ts"
import * as Postgres from "./fixtures/Postgres.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const fixture = (record: (label: string) => Effect.Effect<string>, pauseMs = 0) => {
  const schema = Postgres.freshSchema()
  const executionId = randomUUID()
  const memory = MemoryStorage.make()
  const options = {
    flows: [Answer],
    runtime: runtime({ hostId: executionId, database: Postgres.database(schema), record }),
    router: Objects.unrouted
  }
  const make = (extra: Partial<typeof options> & { canStart?: () => Effect.Effect<boolean> } = {}) =>
    ExecutionObject.make(memory.storage, { ...options, ...extra })
  const intent = ExecutionObject.intent(Answer, { executionId, payload: { question: "private", pauseMs } })
  const rows = Effect.promise(() =>
    Postgres.admin(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<
        { status: string; owner_host: string | null }
      >`SELECT status, owner_host_id AS owner_host FROM ${sql(schema)}.flows_runs`
    }))
  )
  return { schema, executionId, memory, make, intent, rows }
}

describe.skipIf(!Postgres.direct.available)("durable object cancellation on real Postgres", () => {
  it.live("a drop before a delayed start survives reincarnation and never creates a run", () => {
    const f = fixture(() => Effect.die("cancelled work ran"))
    return Effect.gen(function*() {
      yield* f.make().cancel()
      const host = f.make()
      yield* host.start(yield* f.intent)
      expect(yield* host.wake()).toBe(true)
      expect(yield* host.alarm()).toMatchObject({ _tag: "Settled" })
      expect(yield* f.rows).toEqual([])
      yield* host.cancel()
      yield* host.start(yield* f.intent)
      expect(yield* host.wake()).toBe(true)
      expect(yield* host.alarm()).toMatchObject({ _tag: "Settled" })
      expect(yield* f.rows).toEqual([])
    }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(f.schema))))
  })

  it.live("a delayed admission rechecks domain state and never creates a dropped run", () => {
    const f = fixture(() => Effect.die("dropped work ran"))
    return Effect.gen(function*() {
      let allowed = true
      const host = f.make({ canStart: () => Effect.sync(() => allowed) })
      yield* host.start(yield* f.intent)
      allowed = false
      const telemetry = Telemetry.make()
      expect(yield* telemetry.observed(host.alarm())).toMatchObject({ _tag: "Settled" })
      expect(telemetry.lines("cloudflare.execution.cancel")[0]?.annotations).toMatchObject({
        "smithers.execution.id": f.executionId,
        outcome: "admission_refused"
      })
      expect(telemetry.count(ExecutionObject.cancellations, {})).toBe(1)
      telemetry.expectNoContent("private")
      expect(yield* f.rows).toEqual([])
      // Retention removes the intent, not the cancellation tombstone.
      yield* ExecutionObject.alarm(f.memory.storage, {
        flows: [],
        runtime: () => Layer.empty as Layer.Layer<ExecutionObject.Services>,
        router: Objects.unrouted,
        settledRetentionMs: 0
      })
      yield* f.make().start(yield* f.intent)
      expect(yield* f.make().alarm()).toMatchObject({ _tag: "Settled" })
      expect(yield* f.rows).toEqual([])
    }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(f.schema))))
  })

  it.live("a parked run is cancelled by a new incarnation without running its next action", () => {
    const seen: Array<string> = []
    const f = fixture((label) =>
      Effect.sync(() => {
        seen.push(label)
        return label
      }), 60_000)
    return Effect.gen(function*() {
      const host = f.make()
      yield* host.start(yield* f.intent)
      expect(yield* host.wake()).toBe(true)
      expect(yield* host.alarm()).toMatchObject({ _tag: "Parked" })
      // Domain admission is not rechecked for an existing run: its terminal
      // writer may already have committed and still owe durable handoffs.
      const next = f.make({ canStart: () => Effect.die("existing run was readmitted") })
      yield* next.cancel()
      expect(yield* next.alarm()).toMatchObject({ _tag: "Settled" })
      expect(yield* f.rows).toEqual([{ status: "cancelled", owner_host: null }])
      expect(seen).toEqual(["ask:private"])
    }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(f.schema))))
  })

  it.live("drop interrupts an unresolved action, runs its finalizer and releases ownership", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const f = fixture(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(released, undefined))
        )
      )
      yield* Effect.gen(function*() {
        const host = f.make()
        yield* host.start(yield* f.intent)
        const running = yield* Effect.forkChild(host.alarm())
        yield* Deferred.await(entered)
        yield* host.cancel()
        yield* Deferred.await(released)
        expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Settled" })
        expect(yield* f.rows).toEqual([{ status: "cancelled", owner_host: null }])
        yield* f.make().cancel()
        expect(yield* f.make().alarm()).toMatchObject({ _tag: "Settled" })
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(f.schema))))
    }))

  it.live("a cancel whose request commits while a parking alarm arms still wakes the object to cancel the run", () =>
    Effect.gen(function*() {
      const schema = Postgres.freshSchema()
      const executionId = randomUUID()
      const memory = MemoryStorage.make()
      const parking = yield* Deferred.make<void>()
      const requesting = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const committed = yield* Deferred.make<void>()
      let armed = false
      let released = false
      const base = NestedFlows.runtime({ record: Effect.succeed, database: Postgres.database(schema) })
      // The cancel's request waits until the parking alarm's last read of the
      // run's row, then commits before that read answers: the interleaving a
      // request transaction slower than the alarm's arming produces.
      const runtime = (intent: ExecutionObject.Intent) =>
        Layer.effectContext(Effect.gen(function*() {
          const services = yield* Layer.build(base(intent))
          const flows = Context.get(services, FlowRuntime.FlowRuntime)
          const runs = Context.get(services, RunStore.RunStore)
          return services.pipe(
            Context.add(FlowRuntime.FlowRuntime, {
              ...flows,
              interrupt: (flow, id) =>
                Deferred.succeed(requesting, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(flows.interrupt(flow, id)),
                  Effect.ensuring(Deferred.succeed(committed, undefined))
                )
            }),
            Context.add(RunStore.RunStore, {
              ...runs,
              get: (id) =>
                runs.get(id).pipe(Effect.tap(() =>
                  armed && !released
                    ? Effect.sync(() => {
                      released = true
                    }).pipe(
                      Effect.andThen(Deferred.succeed(release, undefined)),
                      Effect.andThen(Deferred.await(committed))
                    )
                    : Effect.void
                ))
            })
          )
        }))
      const host = ExecutionObject.make({
        ...memory.storage,
        // The alarm parks on an event: it deletes its alarm, then reads the store.
        deleteAlarm: () =>
          Deferred.succeed(parking, undefined).pipe(
            Effect.andThen(Deferred.await(requesting)),
            Effect.andThen(memory.storage.deleteAlarm()),
            Effect.andThen(Effect.sync(() => {
              armed = true
            }))
          )
      }, { flows: NestedFlows.flows, runtime, router: Objects.unrouted })
      yield* Effect.gen(function*() {
        yield* host.start(yield* ExecutionObject.intent(NestedFlows.Patient, { executionId, payload: {} }))
        const alarm = yield* Effect.forkChild(host.alarm())
        yield* Deferred.await(parking)
        const cancel = yield* Effect.forkChild(host.cancel())
        expect(yield* Fiber.join(alarm)).toEqual({ _tag: "Parked", wakeAtMs: null })
        yield* Fiber.join(cancel)
        // The cancel's own alarm survives the parking alarm, so the object
        // finishes the cancellation without another wake.
        expect(memory.alarm()).not.toBeNull()
        expect(
          yield* ExecutionObject.make(memory.storage, {
            flows: NestedFlows.flows,
            runtime: base,
            router: Objects.unrouted
          }).alarm()
        ).toMatchObject({ _tag: "Settled" })
        expect(
          yield* Effect.promise(() =>
            Postgres.admin(Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{ status: string }>`SELECT status FROM ${sql(schema)}.flows_runs`
            }))
          )
        ).toEqual([{ status: "cancelled" }])
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(schema))))
    }))
})
