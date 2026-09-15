/**
 * A nested human wait seen from a host that runs TWO databases.
 *
 * `@smthrs/control` `SqlControlRuntime` can compute a run tree's open human
 * waits itself when it shares a database with the engine. A deployed host does
 * not: `@smthrs/cli` `NativeControl` keeps the control plane's coordination
 * rows in `control.db` and every execution a flow spawns in `engine.db`, and
 * the comment on that composition says why — leaking the engine's stores back
 * would silently redirect `ControlLive` to the wrong database.
 *
 * So on the production coding host the rollup found nothing. Workspace
 * 6f2733a3 had `coding/PreparePlan` parked on `coding-clarification` with its
 * `waiting_request` written and `flows_run_parents` linking it up through
 * three ancestors to `run-1`, all in `engine.db`, while
 * `List {status: "waiting-approval"}` answered `[]`, `List {}` answered
 * `run-1` as `parked` on an `event` with no `pendingWaits`, and the approvals
 * projection had no rows.
 *
 * The one reader of both databases is `ControlExecutor.readExecution`, whose
 * answer `ControlLive.observe` writes over the control plane's own copy. This
 * suite is that topology: two databases, the production observation port, and
 * the gateway read path on top.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as AgentSession from "@smthrs/agent/AgentSession"
import { Control } from "@smthrs/control/Control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import type { PlanCard } from "@smthrs/control/ControlSchema"
import type { DurableFlow } from "@smthrs/control/SqlControlRuntime"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import * as Projections from "@smthrs/gateway/Projections"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Jj } from "@smthrs/kernel"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Context, Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"

const prompt = "Which service owns the retry budget?"
const flowId = "coding/Request"

/** The execution that asks the person, three `.child()` boundaries down. */
const PreparePlan = Flow.make("coding/PreparePlan", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => HumanTask.action.call({ name: "coding-clarification", kind: "ask", prompt, maxAttempts: 3 })
})

const PrepareWithWiki = Flow.make("coding/PrepareWithWiki", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => PreparePlan.child({})
})

const Request = Flow.make(flowId, {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => PrepareWithWiki.child({})
})

/** The one flow the control plane may plan, declared the way a host declares it. */
const durableFlow: DurableFlow = {
  flowId,
  description: "The nested human wait suite's flow",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
}

const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "nested-wait-suite" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * The ENGINE's database. Its own `TestDatabase`, which is the point: the
 * control plane below builds its own, exactly as a host does.
 *
 * `Layer.fresh` wraps the whole storage graph for the reason `NativeControl`
 * gives: every store layer here is a singleton, and one shared memo map would
 * otherwise hand the engine the control plane's instances over the other
 * database — which is one database again, and not the topology under test.
 */
const engineDatabase = Layer.fresh(
  Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(
    Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
    Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
  )
)

/**
 * The engine, reachable from the control plane's side and nothing else.
 *
 * Only these four closures cross back, as only the executor crosses back in a
 * host composition. The engine's `RunStore` and `DurableEngineState` stay
 * inside: a control plane that could see them would not be the topology under
 * test.
 */
class Engine extends Context.Service<Engine, {
  readonly start: (runId: string) => Effect.Effect<void>
  readonly observe: (runId: string) => Effect.Effect<ControlExecutor.ExecutionObservation>
  readonly deliverSignal: (input: ControlExecutor.Signal) => Effect.Effect<ControlExecutor.SignalDelivery>
  /** Polls until an execution BELOW `runId` is parked on a human wait. */
  readonly parkedBelow: (runId: string) => Effect.Effect<DurableEngineState.WaitingRow>
}>()("smithers/test/NestedEngine") {}

const engineLayer = Layer.effect(Engine)(
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof Request.execute>>>()
    const parkedBelow = (
      runId: string,
      attempts = 4_000
    ): Effect.Effect<DurableEngineState.WaitingRow> =>
      Effect.gen(function*() {
        const open = yield* state.waitingTree(runId)
        const human = open.find((row) => row.reason === "approval" && row.runId !== runId)
        if (human !== undefined) return human
        if (attempts <= 0) return yield* Effect.die(`no execution below ${runId} parked on a human wait`)
        yield* Effect.yieldNow
        return yield* parkedBelow(runId, attempts - 1)
      })
    return {
      start: (runId: string) =>
        Effect.provideContext(
          Effect.asVoid(Request.execute({}, { executionId: runId, discard: true })),
          services
        ) as Effect.Effect<void>,
      observe: (runId: string) =>
        Effect.orDie(AgentSession.readExecution(runId)) as Effect.Effect<
          ControlExecutor.ExecutionObservation
        >,
      deliverSignal: (input: ControlExecutor.Signal) =>
        Effect.orDie(AgentSession.deliverSignal(input)) as Effect.Effect<ControlExecutor.SignalDelivery>,
      parkedBelow
    }
  })
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      HumanTask.layer,
      Interpreter.layer(Request),
      Interpreter.layer(PrepareWithWiki),
      Interpreter.layer(PreparePlan)
    )
      .pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(
          EngineStore.layer({
            owner: { hostId: "nested-wait-suite" },
            journalSource: "nested-wait-suite",
            isAlive: () => Effect.succeed(false)
          })
        ),
        Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), stubJj, OwnerIdentity.layer)),
        Layer.provideMerge(engineDatabase)
      )
  )
)

