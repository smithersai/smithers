/**
 * Issue #4019: a boundary refusal settles the action with the refusal itself,
 * on the defect channel, whether the attempt failed in this process or is
 * replayed from its durable `failed` row after a crash.
 *
 * The refusal is the engine's verdict on the step, not a failure the action
 * declared. Decoded through the action's error schema (here none, so `Never`)
 * it used to become "SchemaError: Expected never" and lose the refused paths.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { FileSystem, Layer, Path } from "effect"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const RefusedFlow = Flow.make("BoundaryRefusalReplay/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "boundary-refusal-snapshot" as never, changeId: "boundary-refusal-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const refusal = new StepBoundary.UndeclaredWrite({
  code: "undeclared_write",
  paths: ["stray.txt"],
  diffIdentity: "boundary-refusal-diff"
})

/** What the run settles with: the refusal's tagged fields as its one defect. */
const refused = [{
  _tag: "Die",
  defect: {
    _tag: "@smthrs/engine-store/UndeclaredWrite",
    code: "undeclared_write",
    paths: ["stray.txt"],
    diffIdentity: "boundary-refusal-diff"
  }
}]

/** A sealed step with no error schema whose settle the boundary refuses. */
const step = (dispatches: { count: number }) =>
  Action.make({
    name: "BoundaryRefusalReplay/step",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "boundary-refusal-v1",
    fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" },
    execute: Effect.sync(() => {
      dispatches.count++
      return "wrote"
    })
  })

const makeEngine = EngineStore.make({
  owner: { hostId: "boundary-refusal-host" },
  journalSource: "boundary-refusal-test",
  isAlive: () => Effect.succeed(false)
})

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest({ failure: refusal })),
      Effect.provide(TestStores.layer()),
      Effect.provide(TestClock.layer()),
      Effect.provide(Action.layerCacheEnvironment({ layers: [], capabilities: {} }))
    ) as Effect.Effect<A, E, never>
  )

/** The settled run's recorded exit cause. */
const settledCause = (executionId: string) =>
  Effect.gen(function*() {
    const row = yield* (yield* RunStore.RunStore).get(executionId)
    return { status: row.status, cause: JSON.parse(row.stateJson).result.exit.cause as unknown }
  })

describe("a boundary refusal settles as the engine's own defect", () => {
  it.effect("fails the run with the refusal and its paths", () =>
    Effect.gen(function*() {
      const dispatches = { count: 0 }
      const settled = yield* provide(Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(RefusedFlow, () => step(dispatches))
          yield* executeUntilParked(engine, RefusedFlow, { executionId: "refused-run", payload: {}, discard: true })
        }))
        return yield* settledCause("refused-run")
      }))
      expect(dispatches.count).toBe(1)
      expect(settled).toEqual({ status: "failed", cause: refused })
    }))

  it.effect("replays a durably refused attempt after a crash as the same refusal", () =>
    Effect.gen(function*() {
      const dispatches = { count: 0 }
      const settled = yield* provide(Effect.gen(function*() {
        const journal = yield* Journal.Journal
        // First process: the refused attempt commits its `failed` row, then
        // the process dies before the refusal reaches the run.
        let terminal = false
        let parked = false
        yield* Effect.scoped(Effect.gen(function*() {
          const blocked = Notifying.wrap(journal, (op, order, args) => {
            if (
              op === "emitDurable" && order === "after" &&
              (args[0] as { readonly eventType: string }).eventType === "flows.engine.attempt-finished"
            ) {
              terminal = true
              return Effect.void
            }
            if (op !== "transact" || order !== "after" || !terminal || parked) return Effect.void
            parked = true
            return Effect.interruptible(Effect.never)
          })
          const engine = yield* Effect.provideService(makeEngine, Journal.Journal, blocked)
          yield* engine.register(RefusedFlow, () => step(dispatches))
          yield* executeUntilParked(engine, RefusedFlow, {
            executionId: "replayed-run",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          // The park fires on the first transaction after the failed
          // attempt's durable finish.
          yield* TestDatabase.until(Effect.sync(() => parked))
        }))
        const before = yield* (yield* RunStore.RunStore).get("replayed-run")
        expect(before.status).not.toBe("failed")
        // Second process: the failed row answers the dispatch.
        yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(RefusedFlow, () => step(dispatches))
          expect(Option.isNone(yield* engine.poll(RefusedFlow, "replayed-run"))).toBe(true)
          yield* executeUntilParked(engine, RefusedFlow, {
            executionId: "replayed-run",
            payload: {},
            discard: true
          }, ["failed"])
        }))
        return yield* settledCause("replayed-run")
      }))
      // The body ran once; the second process replayed the row.
      expect(dispatches.count).toBe(1)
      expect(settled).toEqual({ status: "failed", cause: refused })
    }))
})

