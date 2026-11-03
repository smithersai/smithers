/**
 * Executions that span several Durable Objects, one object per execution: a
 * parent and the child it runs as its own execution, a lineage of rounds
 * that hand off to each other, and a parent whose child fails. Each object
 * builds a fresh runtime, a new incarnation, for every alarm, over the same
 * store, and reaches the others only through its `Router`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { randomUUID } from "node:crypto"
import { ExecutionObject } from "../src/index.ts"
import * as Routing from "../src/internal/Routing.ts"
import {
  Child,
  Cleanup,
  Counter,
  flows,
  Guardian,
  Holder,
  Keeper,
  Parent,
  Patient,
  Relay,
  runtime,
  Supervisor
} from "./fixtures/NestedFlows.ts"
import * as Objects from "./fixtures/Objects.ts"
import * as Postgres from "./fixtures/Postgres.ts"
import * as StatementTrace from "./fixtures/StatementTrace.ts"

/** The rows a case's schema holds, oldest first: each run's id, flow, status and parent. */
const runsIn = (schema: string) =>
  Effect.promise(() =>
    Postgres.admin(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly run_id: string; readonly status: string; readonly state_json: string }>`
        SELECT run_id, status, state_json FROM ${sql(schema)}.flows_runs ORDER BY created_at_ms, round_ordinal`
      return rows.map((row) => {
        const state = JSON.parse(row.state_json) as { readonly flowName: string; readonly result?: unknown }
        return { id: row.run_id, flow: state.flowName, status: row.status, result: state.result }
      })
    }))
  )

/** Whether the `Parent` run is still in its drive (`running`), read from the store. */
const parentDriving = (runs: Effect.Effect<ReadonlyArray<{ readonly flow: string; readonly status: string }>>) =>
  Effect.map(runs, (rows) => rows.find((run) => run.flow === Parent._tag)?.status === "running")

class RouteFailed extends Schema.TaggedError<RouteFailed>()("RouteFailed", {}) {}

/**
 * One case's objects over a fresh schema, every step recorded in `steps`. A
 * step `hang` names never returns, the first time it runs, once it has
 * completed `started`.
 */
const setup = (
  target: Postgres.Target,
  options: {
    readonly router?: (objects: Objects.Objects) => ExecutionObject.Router<unknown>
    readonly hang?: { readonly label: string; readonly started: Deferred.Deferred<void> }
  } = {}
) => {
  const schema = Postgres.freshSchema()
  const steps: Array<string> = []
  const record = (label: string) =>
    Effect.gen(function*() {
      const first = !steps.includes(label)
      steps.push(label)
      if (first && options.hang?.label === label) {
        yield* Deferred.succeed(options.hang.started, undefined)
        return yield* Effect.never
      }
      return label
    })
  const router = options.router
  const objects = Objects.make({
    flows,
    runtime: runtime({ record, database: Postgres.database(schema, target.url) }),
    ...(router === undefined ? {} : { router })
  })
  const cleanup = Effect.promise(() => Postgres.dropSchema(schema))
  return { schema, steps, objects, cleanup, runs: runsIn(schema) }
}

/**
 * Every object's alarm, by execution id: `"forget"` when it is a settled
 * object's final alarm, at the end of its retention window, so every alarm is
 * `null` or `"forget"` once the objects are quiet.
 */
const alarms = (objects: Objects.Objects) =>
  Object.fromEntries([...objects.objects].map(([id, storage]) => {
    const at = storage.alarm()
    const settledAt = storage.values.get(ExecutionObject.settledKey) as number | undefined
    return [id, settledAt !== undefined && at === settledAt + ExecutionObject.settledRetentionMs ? "forget" : at]
  }))

/** A `Settled` outcome, whatever window it was armed to forget at. */
const settled = { _tag: "Settled", forgetAtMs: expect.any(Number) }