/** The CONTROL plane's database: its own file, its own migrations. */
const controlDatabase = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(
  Layer.provideMerge(Layer.merge(JournalMigrations.layer, RunStoreMigrations.layer)),
  Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
)

/** The acceptance and observation ports, both answered by the engine. */
const executor = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const engine = yield* Engine
    const scope = yield* Effect.scope
    return ControlExecutor.makeNoop({
      readExecution: (runId) => engine.observe(runId),
      deliverSignal: (input) => engine.deliverSignal(input),
      // Started and not awaited, as a host starts an accepted launch: the
      // run parks, and acceptance is not its settlement.
      launch: (input) => Effect.as(Effect.forkIn(engine.start(input.run.runId), scope), "accepted" as const)
    })
  })
)

const stack = Projections.layerWith({}).pipe(
  Layer.provideMerge(ControlLive.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      SqlControlRuntime.layer({ flows: [durableFlow] }).pipe(Layer.orDie),
      NotificationQueue.layer,
      Registry.layerNoop(),
      executor
    ).pipe(Layer.provideMerge(controlDatabase))
  ),
  Layer.provideMerge(engineLayer)
)

const run = <A, E, R>(body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(body, stack as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie))

const approvalOf = (card: PlanCard) => ({
  target: { _tag: "Plan" as const, planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

/** Plans, approves, and launches the flow, returning once it has parked. */
const parked = Effect.gen(function*() {
  const control = yield* Control
  const engine = yield* Engine
  const card = yield* control.plan({ flowId, input: {} })
  yield* control.approve(approvalOf(card))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
  return { runId: receipt.runId, wait: yield* engine.parkedBelow(receipt.runId) }
})

describe("a host whose control plane and engine keep separate databases", () => {
  it("lists the root run as waiting-approval with the nested question", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId, wait } = yield* parked

      const inbox = yield* control.list({ _tag: "runs", filters: { status: "waiting-approval" } })
      const all = yield* control.list({ _tag: "runs" })
      return {
        runId,
        wait,
        inbox: inbox._tag === "runs" ? inbox.items : [],
        listed: all._tag === "runs" ? all.items.find((item) => item.runId === runId) : undefined
      }
    }))

    // The wait is held by an execution the control plane's database has never
    // heard of, which is the whole difficulty.
    expect(observed.wait.runId).not.toBe(observed.runId)

    // `List {status:"waiting-approval"}` answered [] on the deployed host.
    expect(observed.inbox.map((item) => item.runId)).toContain(observed.runId)
    // `List {}` answered `parked` on an `event` with no pendingWaits.
    expect(observed.listed?.status).toBe("waiting-approval")
    const waits = observed.listed?.pendingWaits ?? []
    expect(waits.map((item) => item.runId)).toEqual([observed.wait.runId])
    expect(waits[0]).toMatchObject({
      reason: "approval",
      name: "coding-clarification",
      attempt: 1,
      token: observed.wait.token,
      request: { kind: "ask", prompt, name: "coding-clarification", maxAttempts: 3 }
    })
  })

  it("serves the nested gate through the run-scoped approvals projection", async () => {
    const rows = await run(Effect.gen(function*() {
      const projections = yield* Projections.Projections
      const { runId } = yield* parked
      const snapshot = yield* projections.snapshot({ _tag: "approvals", runId })
      return snapshot.rows as ReadonlyArray<GatewayProjection.ApprovalRow>
    }))

    // "No approvals are pending" is what the product showed for exactly this.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestId: "coding-clarification#1",
      title: prompt,
      status: "pending",
      request: { kind: "ask", maxAttempts: 3 }
    })
    expect(rows[0]?.waitRunId).not.toBe(rows[0]?.runId)
  })

  it("answers the nested wait from a signal addressed to the root run", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId } = yield* parked
      const receipt = yield* control.signal({
        runId,
        signal: { name: "coding-clarification", payload: "the scheduler owns it" },
        idempotencyKey: `signal:${runId}`
      })
      return { receipt, observation: yield* (yield* Engine).observe(runId) }
    }))

    expect(observed.receipt._tag).toBe("Accepted")
    // The wait is gone: the tree no longer owes anybody an answer.
    expect(observed.observation._tag === "Observed" ? observed.observation.pendingWaits : ["unread"]).toBeUndefined()
  })
})