describe("engine failures before action error decoding (#4020)", () => {
  const flow = Flow.make("EngineFailureReplay/flow", {
    payload: {},
    success: Schema.String,
    body: opaqueHandlerBody
  })
  const failures = [
    Schema.encodeSync(ActionPersistence.CacheConflictDetected)(
      new ActionPersistence.CacheConflictDetected({
        code: "cache_conflict_detected",
        keyDigest: "key",
        recordedRunId: "other"
      })
    ),
    Schema.encodeSync(ActionPersistence.CacheCorruptionDetected)(
      new ActionPersistence.CacheCorruptionDetected({
        code: "cache_corruption_detected",
        keyDigest: "key",
        path: "out",
        recordedDigest: "aa",
        measuredDigest: "bb"
      })
    ),
    Schema.encodeSync(ActionPersistence.AttemptAdmissionRejected)(
      new ActionPersistence.AttemptAdmissionRejected({
        code: "attempt_admission_rejected",
        keyDigest: "key",
        outcome: "Conflict"
      })
    ),
    Schema.encodeSync(WorkspaceSandbox.MaterializationConflict)(
      new WorkspaceSandbox.MaterializationConflict({
        paths: ["out"],
        message: "base moved"
      })
    ),
    Schema.encodeSync(WorkspaceSandbox.WorkspaceError)(
      new WorkspaceSandbox.WorkspaceError({
        code: "host_unavailable",
        message: "workspace unavailable"
      })
    )
  ]
  const jj = Jj.make({
    snapshot: () => Effect.succeed({ commitId: "snapshot" as never, changeId: "snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
  const makeEngine = (source = "seed") =>
    EngineStore.make({
      owner: { hostId: "engine-failure-replay" },
      journalSource: `engine-failure-replay-${source}`,
      isAlive: () => Effect.succeed(false)
    })

  for (const failure of failures) {
    for (const retry of [false, true]) {
      it.live(`${failure._tag}: preserves failure and retries=${retry} after restart`, () =>
        withCrypto(
          Effect.gen(function*() {
            let calls = 0
            const action = Action.make({
              name: "EngineFailureReplay/action",
              success: Schema.String,
              tier: "sealed",
              ...(retry
                ? { retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 }) }
                : {}),
              execute: Effect.sync(() => {
                calls++
                return "ok"
              })
            })
            // Admit and execute a real step to obtain the engine's own identity,
            // then model process death after a failed attempt, before run settlement.
            yield* Effect.scoped(Effect.gen(function*() {
              const engine = yield* makeEngine()
              yield* engine.register(flow, () => action as unknown as Effect.Effect<string>)
              yield* executeUntilParked(engine, flow, { executionId: "run", payload: {}, discard: true })
            }))
            const runs = yield* RunStore.RunStore
            const row = yield* runs.get("run")
            expect(row.status, row.stateJson).toBe("completed")
            const state = JSON.parse(row.stateJson)
            delete state.result
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE flows_attempts SET state = 'failed', outcome_json = NULL,
          error_json = ${JSON.stringify({ reasons: [{ _tag: "Fail", error: failure }] })}
          WHERE run_id = 'run'`
            yield* sql`UPDATE flows_runs SET status = 'suspended', state_json = ${JSON.stringify(state)}
          WHERE run_id = 'run'`
            yield* Effect.scoped(Effect.gen(function*() {
              const engine = yield* makeEngine("restarted")
              yield* engine.register(flow, () => action as unknown as Effect.Effect<string>)
              yield* executeUntilParked(engine, flow, { executionId: "run", payload: {}, discard: true }, [
                "failed",
                "completed"
              ])
            }))
            const settled = yield* runs.get("run")
            const retries = retry && failure._tag !== "@smthrs/engine-store/CacheCorruptionDetected"
            expect(calls).toBe(retries ? 2 : 1)
            expect(settled.status).toBe(retries ? "completed" : "failed")
            if (!retries) {
              expect(JSON.parse(settled.stateJson).result.exit.cause).toEqual([{ _tag: "Die", defect: failure }])
            }
          }).pipe(
            Effect.provideService(Jj.Jj, jj),
            Effect.provide(StepBoundary.layerTest()),
            Effect.provide(TestStores.layerAt(":memory:"))
          )
        ))
    }
  }

  it.effect("a real competing cache publication retains the engine conflict", () =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        let digest = ""
        const action = Action.make({
          name: "EngineFailureReplay/cache-conflict",
          success: Schema.String,
          metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
          execute: Effect.gen(function*() {
            const key = yield* Action.CurrentInvocationKey
            if (key === undefined) return yield* Effect.die("missing invocation key")
            digest = sha256(key)
            yield* cache.put({
              keyDigest: digest,
              result: "competitor",
              meta: {},
              createdAtMs: 1,
              recordedRunId: "other",
              recordedEventSeq: 0
            })
            return "own result"
          }).pipe(Effect.orDie)
        })
        const engine = yield* makeEngine()
        yield* engine.register(flow, () => action as unknown as Effect.Effect<string>)
        yield* executeUntilParked(engine, flow, { executionId: "fresh", payload: {}, discard: true }, ["failed"])
        const row = yield* (yield* RunStore.RunStore).get("fresh")
        expect(JSON.parse(row.stateJson).result.exit.cause).toEqual([{
          _tag: "Die",
          defect: {
            _tag: "@smthrs/engine-store/CacheConflictDetected",
            code: "cache_conflict_detected",
            keyDigest: digest,
            recordedRunId: "other"
          }
        }])
      }).pipe(
        Effect.scoped,
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(":memory:"))
      )
    ))

  it.effect("a SQL admission conflict preserves AttemptAdmissionRejected before action decoding", () =>
    withCrypto(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TRIGGER competing_attempt BEFORE INSERT ON flows_attempts BEGIN
      INSERT INTO flows_attempts (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
      VALUES (NEW.run_id, NEW.step_key_digest, NEW.attempt, NEW.state, NEW.started_at_ms + 1, NEW.meta_json);
      SELECT RAISE(IGNORE); END`
        let calls = 0
        const action = Action.make({
          name: "EngineFailureReplay/admission",
          success: Schema.String,
          execute: Effect.sync(() => {
            calls++
            return "unexpected"
          })
        })
        const engine = yield* makeEngine()
        yield* engine.register(flow, () => action as unknown as Effect.Effect<string>)
        yield* executeUntilParked(engine, flow, { executionId: "fresh", payload: {}, discard: true }, ["failed"])
        const row = yield* (yield* RunStore.RunStore).get("fresh")
        expect(calls).toBe(0)
        expect(JSON.parse(row.stateJson).result.exit.cause).toMatchObject([{
          _tag: "Die",
          defect: { _tag: "@smthrs/engine-store/AttemptAdmissionRejected", code: "attempt_admission_rejected" }
        }])
      }).pipe(
        Effect.scoped,
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(":memory:"))
      )
    ))

  for (const conflict of [false, true]) {
    it.effect(`real sandbox ${conflict ? "copy-back conflict" : "missing host"} keeps its engine failure`, () =>
      withCrypto(
        Effect.gen(function*() {
          const sandbox = yield* WorkspaceSandbox.makeMemory({ out: "base" })
          let calls = 0
          const descriptor = { readSet: [], writeSet: ["out"], boundaryMode: "hard" as const }
          const action = Action.make({
            name: "EngineFailureReplay/sandbox",
            success: Schema.String,
            metadata: descriptor,
            execute: Effect.gen(function*() {
              calls++
              const workspace = yield* WorkspaceSandbox.Workspace
              yield* workspace.writeFile("out", new TextEncoder().encode("own"))
              // A real second transaction changes the host after this action's base
              // snapshot, on every rebase, until the sandbox's budget is exhausted.
              const competing = yield* sandbox.service.execute({
                descriptor,
                workflow: Effect.gen(function*() {
                  const other = yield* WorkspaceSandbox.Workspace
                  yield* other.writeFile("out", new TextEncoder().encode(`competing-${calls}`))
                })
              })
              if (competing._tag !== "Accepted") return yield* Effect.die("competitor refused")
              yield* sandbox.service.materialize(competing)
              return "own result"
            }).pipe(Effect.orDie)
          })
          const service = conflict ? sandbox.service : WorkspaceSandbox.makeFileSystem(
            yield* FileSystem.FileSystem,
            yield* Path.Path,
            ArtifactStore.makeMemory(),
            "/nonexistent/smithers-4020"
          )
          const engine = yield* Effect.provideService(makeEngine(), WorkspaceSandbox.WorkspaceSandbox, service)
          yield* engine.register(flow, () => action as unknown as Effect.Effect<string>)
          yield* executeUntilParked(engine, flow, { executionId: "fresh", payload: {}, discard: true }, ["failed"])
          const row = yield* (yield* RunStore.RunStore).get("fresh")
          const defect = JSON.parse(row.stateJson).result.exit.cause[0].defect
          expect(defect).toMatchObject(
            conflict
              ? { _tag: "@smthrs/engine-store/MaterializationConflict", paths: ["out"] }
              : { _tag: "@smthrs/engine-store/WorkspaceError", code: "host_unavailable" }
          )
          expect(calls).toBe(conflict ? 4 : 1)
        }).pipe(
          Effect.scoped,
          Effect.provideService(Jj.Jj, jj),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layerAt(":memory:")),
          Effect.provide(NodeFileSystem.layer),
          Effect.provide(NodePath.layer)
        )
      ))
  }

  it.effect("a genuinely corrupted cache artifact preserves CacheCorruptionDetected on a fresh run", () =>
    withCrypto(
      Effect.gen(function*() {
        const root = mkdtempSync(join(tmpdir(), "engine-failure-corruption-"))
        const directory = join(root, ".flows/objects")
        const artifact = "original artifact".repeat(100_000)
        const digest = sha256(artifact)
        const host = KernelFileSystem.layer.pipe(
          Layer.provide(AtomicFileSystem.layer),
          Layer.provideMerge(NodePath.layer),
          Layer.provide(KernelWorkspace.layer(root)),
          Layer.provide(GrantStore.layerNoop)
        )
        const artifacts = Layer.merge(
          host,
          ArtifactStore.layerFileSystem({ directory }).pipe(
            Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
          )
        )
        const production = Layer.merge(
          StepBoundary.layer.pipe(Layer.provide(artifacts)),
          WorkspaceSandbox.layerFileSystem().pipe(Layer.provide(artifacts), Layer.provide(KernelWorkspace.layer(root)))
        )
        let calls = 0
        const action = Action.make({
          name: "EngineFailureReplay/corruption",
          success: Schema.String,
          idempotencyKey: "artifact-v1",
          metadata: { readSet: [], writeSet: ["out"], boundaryMode: "hard" },
          execute: Effect.gen(function*() {
            calls++
            yield* (yield* WorkspaceSandbox.Workspace).writeFile("out", new TextEncoder().encode(artifact))
            return "result"
          }).pipe(Effect.orDie)
        })
        try {
          yield* Effect.gen(function*() {
            yield* Effect.scoped(Effect.gen(function*() {
              const engine = yield* makeEngine("first")
              yield* engine.register(flow, () => action as unknown as Effect.Effect<string>)
              yield* executeUntilParked(engine, flow, { executionId: "original", payload: {}, discard: true }, [
                "completed",
                "failed"
              ])
              const row = yield* (yield* RunStore.RunStore).get("original")
              expect(row.status, row.stateJson).toBe("completed")
            }))
            const sql = yield* SqlClient.SqlClient
            const cached = yield* sql`SELECT key_digest, meta_json FROM flows_step_cache`
            expect(cached.length).toBe(1)
            // Damage actual recorded bytes, rather than substituting a refusing service.
            writeFileSync(join(directory, digest.slice(0, 2), digest), "damaged")
            rmSync(join(root, "out"))
            yield* Effect.scoped(Effect.gen(function*() {
              const engine = yield* makeEngine("second")
              yield* engine.register(flow, () => action as unknown as Effect.Effect<string>)
              yield* executeUntilParked(engine, flow, { executionId: "corrupted", payload: {}, discard: true }, [
                "failed",
                "completed"
              ])
              const row = yield* (yield* RunStore.RunStore).get("corrupted")
              expect(row.status).toBe("failed")
              expect(JSON.parse(row.stateJson).result.exit.cause).toMatchObject([{
                _tag: "Die",
                defect: {
                  _tag: "@smthrs/engine-store/CacheCorruptionDetected",
                  code: "cache_corruption_detected",
                  path: "out",
                  recordedDigest: digest,
                  measuredDigest: sha256("damaged")
                }
              }])
              expect(calls).toBe(1)
            }))
          }).pipe(
            Effect.provide(production),
            Effect.provideService(Jj.Jj, jj),
            Effect.provide(TestStores.layerAt(":memory:")),
            Effect.provide(Action.layerCacheEnvironment({ layers: [], capabilities: {} }))
          )
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    ))
})
