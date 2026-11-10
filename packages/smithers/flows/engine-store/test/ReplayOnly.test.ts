import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * A replay-only engine serves recorded dispatches and executes none.
 *
 * The run is parked by an ordinary engine, then driven again by a second
 * engine composed with `ReplayOnly` over the same store, the way
 * `smthrs runs verify` drives a copy of a project's store under current code.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as EngineStore from "../src/EngineStore.ts"
import * as ReplayOnly from "../src/ReplayOnly.ts"
import * as StepBoundary from "../src/StepBoundary.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { remoteTestDatabases } from "./fixtures/RemoteTestDatabase.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "replay-only" as never, changeId: "replay-only" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | DurableEngineState.DurableEngineState
  | Jj.Jj
  | TestClock.TestClock
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | Scope.Scope

const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  withCrypto(
    Effect.scoped(body).pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.provide(TestClock.layer())
    )
  )

const engineFor = (hostId: string) =>
  Effect.map(
    EngineStore.make({ owner: { hostId }, journalSource: hostId, isAlive: () => Effect.succeed(false) }),
    (engine) => engine as FlowRuntime.FlowRuntime["Service"]
  )

const VerifiedFlow = Flow.make("ReplayOnly/Flow", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const gate = DurableDeferred.make("replay-only-gate", { success: Schema.String })
const Refused = Schema.Struct({ _tag: Schema.Literal("Refused") })

/** Counts body runs per action name, so a replay that executed anything shows. */
const bodies = () => {
  const ran: Array<string> = []
  const action = (name: string, tier: Action.Tier) =>
    Action.make({
      name,
      tier,
      success: Schema.String,
      execute: Effect.sync(() => {
        ran.push(name)
        return `${name}-result`
      })
    })
  return { ran, action }
}

/** The steps a fixture flow dispatches before it parks on the gate. */
type Steps = Effect.Effect<
  unknown,
  never,
  FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | (EffectDigest.Digest | SecureRandom.SecureRandom)
>

/** Parks the run after its steps, under an ordinary engine that is then shut down. */
const park = (steps: Steps) =>
  Effect.scoped(Effect.gen(function*() {
    const engine = yield* engineFor("replay-only-origin")
    yield* engine.register(VerifiedFlow, () => Effect.andThen(steps, DurableDeferred.await(gate)))
    yield* executeUntilParked(engine, VerifiedFlow, { executionId: "verified", payload: {}, discard: true })
  }))

/** Drives the parked run again with a replay-only engine, returning what it reported. */
const verify = (steps: Steps) =>
  Effect.scoped(Effect.gen(function*() {
    const seen: Array<ReplayOnly.Dispatch> = []
    const engine = yield* engineFor("replay-only-verifier").pipe(
      Effect.provide(ReplayOnly.layer((dispatch) => Effect.sync(() => seen.push(dispatch))))
    )
    let drives = 0
    yield* engine.register(
      VerifiedFlow,
      () => Effect.sync(() => drives++).pipe(Effect.andThen(steps), Effect.andThen(DurableDeferred.await(gate)))
    )
    // The run is already parked, so its status alone cannot say the verifier
    // re-drove it: wait for the body to be entered, then for the run to settle.
    yield* engine.execute(VerifiedFlow, { executionId: "verified", payload: {}, discard: true })
    const runs = yield* RunStore.RunStore
    yield* TestDatabase.until(
      Effect.map(
        runs.get("verified"),
        (row) => drives > 0 && row.owner === null && (row.status === "suspended" || row.status === "failed")
      )
    )
    const row = yield* runs.get("verified")
    return { seen, row }
  }))

/** The attempt row a step key was recorded under, if any. */
const attempt = (stepKeyDigest: string) =>
  Effect.flatMap(
    AttemptStore.AttemptStore,
    (attempts) => Effect.map(attempts.get({ runId: "verified", stepKeyDigest, attempt: 1 }), Option.getOrUndefined)
  )

describe("ReplayOnly", () => {
  it.effect("a corrupt recorded attempt fails verification without reporting replay or executing its body", () =>
    withCrypto(Effect.scoped(Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "replay-corruption-")))
      const databases = remoteTestDatabases(directory)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await databases.close()
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        })
      )
      return yield* Effect.gen(function*() {
        const { ran, action } = bodies()
        const recorded = action("ReplayOnly/corrupt", "sealed")
        yield* park(recorded)
        const sql = yield* SqlClient.SqlClient
        // Model damaged persisted bytes, which normal writes correctly reject.
        yield* TestDatabase.checks(sql, false)
        yield* sql`UPDATE flows_attempts SET meta_json = '{' WHERE run_id = 'verified'`.pipe(
          Effect.ensuring(TestDatabase.checks(sql, true).pipe(Effect.orDie))
        )
        const { seen, row } = yield* verify(recorded)
        expect(row.status).toBe("failed")
        expect(seen).toEqual([])
        expect(ran).toEqual(["ReplayOnly/corrupt"])
        expect(JSON.stringify(JSON.parse(row.stateJson).result)).toContain("decode_failed")
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(databases.filename("corrupt-attempt"))),
        Effect.provide(TestClock.layer())
      )
    }))))

  it.effect("an unchanged flow replays every recorded step and parks where it was", () =>
    run(Effect.gen(function*() {
      const { ran, action } = bodies()
      const steps = Effect.andThen(action("ReplayOnly/a", "sealed"), action("ReplayOnly/b", "irreversible"))
      yield* park(steps)
      const { seen, row } = yield* verify(steps)

      expect(ran).toEqual(["ReplayOnly/a", "ReplayOnly/b"])
      expect(row.status).toBe("suspended")
      expect(seen.map((dispatch) => [dispatch.action, dispatch.outcome, dispatch.tier])).toEqual([
        ["ReplayOnly/a", "replayed", "sealed"],
        ["ReplayOnly/b", "replayed", "irreversible"]
      ])
      for (const dispatch of seen) expect((yield* attempt(dispatch.stepKeyDigest))?.state).toBe("succeeded")
      expect(seen.every((dispatch) => dispatch.runId === "verified" && dispatch.attempt === 1)).toBe(true)
    })))

  it.effect("a changed authored plan is observed separately and still executes no new action", () =>
    run(Effect.gen(function*() {
      const ran: Array<string> = []
      const seen: Array<ReplayOnly.Dispatch> = []
      const first = Action.make("ReplayOnly/declared-first", {
        payload: {},
        success: Schema.String,
        tier: "irreversible"
      })
      const second = Action.make("ReplayOnly/declared-second", {
        payload: {},
        success: Schema.String,
        tier: "irreversible"
      })
      const changed = Action.make("ReplayOnly/declared-changed", {
        payload: {},
        success: Schema.String,
        tier: "irreversible"
      })
      const wait = Action.make("ReplayOnly/declared-wait", { payload: {}, success: Schema.String })
      const flowFor = (choice: typeof second | typeof changed) =>
        Flow.make("ReplayOnly/Declared", {
          payload: {},
          success: Schema.String,
          body: Node.capture({ action: choice.name }, () =>
            first.call({}).pipe(
              Node.andThen<
                string,
                never,
                Action.Requirement<"ReplayOnly/declared-second"> | Action.Requirement<"ReplayOnly/declared-changed">
              >(choice.call({})),
              Node.andThen(wait.call({}))
            ))
        })
      const observe = (choice: typeof second | typeof changed, verification: boolean) =>
        Effect.scoped(Effect.gen(function*() {
          const make = engineFor("same-plan-producer")
          const engine = yield* (verification ?
            make.pipe(Effect.provide(ReplayOnly.layer((event) => Effect.sync(() => seen.push(event))))) :
            make)
          const flow = flowFor(choice)
          const implementations = Layer.mergeAll(
            first.toLayer(() =>
              Effect.sync(() => {
                ran.push(first.name)
                return "first"
              })
            ),
            choice.toLayer(() =>
              Effect.sync(() => {
                ran.push(choice.name)
                return "second"
              })
            ),
            wait.toLayer(() => DurableDeferred.await(gate)),
            Interpreter.layer(flow)
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
          )
          if (!verification) {
            yield* executeUntilParked(engine, flow, { executionId: "authored", payload: {}, discard: true }).pipe(
              Effect.provide(implementations)
            )
          } else {
            yield* Effect.gen(function*() {
              yield* flow.execute({}, { executionId: "authored", discard: true })
              const runs = yield* RunStore.RunStore
              yield* TestDatabase.until(Effect.map(runs.get("authored"), (row) => row.status === "failed"))
            }).pipe(Effect.provide(implementations))
          }
        })).pipe(Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()))
      yield* observe(second, false)
      const journal = yield* Journal.Journal
      const before = yield* journal.entries({
        runId: JournalEvent.RunId.make("authored"),
        eventTypes: ["flows.engine.plan-recorded"],
        limit: 100
      })
      yield* observe(changed, true)
      expect(ran).toEqual([first.name, second.name])
      expect(seen.map((event) => [event.action, event.outcome])).toEqual([
        [first.name, "replayed"],
        [changed.name, "would-execute"]
      ])
      expect(yield* attempt(seen[1]!.stepKeyDigest)).toBeUndefined()
      const after = yield* journal.entries({
        runId: JournalEvent.RunId.make("authored"),
        eventTypes: ["flows.engine.plan-recorded"],
        limit: 100
      })
      expect(after.entries).toHaveLength(2)
      expect(after.entries[0]).toEqual(before.entries[0])
      expect(new Set(after.entries.map((entry) => entry.sourceId)).size).toBe(2)
    })))

  it.effect("a re-keyed step stops at the gate before any attempt, body or retry", () =>
    run(Effect.gen(function*() {
      const { ran, action } = bodies()
      yield* park(Effect.andThen(action("ReplayOnly/a", "sealed"), action("ReplayOnly/b", "irreversible")))
      const renamed = Action.make({
        name: "ReplayOnly/b-renamed",
        tier: "irreversible",
        idempotencyKey: "b",
        success: Schema.String,
        // A typed failure would retry forever under this policy; the gate's
        // defect is never retried, so the run settles after one refusal.
        retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1 }),
        execute: Effect.sync(() => {
          ran.push("ReplayOnly/b-renamed")
          return "unexpected"
        })
      })
      const { seen, row } = yield* verify(Effect.andThen(action("ReplayOnly/a", "sealed"), renamed))

      expect(ran).toEqual(["ReplayOnly/a", "ReplayOnly/b"])
      expect(row.status).toBe("failed")
      expect(seen.map((dispatch) => [dispatch.action, dispatch.outcome])).toEqual([
        ["ReplayOnly/a", "replayed"],
        ["ReplayOnly/b-renamed", "would-execute"]
      ])
      const refused = seen[1]!
      expect(refused.tier).toBe("irreversible")
      // No attempt row was admitted for the refused key.
      expect(yield* attempt(refused.stepKeyDigest)).toBeUndefined()
      expect((yield* attempt(seen[0]!.stepKeyDigest))?.state).toBe("succeeded")
    })))

  it.effect("a recorded failure the flow recovered from replays as a failure, not a new attempt", () =>
    run(Effect.gen(function*() {
      let failures = 0
      const failing = Action.make({
        name: "ReplayOnly/failing",
        tier: "sealed",
        success: Schema.String,
        error: Refused,
        execute: Effect.suspend(() => {
          failures += 1
          return Effect.fail({ _tag: "Refused" as const })
        })
      })
      const steps = failing.pipe(Effect.catch(() => Effect.succeed("recovered")))
      yield* park(steps)
      const { seen, row } = yield* verify(steps)

      expect(failures).toBe(1)
      expect(row.status).toBe("suspended")
      expect(seen.map((dispatch) => [dispatch.action, dispatch.outcome])).toEqual([["ReplayOnly/failing", "replayed"]])
    })))

  it.effect("a step parked inside its own body is re-entered, reported as resumes", () =>
    run(Effect.gen(function*() {
      let entered = 0
      const inner = DurableDeferred.make("replay-only-inner", { success: Schema.String })
      const waiter = Action.make({
        name: "ReplayOnly/waiter",
        tier: "irreversible",
        idempotencyKey: "waiter",
        success: Schema.String,
        execute: Effect.suspend(() => {
          entered += 1
          return DurableDeferred.await(inner)
        })
      })
      yield* park(waiter)
      const { seen, row } = yield* verify(waiter)

      expect(entered).toBe(1)
      expect(row.status).toBe("failed")
      expect(seen.map((dispatch) => [dispatch.action, dispatch.outcome])).toEqual([["ReplayOnly/waiter", "resumes"]])
      expect((yield* attempt(seen[0]!.stepKeyDigest))?.state).toBe("running")
    })))

  it("names the refused dispatch in its message", () => {
    const refused = new ReplayOnly.WouldExecute({ runId: "r", stepKeyDigest: "d", attempt: 2, action: "a" })
    expect(refused.message).toBe("Action a (step d, attempt 2) would execute")
  })
})