for (const target of Postgres.targets) {
  describe.skipIf(!target.available)(`executions across objects over ${target.label}`, () => {
    it.live("a child that settles while its parent's alarm is still routing it wakes the parent all the same", () => {
      // The child's object runs its alarm the moment it is started, inside
      // the parent's routing: its settlement wakes the parent before the
      // parent's alarm has armed what its own drive left. A start during the
      // parent's drive is refused, so the child starts only from that routing.
      const c = setup(target, {
        router: (objects) => ({
          start: (intent) =>
            Effect.gen(function*() {
              if (yield* parentDriving(c.runs)) return yield* new RouteFailed()
              yield* objects.router.start(intent)
              yield* objects.alarm(intent.executionId)
            }),
          wake: objects.router.wake
        })
      })
      const parentId = `parent-${randomUUID()}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Parent, { executionId: parentId, payload: { label: "fast" } })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        const before = Date.now()
        const parked = yield* c.objects.alarm(parentId)
        // The drive parked on the child with no wake of its own; the store,
        // read again after arming, says the child's settlement made it due.
        expect(parked).toEqual({ _tag: "Parked", wakeAtMs: expect.any(Number) })
        expect((parked as { readonly wakeAtMs: number }).wakeAtMs).toBeGreaterThanOrEqual(before)
        expect((parked as { readonly wakeAtMs: number }).wakeAtMs).toBeLessThanOrEqual(Date.now())
        expect(c.objects.object(parentId).alarm()).toBe((parked as { readonly wakeAtMs: number }).wakeAtMs)

        yield* c.objects.run()
        expect((yield* c.runs).map((run) => run.status)).toEqual(["completed", "completed"])
        expect(c.steps).toEqual(["child:fast", "parent:child:fast"])
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.live("a router that fails retries with backoff, and the next alarm routes what the drive left", () => {
      let failures = 1
      const c = setup(target, {
        router: (objects) => ({
          // Every start during the parent's drive fails as well, so only the routing after it starts the child.
          start: (intent) =>
            Effect.gen(function*() {
              if ((yield* parentDriving(c.runs)) || failures-- > 0) return yield* new RouteFailed()
              yield* objects.router.start(intent)
            }),
          wake: objects.router.wake
        })
      })
      const parentId = `parent-${randomUUID()}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Parent, { executionId: parentId, payload: { label: "again" } })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        const before = Date.now()
        expect(yield* c.objects.alarm(parentId)).toMatchObject({ _tag: "Retrying", attempt: 1, failure: "RouteFailed" })
        expect(c.objects.object(parentId).alarm()).toBeGreaterThanOrEqual(before + 1_000)
        expect([...c.objects.objects.keys()]).toEqual([parentId])

        // The watchdog's alarm, fired early here: nothing is due to drive,
        // and the routing the last alarm failed runs again.
        expect(yield* c.objects.alarm(parentId)).toEqual({ _tag: "Parked", wakeAtMs: null })
        yield* c.objects.run()
        expect((yield* c.runs).map((run) => run.status)).toEqual(["completed", "completed"])
        expect(c.steps).toEqual(["child:again", "parent:child:again"])
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.live("a cancelled parent's routing wakes the current round of the child lineage it asked to cancel", () => {
      const c = setup(target)
      const parentId = `supervisor-${randomUUID()}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Supervisor, { executionId: parentId, payload: {} })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        yield* c.objects.run()
        // The child's first round handed off on its own object, and the
        // second parked on an object of its own.
        expect((yield* c.runs).map(({ flow, status }) => ({ flow, status }))).toEqual([
          { flow: Supervisor._tag, status: "suspended" },
          { flow: Relay._tag, status: "completed" },
          { flow: Patient._tag, status: "suspended" }
        ])
        expect(Object.values(alarms(c.objects))).toEqual([null, "forget", null])

        // The app cancels the parent, then wakes its object.
        yield* Supervisor.interrupt(parentId).pipe(
          Effect.provide(runtime({ record: Effect.succeed, database: Postgres.database(c.schema, target.url) })(intent))
        )
        yield* c.objects.router.wake(parentId)
        yield* c.objects.run()

        const runs = yield* c.runs
        expect(runs.map((run) => run.status)).toEqual(["cancelled", "completed", "cancelled"])
        expect(c.objects.outcomes.get(runs[2]!.id)).toEqual([{ _tag: "Parked", wakeAtMs: null }, settled])
        expect(Object.values(alarms(c.objects))).toEqual(["forget", "forget", "forget"])
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.live("a parked child cancelled with its parent starts its declared cancellation run on an object of its own", () => {
      const c = setup(target)
      const parentId = `keeper-${randomUUID()}`
      const label = randomUUID()
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Keeper, { executionId: parentId, payload: { label } })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        yield* c.objects.run()
        expect((yield* c.runs).map(({ flow, status }) => ({ flow, status }))).toEqual([
          { flow: Keeper._tag, status: "suspended" },
          { flow: Holder._tag, status: "suspended" }
        ])

        // The app cancels the parent, then wakes its object: the parked child's object closes it, nothing of its
        // body runs again, and its routing starts the cancellation run the child's flow declared.
        yield* Keeper.interrupt(parentId).pipe(
          Effect.provide(runtime({ record: Effect.succeed, database: Postgres.database(c.schema, target.url) })(intent))
        )
        yield* c.objects.router.wake(parentId)
        yield* c.objects.run()

        const runs = yield* c.runs
        expect(runs.map(({ flow, id, status }) => ({ flow, id, status }))).toEqual([
          { flow: Keeper._tag, id: parentId, status: "cancelled" },
          { flow: Holder._tag, id: expect.any(String), status: "cancelled" },
          { flow: Cleanup._tag, id: `cleanup:${label}`, status: "completed" }
        ])
        expect(c.steps).toEqual([`cleanup:${label}`])
        expect(c.objects.outcomes.get(`cleanup:${label}`)).toEqual([settled])
        expect(Object.values(alarms(c.objects))).toEqual(["forget", "forget", "forget"])
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.live("a parent starts its child's object as soon as the child is admitted, before its own drive parks", () => {
      // A TODO's agent session waited about two seconds on smithers.sh for its parent's drive to park and route it.
      // Each start records what the parent's row said at that moment: `running` is during the parent's drive.
      const starts: Array<string> = []
      const c = setup(target, {
        router: (objects) => ({
          start: (intent) =>
            Effect.gen(function*() {
              const parent = (yield* c.runs).find((run) => run.flow === Parent._tag)
              starts.push(`${intent.flow} while the parent is ${parent?.status}`)
              yield* objects.router.start(intent)
            }),
          wake: objects.router.wake
        })
      })
      const parentId = `parent-${randomUUID()}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Parent, { executionId: parentId, payload: { label: "early" } })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        yield* c.objects.alarm(parentId)
        // The routing after the drive starts it again, which its object answers as a duplicate.
        expect(starts).toEqual([
          `${Child._tag} while the parent is running`,
          `${Child._tag} while the parent is suspended`
        ])

        yield* c.objects.run()
        expect((yield* c.runs).map((run) => run.status)).toEqual(["completed", "completed"])
        expect(c.steps).toEqual(["child:early", "parent:child:early"])
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.live("a child start that fails during the drive is left to the routing after it", () => {
      let failed = 0
      const c = setup(target, {
        router: (objects) => ({
          start: (intent) =>
            Effect.gen(function*() {
              if (yield* parentDriving(c.runs)) {
                failed++
                return yield* new RouteFailed()
              }
              yield* objects.router.start(intent)
            }),
          wake: objects.router.wake
        })
      })
      const parentId = `parent-${randomUUID()}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Parent, { executionId: parentId, payload: { label: "late" } })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        expect(yield* c.objects.alarm(parentId)).toEqual({ _tag: "Parked", wakeAtMs: null })
        expect(failed).toBe(1)
        yield* c.objects.run()
        expect((yield* c.runs).map((run) => run.status)).toEqual(["completed", "completed"])
        expect(c.steps).toEqual(["child:late", "parent:child:late"])
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.live("a parent starts its child on the child's own object, and the child's settlement wakes it", () => {
      const c = setup(target)
      const parentId = `parent-${randomUUID()}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Parent, { executionId: parentId, payload: { label: "hi" } })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        yield* c.objects.run()

        const runs = yield* c.runs
        expect(runs.map(({ flow, status }) => ({ flow, status }))).toEqual([
          { flow: Parent._tag, status: "completed" },
          { flow: Child._tag, status: "completed" }
        ])
        const childId = runs[1]!.id
        expect(c.steps).toEqual(["child:hi", "parent:child:hi"])
        expect([...c.objects.objects.keys()]).toEqual([parentId, childId])
        expect(c.objects.outcomes.get(parentId)).toEqual([{ _tag: "Parked", wakeAtMs: null }, settled])
        expect(c.objects.outcomes.get(childId)).toEqual([settled])
        expect(alarms(c.objects)).toEqual({ [parentId]: "forget", [childId]: "forget" })

        // A duplicate alarm on either object runs no step again and routes nothing.
        expect(yield* c.objects.alarm(childId)).toEqual(c.objects.outcomes.get(childId)![0])
        expect(yield* c.objects.alarm(parentId)).toEqual(c.objects.outcomes.get(parentId)![1])
        expect(c.steps).toEqual(["child:hi", "parent:child:hi"])
        expect(alarms(c.objects)).toEqual({ [parentId]: "forget", [childId]: "forget" })
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.live("a drive's routing reads the store as one read transaction", () => {
      const c = setup(target)
      const parentId = `parent-${randomUUID()}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Parent, { executionId: parentId, payload: { label: "one" } })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        yield* c.objects.run()
        const childId = (yield* c.runs)[1]!.id
        // What the child's settlement left, read again through a proxy that sees every statement.
        const scope = yield* Scope.make()
        const trace = yield* Scope.provide(StatementTrace.proxy(target.url), scope)
        const layer = runtime({ record: Effect.succeed, database: Postgres.database(c.schema, trace.url) })(
          yield* ExecutionObject.intent(Child, { executionId: childId, payload: { label: "one" } })
        )
        const routed = yield* Effect.scoped(
          Effect.gen(function*() {
            const before = trace.statements.length
            const routes = yield* Routing.routes(childId)
            return { routes, statements: trace.statements.slice(before).map((statement) => statement.sql) }
          }).pipe(Effect.provide(layer))
        ).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
        expect(routed.routes).toEqual({ start: [], wake: [] })
        expect(routed.statements.filter((sql) => sql.startsWith("BEGIN"))).toEqual([
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        ])
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.live("a child's alarm reads its run's row once for what never changes before its claim", () => {
      const schema = Postgres.freshSchema()
      return Effect.gen(function*() {
        const scope = yield* Scope.make()
        const trace = yield* Scope.provide(StatementTrace.proxy(target.url), scope)
        const objects = Objects.make({
          flows,
          runtime: runtime({ record: Effect.succeed, database: Postgres.database(schema, trace.url) })
        })
        const parentId = `parent-${randomUUID()}`
        const intent = yield* ExecutionObject.intent(Parent, { executionId: parentId, payload: { label: "once" } })
        yield* ExecutionObject.start(objects.object(parentId).storage, intent, Effect.void)
        yield* objects.alarm(parentId)
        const childId = [...objects.objects.keys()].find((id) => id !== parentId)!
        const from = trace.statements.length
        yield* objects.alarm(childId)
        const statements = trace.statements.slice(from).map((statement) => statement.sql)
        const claim = statements.findIndex((sql) => sql.includes("UPDATE flows_runs SET claim_host_id"))
        // Each read outside a transaction costs four round trips on PostgreSQL. Before the claim: the object's read,
        // whose existence and identity the drive reuses; the resume's fresh status; the drive's own; and the claim's
        // locked read. The engine's existence read and its control check's read are gone.
        expect(
          statements.slice(0, claim).filter((sql) => sql.includes("SELECT run_id AS \"runId\", status AS \"status\""))
        )
          .toHaveLength(4)
        yield* Scope.close(scope, Exit.void)
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(schema))))
    })

    it.live("a child's alarm costs at most 193 round trips: a lone read of an engine table is one", () => {
      const schema = Postgres.freshSchema()
      return Effect.gen(function*() {
        const scope = yield* Scope.make()
        const trace = yield* Scope.provide(StatementTrace.proxy(target.url), scope)
        const objects = Objects.make({
          flows,
          runtime: runtime({ record: Effect.succeed, database: Postgres.database(schema, trace.url) })
        })
        const parentId = `parent-${randomUUID()}`
        const intent = yield* ExecutionObject.intent(Parent, { executionId: parentId, payload: { label: "once" } })
        yield* ExecutionObject.start(objects.object(parentId).storage, intent, Effect.void)
        yield* objects.alarm(parentId)
        const childId = [...objects.objects.keys()].find((id) => id !== parentId)!
        const before = trace.roundTrips()
        yield* objects.alarm(childId)
        // 276 before a lone read named its schema and consecutive savepoints shared one (2026-11-03).
        expect(trace.roundTrips() - before).toBeLessThanOrEqual(193)
        yield* Scope.close(scope, Exit.void)
      }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(schema))))
    })

    it.live("a child's failure fails its parent", () => {
      const c = setup(target)
      const parentId = `guardian-${randomUUID()}`
      return Effect.gen(function*() {
        const intent = yield* ExecutionObject.intent(Guardian, { executionId: parentId, payload: {} })
        yield* ExecutionObject.start(c.objects.object(parentId).storage, intent, Effect.void)
        yield* c.objects.run()

        const runs = yield* c.runs
        expect(runs.map(({ flow, status }) => ({ flow, status }))).toEqual([
          { flow: Guardian._tag, status: "failed" },
          { flow: "cloudflare-test/Faulty", status: "failed" }
        ])
        // The parent failed with the child's own declared error, not a defect.
        expect(JSON.stringify(runs[0]!.result)).toContain("SleepRequestInvalid")
        expect(c.objects.outcomes.get(parentId)).toEqual([{ _tag: "Parked", wakeAtMs: null }, settled])
        expect(alarms(c.objects)).toEqual({ [parentId]: "forget", [runs[1]!.id]: "forget" })
      }).pipe(Effect.ensuring(c.cleanup))
    })

    it.effect("each round of a lineage runs on its own object, and one reset in a round's step resumes there", () => {
      const started = Deferred.makeUnsafe<void>()
      const c = setup(target, { hang: { label: "bump:1", started } })
      const rootId = `counter-${randomUUID()}`
      return Effect.gen(function*() {
        yield* TestClock.setTime(Date.now())
        const intent = yield* ExecutionObject.intent(Counter, {
          executionId: rootId,
          payload: { value: 0, target: 3 }
        })
        yield* ExecutionObject.start(c.objects.object(rootId).storage, intent, Effect.void)
        // Round zero runs and hands off; its object starts round one's.
        yield* c.objects.alarm(rootId)
        const [, roundOne] = [...c.objects.objects.keys()]
        expect(roundOne).toEqual(expect.any(String))

        // Round one's object is reset inside its step: the alarm's fiber is
        // interrupted once the step has started, as an isolate reset ends it.
        const fiber = yield* Effect.forkChild(c.objects.alarm(roundOne!))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)

        // The watchdog the reset alarm left armed fires one backoff later, in
        // a new incarnation, and the lineage runs to its end.
        yield* c.objects.run(TestClock.setTime)

        const runs = yield* c.runs
        expect(runs.map(({ flow, status }) => ({ flow, status }))).toEqual([
          { flow: Counter._tag, status: "completed" },
          { flow: Counter._tag, status: "completed" },
          { flow: Counter._tag, status: "completed" }
        ])
        expect(runs.map((run) => run.id)).toEqual([...c.objects.objects.keys()])
        expect(JSON.stringify(runs[2]!.result)).toContain("3")
        expect(c.steps).toEqual(["bump:0", "bump:1", "bump:1", "bump:2"])
        // Advancing the clock fired each settled round's final alarm too: every
        // object has forgotten its round and holds nothing.
        expect(Object.values(alarms(c.objects))).toEqual([null, null, null])
        expect([...c.objects.objects.values()].map((object) => object.values.size)).toEqual([0, 0, 0])
        expect([...c.objects.outcomes.values()].map((outcomes) => outcomes.at(-1))).toEqual([
          { _tag: "Forgotten" },
          { _tag: "Forgotten" },
          { _tag: "Forgotten" }
        ])
      }).pipe(Effect.ensuring(c.cleanup))
    })
  })
}
