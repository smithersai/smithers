import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control } from "@smthrs/control/Control"
import { PersistenceError } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { RunStore } from "@smthrs/run-store"
import { Cause, Clock, Context, Effect, Exit, Layer } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { durable, type DurableStack, fileBundle } from "../../control/test/DurableStack.ts"
import * as AgentSession from "../src/AgentSession.ts"

type EngineContext = Context.Context<RunStore.RunStore | DurableEngineState.DurableEngineState | SqlClient>

const databases = async (
  body: (
    engine: EngineContext,
    control: Context.Context<DurableStack>,
    engineFile: string
  ) => Effect.Effect<void, unknown>
) => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-execution-observation-"))
  const engineFile = join(directory, "engine.db")
  try {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* Layer.build(TestStores.layerAt(engineFile))
        const control = yield* Layer.build(durable({
          database: fileBundle(join(directory, "control.db")),
          executor: ControlExecutor.makeNoop({
            readExecution: (runId) => AgentSession.readExecution(runId).pipe(Effect.provide(engine))
          })
        }))
        yield* body(engine, control, engineFile)
      })).pipe(Effect.provide(NodeCrypto.layer))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const launch = (context: Context.Context<DurableStack>) =>
  Effect.gen(function*() {
    const runtime = Context.get(context, ControlRuntime)
    const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
    const token = yield* runtime.lookupApproval(card.approval.target)
    yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
    const started = yield* runtime.launch(card.planId, card.digest, card.envelope)
    if (started._tag !== "Started") return yield* Effect.die("expected started run")
    return started.run.runId
  })

const create = (engine: EngineContext, runId: string, options?: RunStore.CreateOptions) =>
  Context.get(engine, RunStore.RunStore).create(
    runId,
    JSON.stringify({ version: 1, flowName: "system/test", payload: {} }),
    options
  )

const parked = (engine: EngineContext, runId: string, options?: RunStore.CreateOptions, reason = "timer") =>
  Effect.gen(function*() {
    const runs = Context.get(engine, RunStore.RunStore)
    const state = Context.get(engine, DurableEngineState.DurableEngineState)
    yield* create(engine, runId, options)
    const row = yield* runs.get(runId)
    const owner = { hostId: "observation", pid: process.pid, nonce: runId }
    expect(
      yield* runs.claimAndOwn(
        runId,
        {
          status: row.status,
          owner: row.owner,
          heartbeatAtMs: row.heartbeatAtMs
        },
        owner,
        yield* Clock.currentTimeMillis
      )
    ).toEqual({ _tag: "Activated" })
    yield* state.park(runId, { reason, wakeAt: Date.now() + 60_000 }, owner)
    expect(yield* runs.transitionOwned(runId, owner, "suspended")).toEqual({ _tag: "Transitioned" })
  })

describe("engine execution observations across separate control and engine databases", () => {
  it("keeps lifecycle and wait facts from one engine snapshot during a concurrent completion", () =>
    databases(
      (engine, control, engineFile) =>
        Effect.gen(function*() {
          const runId = yield* launch(control)
          yield* parked(engine, runId)
          expect((yield* Context.get(control, ControlRuntime).getRun(runId)).status).toBe("accepted")
          const runs = Context.get(engine, RunStore.RunStore)
          const peer = new DatabaseSync(engineFile)
          let committed = false
          let observations = 0
          const finish = () => {
            peer.prepare(`UPDATE flows_runs SET status = 'completed', finished_at_ms = ?,
          waiting_reason = NULL, waiting_wake_at_ms = NULL, waiting_token = NULL WHERE run_id = ?`)
              .run(Date.now(), runId)
            committed = true
          }
          try {
            // Read the real current round, then let an independent SQLite connection finish
            // the run before the next store read. No row or waiting value is faked.
            const interleaved = RunStore.RunStore.of({
              ...runs,
              latestRound: (id) =>
                runs.latestRound(id).pipe(Effect.tap(() =>
                  Effect.sync(() => {
                    observations++
                    try {
                      finish()
                    } catch (error) {
                      // A transaction implementation taking a write lock may serialize
                      // the peer until the reader finishes instead of using a WAL snapshot.
                      if (!(error instanceof Error) || !error.message.includes("locked")) throw error
                    }
                  })
                ))
            })
            const observed = yield* AgentSession.readExecution(runId).pipe(
              Effect.provideService(RunStore.RunStore, interleaved),
              Effect.provide(engine)
            )
            expect(observations).toBe(1)
            expect(observed).toMatchObject({ _tag: "Observed", status: "parked", waitingReason: "timer" })
            if (!committed) finish()
            expect(yield* AgentSession.readExecution(runId).pipe(Effect.provide(engine)))
              .toMatchObject({ _tag: "Observed", status: "completed", waitingReason: undefined })
          } finally {
            peer.close()
          }
        })
    ))

  it("preserves the earliest engine spawn parent in public run and lineage filters", () =>
    databases(
      (engine, context) =>
        Effect.gen(function*() {
          const runId = yield* launch(context)
          const state = Context.get(engine, DurableEngineState.DurableEngineState)
          const control = Context.get(context, Control)
          yield* create(engine, "creating-parent")
          yield* create(engine, "later-parent")
          yield* create(engine, runId)
          yield* state.recordRunParent(runId, "creating-parent")
          yield* state.recordRunParent(runId, "later-parent")
          const observed = yield* AgentSession.readExecution(runId).pipe(Effect.provide(engine))
          expect(observed).toMatchObject({ _tag: "Observed", status: "accepted", parentRunId: "creating-parent" })
          const result = yield* control.list({ _tag: "runs", filters: { runId, parentRunId: "creating-parent" } })
          expect(result).toMatchObject({
            _tag: "runs",
            items: [{ runId, parentRunId: "creating-parent", executionObservation: "observed" }]
          })
          expect(yield* control.list({ _tag: "runs", filters: { runId, parentRunId: "later-parent" } }))
            .toEqual({ _tag: "runs", items: [] })
        })
    ))

  it("keeps row-parent precedence and trampoline lineage above a separate spawn parent", () =>
    databases(
      (engine, context) =>
        Effect.gen(function*() {
          const runId = yield* launch(context)
          const state = Context.get(engine, DurableEngineState.DurableEngineState)
          yield* create(engine, "spawning-parent")
          yield* create(engine, "previous-round")
          yield* create(engine, runId, { parentRunId: "previous-round", lineageId: "lineage", roundOrdinal: 2 })
          yield* state.recordRunParent(runId, "spawning-parent")
          expect(yield* AgentSession.readExecution(runId).pipe(Effect.provide(engine))).toMatchObject({
            _tag: "Observed",
            parentRunId: "previous-round",
            lineageId: "lineage",
            roundOrdinal: 2
          })
          expect(yield* Context.get(context, Control).list({ _tag: "runs", filters: { runId, lineageId: "lineage" } }))
            .toMatchObject({
              _tag: "runs",
              items: [{ runId, parentRunId: "previous-round", lineageId: "lineage", roundOrdinal: 2 }]
            })
        })
    ))

  it("projects latest-round lifecycle without making the advertised original run its own parent", () =>
    databases(
      (engine, context) =>
        Effect.gen(function*() {
          const rootId = yield* launch(context)
          const childId = yield* launch(context)
          const state = Context.get(engine, DurableEngineState.DurableEngineState)
          const runs = Context.get(engine, RunStore.RunStore)
          const control = Context.get(context, Control)
          yield* create(engine, "root-spawner")
          yield* create(engine, rootId)
          yield* state.recordRunParent(rootId, "root-spawner")
          const original = yield* runs.get(rootId)
          const owner = { hostId: "observation", pid: process.pid, nonce: "original" }
          yield* runs.claimAndOwn(
            rootId,
            {
              status: original.status,
              owner: original.owner,
              heartbeatAtMs: original.heartbeatAtMs
            },
            owner,
            yield* Clock.currentTimeMillis
          )
          yield* runs.transitionOwned(rootId, owner, "completed")
          yield* parked(engine, "next-round", { parentRunId: rootId, lineageId: rootId, roundOrdinal: 1 })
          yield* create(engine, childId)
          yield* state.recordRunParent(childId, "next-round")
          const root = yield* control.list({ _tag: "runs", filters: { runId: rootId, lineageId: rootId } })
          expect(root).toMatchObject({
            _tag: "runs",
            items: [{
              runId: rootId,
              status: "parked",
              waitingReason: "timer",
              parentRunId: "root-spawner",
              lineageId: rootId,
              roundOrdinal: 0
            }]
          })
          expect(yield* AgentSession.readExecution("next-round").pipe(Effect.provide(engine))).toMatchObject({
            _tag: "Observed",
            status: "parked",
            waitingReason: "timer",
            parentRunId: rootId,
            lineageId: rootId,
            roundOrdinal: 1
          })
          expect(yield* control.list({ _tag: "runs", filters: { runId: childId, parentRunId: "next-round" } }))
            .toMatchObject({ _tag: "runs", items: [{ runId: childId, parentRunId: "next-round" }] })
        })
    ))

  it.each(["approval", "quota", "plugin-condition"])("preserves the engine's %s wait vocabulary", (reason) =>
    databases(
      (engine, context) =>
        Effect.gen(function*() {
          const runId = yield* launch(context)
          yield* parked(engine, runId, undefined, reason)
          const status = reason === "approval" ? "waiting-approval" : "parked"
          expect(yield* Context.get(context, Control).list({ _tag: "runs", filters: { runId, status } }))
            .toMatchObject({ _tag: "runs", items: [{ runId, status, waitingReason: reason }] })
        })
    ))

  it("keeps an absent engine execution distinct from the coordination admission", () =>
    databases(
      (engine, context) =>
        Effect.gen(function*() {
          const runId = yield* launch(context)
          const runtime = Context.get(context, ControlRuntime)
          const before = yield* runtime.getRun(runId)
          expect(yield* AgentSession.readExecution(runId).pipe(Effect.provide(engine))).toEqual({ _tag: "Missing" })
          expect(yield* Context.get(context, Control).list({ _tag: "runs", filters: { runId } }))
            .toMatchObject({ _tag: "runs", items: [{ runId, status: "accepted", executionObservation: "missing" }] })
          expect(yield* runtime.getRun(runId)).toEqual(before)
        })
    ))

  it.each(["row", "waiting", "parents", "identity"])(
    "reports a corrupt %s read as typed persistence failure without changing control",
    (failurePoint) =>
      databases(
        (engine, context, engineFile) =>
          Effect.gen(function*() {
            const runId = yield* launch(context)
            const runtime = Context.get(context, ControlRuntime)
            const before = yield* runtime.getRun(runId)
            yield* parked(engine, runId)
            if (failurePoint === "identity") {
              yield* create(engine, "latest-round", { parentRunId: runId, lineageId: runId, roundOrdinal: 1 })
            }
            const peer = new DatabaseSync(engineFile)
            try {
              peer.exec("PRAGMA ignore_check_constraints = ON")
              if (failurePoint === "parents") peer.exec("DROP TABLE flows_run_parents")
              else if (failurePoint === "waiting") {
                peer.prepare("UPDATE flows_runs SET waiting_wake_at_ms = -1 WHERE run_id = ?").run(runId)
              } else peer.prepare("UPDATE flows_runs SET status = 'invalid' WHERE run_id = ?").run(runId)
            } finally {
              peer.close()
            }
            const result = yield* Effect.exit(AgentSession.readExecution(runId).pipe(Effect.provide(engine)))
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result)) {
              expect(Cause.hasFails(result.cause)).toBe(true)
              expect(Cause.hasDies(result.cause)).toBe(false)
              const failure = Cause.squash(result.cause)
              expect(failure).toBeInstanceOf(PersistenceError)
              expect((failure as PersistenceError).cause).toBeInstanceOf(Error)
            }
            const listed = yield* Effect.result(
              Context.get(context, Control).list({ _tag: "runs", filters: { runId } })
            )
            expect(listed).toMatchObject({ _tag: "Failure", failure: { _tag: "/control/PersistenceError" } })
            expect(yield* runtime.getRun(runId)).toEqual(before)
          })
      )
  )

  it("preserves interruption and releases the observation transaction", () =>
    databases(
      (engine, context) =>
        Effect.gen(function*() {
          const runId = yield* launch(context)
          yield* parked(engine, runId)
          const state = Context.get(engine, DurableEngineState.DurableEngineState)
          const interrupted = yield* Effect.exit(
            AgentSession.readExecution(runId).pipe(
              Effect.provideService(DurableEngineState.DurableEngineState, {
                ...state,
                waiting: () => Effect.interrupt
              }),
              Effect.provide(engine)
            )
          )
          expect(Exit.isFailure(interrupted)).toBe(true)
          if (Exit.isFailure(interrupted)) expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
          expect(yield* AgentSession.readExecution(runId).pipe(Effect.provide(engine)))
            .toMatchObject({ _tag: "Observed", status: "parked", waitingReason: "timer" })
        })
    ))
})
