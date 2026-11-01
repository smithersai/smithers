import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node"
import { ScriptedJudge } from "@smthrs/agent"
import { ArtifactStore } from "@smthrs/artifacts"
import { Control, ControlExecutor, ControlLive, ControlRuntime, Health, SqlControlRuntime } from "@smthrs/control"
import type { RunSummary } from "@smthrs/control/ControlSchema"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Crypto } from "@smthrs/crypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Journal, JournalEvent } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Registry } from "@smthrs/registry"
import { RunStore } from "@smthrs/run-store"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Schema, Scope, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as HealthHost from "../src/internal/HealthHost.ts"

const testLayer = Layer.mergeAll(
  TestControl.layer(),
  FlowEngine.layerMemory,
  Crypto.layerFromDigest(NodeCrypto.layerDigest)
)

const summaries: ReadonlyArray<RunSummary> = Array.from({ length: 4 }, (_, index) => ({
  runId: `health-${index}`,
  flowId: "checked",
  status: "accepted",
  createdAt: 0,
  updatedAt: 0
}))
const source = (control: Control.Service): Control.Service => ({
  ...control,
  list: (request) =>
    request._tag !== "runs" ? control.list(request) : Effect.succeed({
      _tag: "runs",
      items: summaries.filter((run) =>
        (request.filters?.runId === undefined || request.filters.runId === run.runId) &&
        (request.filters?.status === undefined || request.filters.status === run.status)
      )
    }),
  watch: () => Stream.empty
})

describe("native health producer lifetime", () => {
  it("keeps discovery registered while slow probes close", async () => {
    const warnings: unknown[] = []
    const logger = Logger.make((record) => {
      if (record.logLevel === "Warn") warnings.push(record.message)
    })
    const engine = EngineStore.layer({
      owner: { hostId: "health-shutdown" },
      journalSource: "health-shutdown"
    }).pipe(
      Layer.provideMerge(TestStores.layerAt(":memory:")),
      Layer.provide(StepBoundary.layerUnsupported),
      Layer.provideMerge(Crypto.layerFromDigest(NodeCrypto.layerDigest)),
      Layer.provide(NodeJj.layerAt(process.cwd()))
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const services = yield* Layer.build(engine)
        const runtime = Context.get(services, FlowRuntime.FlowRuntime)
        const runs = Context.get(services, RunStore.RunStore)
        const controlRuntime = yield* ControlRuntime.ControlRuntime
        const { card } = yield* controlRuntime.plan({ flowId: "system/test", input: {} })
        const approval = yield* controlRuntime.lookupApproval(card.approval.target)
        yield* controlRuntime.resolveApproval(approval, "approved", yield* controlRuntime.stampPrincipal())
        const launched = yield* controlRuntime.launch(card.planId, card.digest, card.envelope)
        expect(launched._tag).toBe("Started")
        const began = yield* Deferred.make<void>()
        const closing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const healthScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit))
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        yield* HealthHost.start({
          limits: { maxSubjects: 1 },
          checkers: [{
            id: "closing",
            probe: () =>
              Deferred.succeed(began, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(release))))
              )
          }],
          bindings: { "system/test": { checkerId: "closing" } }
        }).pipe(
          Effect.provideService(FlowRuntime.FlowRuntime, runtime),
          Effect.provide(ScriptedJudge.layer),
          Scope.provide(healthScope)
        )
        yield* TestDatabase.until(
          Deferred.isDone(began).pipe(
            Effect.tap((done) => done ? Effect.void : TestClock.adjust(100))
          )
        )
        yield* TestDatabase.until(
          runs.lineage("smithers-health-discovery").pipe(
            Effect.map((lineage) => lineage.some((run) => run.status === "suspended"))
          )
        )
        const close = yield* Scope.close(healthScope, Exit.void).pipe(Effect.forkChild)
        yield* Deferred.await(closing)
        // A real durable timer becomes due while a probe finalizer is held open.
        yield* TestClock.adjust(5_000)
        const discovery = Flow.make("smithers/health/Discovery", {
          payload: {},
          success: Schema.Number,
          body: Node.capture({}, () => Node.succeed(0))
        })
        try {
          yield* Context.get(services, EngineStore.Driver).drive(discovery, {
            executionId: "smithers-health-discovery",
            payload: {},
            holdMs: 0
          })
          expect(warnings).toEqual([])
        } finally {
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(close)
        }
      }).pipe(
        Effect.provide(testLayer),
        Effect.provide(Logger.layer([logger])),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    )
  })

  it("retries discovery after a failed scan and observes newly discovered runs", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const control = source(yield* Control.Control)
        const failed = yield* Deferred.make<void>()
        const recorded = yield* Deferred.make<void>()
        let attempts = 0
        let discoveryFlow: string | undefined
        const flaky: Control.Service = {
          ...control,
          list: (request) =>
            Effect.gen(function*() {
              attempts += 1
              const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
              discoveryFlow = Option.isSome(instance) ? instance.value.flow._tag : undefined
              if (attempts === 1) {
                yield* Deferred.succeed(failed, undefined)
                return yield* Effect.die("temporary discovery failure")
              }
              return yield* control.list(request)
            })
        }
        const observedJournal = {
          ...journal,
          emitDurableUnfenced: (input: JournalEvent.Input) =>
            journal.emitDurableUnfenced(input).pipe(
              Effect.tap(() =>
                input.eventType === Health.statusObservedEventType
                  ? Deferred.succeed(recorded, undefined)
                  : Effect.void
              )
            )
        }
        const fiber = yield* Effect.scoped(
          HealthHost.watch(Health.makeRegistry({ limits: { maxSubjects: 1 } })).pipe(
            Effect.provideService(Control.Control, flaky),
            Effect.provideService(Journal.Journal, observedJournal)
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(failed)
        yield* TestClock.adjust(5_000)
        yield* Deferred.await(recorded)
        expect(attempts).toBeGreaterThan(1)
        expect(discoveryFlow).toBe("smithers/health/Discovery")
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("health-0"), limit: 10 })
        expect(page.entries.some((entry) => entry.eventType === Health.statusObservedEventType)).toBe(true)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })

  it("releases a failed observation so the next scan can retry the same subject", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const original = source(yield* Control.Control)
        const control: Control.Service = {
          ...original,
          list: (request) =>
            original.list(request).pipe(Effect.map((result) =>
              result._tag === "runs"
                ? { ...result, items: result.items.filter((run) => run.runId === "health-0") }
                : result
            ))
        }
        const failed = yield* Deferred.make<void>()
        const recorded = yield* Deferred.make<void>()
        let observations = 0
        const flakyJournal = {
          ...journal,
          emitDurableUnfenced: (input: JournalEvent.Input) =>
            Effect.gen(function*() {
              if (input.eventType === Health.statusObservedEventType) {
                observations += 1
                if (observations === 1) {
                  yield* Deferred.succeed(failed, undefined)
                  return yield* Effect.die("temporary journal failure")
                }
              }
              const result = yield* journal.emitDurableUnfenced(input)
              if (input.eventType === Health.statusObservedEventType) yield* Deferred.succeed(recorded, undefined)
              return result
            })
        }
        const fiber = yield* Effect.scoped(
          HealthHost.watch(Health.makeRegistry({ limits: { maxSubjects: 1 } })).pipe(
            Effect.provideService(Control.Control, control),
            Effect.provideService(Journal.Journal, flakyJournal)
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(failed)
        yield* TestClock.adjust(5_000)
        yield* Deferred.await(recorded)
        expect(observations).toBeGreaterThan(1)
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("health-0"), limit: 10 })
        expect(page.entries.some((entry) => entry.eventType === Health.statusObservedEventType)).toBe(true)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })

  it("does not alarm on an ordinary minute of silent work under production defaults", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const control = source(yield* Control.Control)
        const registry = Health.makeRegistry({ limits: { maxSubjects: 1 } })
        expect(registry.resolve("checked").policy.stallAfterMs).toBe(120_000)
        const fiber = yield* Effect.scoped(
          HealthHost.watch(registry).pipe(Effect.provideService(Control.Control, control))
        )
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(60_000)
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("health-0"), limit: 100 })
        const statuses = page.entries.filter((entry) => entry.eventType === Health.statusObservedEventType)
        expect(statuses.length).toBeGreaterThan(1)
        expect(statuses.every((entry) => (entry.payload as { health: string }).health === "healthy")).toBe(true)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })
  it("enforces shared subject and probe admission and interrupts checks on host teardown", async () => {
    let inFlight = 0
    let finalized = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const began = yield* Deferred.make<void>()
        const registry = Health.makeRegistry({
          limits: { maxSubjects: 3, maxConcurrentProbes: 2 },
          checkers: [{
            id: "bounded",
            probe: () =>
              Effect.gen(function*() {
                inFlight += 1
                if (inFlight === 2) yield* Deferred.succeed(began, undefined)
                return yield* Effect.never
              }).pipe(Effect.ensuring(Effect.sync(() => {
                finalized += 1
                inFlight -= 1
              })))
          }],
          bindings: { checked: { checkerId: "bounded" } }
        })
        const control = source(yield* Control.Control)
        const fiber = yield* HealthHost.watch(registry).pipe(
          Effect.provideService(Control.Control, control),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(began)
        expect(inFlight).toBe(2)
        yield* Fiber.interrupt(fiber)
        expect(inFlight).toBe(0)
        expect(finalized).toBe(2)
      }).pipe(Effect.provide(testLayer), Effect.scoped)
    )
  })
  it("executes trusted configured callbacks and persists status in the host journal", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const control = source(yield* Control.Control)
        const recorded = yield* Deferred.make<void>()
        const observedJournal = {
          ...journal,
          emitDurableUnfenced: (input: JournalEvent.Input) =>
            journal.emitDurableUnfenced(input).pipe(
              Effect.tap(() =>
                input.eventType === Health.statusObservedEventType ? Deferred.succeed(recorded, undefined) : Effect.void
              )
            )
        }
        const registry = Health.makeRegistry({
          limits: { maxSubjects: 1 },
          checkers: [{
            id: "semantic",
            probe: () => Effect.succeed({ activity: "needs-input", reason: "prompt-detected" })
          }],
          bindings: { checked: { checkerId: "semantic" } }
        })
        const fiber = yield* Effect.scoped(
          HealthHost.watch(registry).pipe(
            Effect.provideService(Control.Control, control),
            Effect.provideService(Journal.Journal, observedJournal)
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(recorded)
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("health-0"), limit: 10 })
        expect(
          page.entries.find((entry) => entry.eventType === Health.statusObservedEventType)?.payload
        ).toMatchObject({
          subjectId: "run:health-0",
          checkerId: "semantic",
          activity: "needs-input",
          attention: "needs-input"
        })
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(testLayer), Effect.scoped)
    )
  })
})

it("walks every status page beyond the first 500 real runs", () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime.ControlRuntime
      const control = yield* Control.Control
      const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
      const token = yield* runtime.lookupApproval(card.approval.target)
      yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
      for (let index = 0; index < 501; index++) {
        yield* runtime.launch(card.planId, card.digest, card.envelope)
      }
      const discoveryDone = yield* Deferred.make<void>()
      const discovered = new Set<string>()
      const observed: Control.Service = {
        ...control,
        list: (request) =>
          control.list(request).pipe(Effect.tap((page) => {
            if (page._tag !== "runs" || request._tag !== "runs") return Effect.void
            for (const run of page.items) discovered.add(run.runId)
            return request.filters?.status === "parked" ? Deferred.succeed(discoveryDone, undefined) : Effect.void
          }))
      }
      const fiber = yield* Effect.scoped(
        HealthHost.watch(Health.makeRegistry({ limits: { maxSubjects: 1 } })).pipe(
          Effect.provideService(Control.Control, observed)
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(discoveryDone)
      yield* Fiber.interrupt(fiber)
      expect(discovered.size).toBe(501)
    }).pipe(Effect.provide(testLayer), Effect.scoped)
  ))

it("discovers runs committed through an independent SQLite journal instance", () =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "health-peer-"))),
      (directory) =>
        Effect.scoped(Effect.gen(function*() {
          const stack = () =>
            ControlLive.layer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  SqlControlRuntime.layer().pipe(Layer.orDie),
                  NotificationQueue.layer,
                  ControlExecutor.layer(ControlExecutor.makeNoop()),
                  Registry.layerNoop()
                ).pipe(Layer.provideMerge(TestStores.layerAt(join(directory, "control.db"))))
              ),
              Layer.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest))
            )
          const reader = yield* Layer.build(Layer.fresh(stack()))
          const writer = yield* Layer.build(Layer.fresh(stack()))
          const control = Context.get(reader, Control.Control)
          const peer = Context.get(writer, Control.Control)
          const scanned = yield* Deferred.make<void>()
          const recorded = yield* Deferred.make<string>()
          const observed: Control.Service = {
            ...control,
            list: (request) =>
              control.list(request).pipe(Effect.tap(() =>
                request._tag === "runs" && request.filters?.status === "parked"
                  ? Deferred.succeed(scanned, undefined)
                  : Effect.void
              ))
          }
          const registry = Health.makeRegistry({
            checkers: [{
              id: "peer",
              probe: (context) =>
                Deferred.succeed(recorded, context.summary!.runId).pipe(
                  Effect.as({ activity: "working" as const })
                )
            }],
            bindings: { "system/test": { checkerId: "peer" } }
          })
          const fiber = yield* Effect.scoped(
            HealthHost.watch(registry).pipe(
              Effect.provideService(Control.Control, observed),
              Effect.provideService(Journal.Journal, Context.get(reader, Journal.Journal))
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(scanned)
          const card = yield* peer.plan({ flowId: "system/test", input: {} })
          yield* peer.approve(card.approval)
          const receipt = yield* peer.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "health-peer"
          })
          expect(receipt._tag).toBe("Accepted")
          if (receipt._tag !== "Accepted") return yield* Effect.die("Expected accepted peer run")
          yield* TestClock.adjust(5_000)
          expect(yield* Deferred.await(recorded)).toBe(receipt.runId)
          yield* Fiber.interrupt(fiber)
        })).pipe(
          Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, Crypto.layerFromDigest(NodeCrypto.layerDigest)))
        ),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    ).pipe(Effect.provide(TestClock.layer()))
  ))

it("resumes one discovery lineage after reopening its persisted timer", () =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "health-restart-"))),
      (directory) =>
        Effect.gen(function*() {
          const filename = join(directory, "engine.db")
          const engine = () =>
            EngineStore.layer({
              owner: { hostId: "health-test" },
              journalSource: JournalEvent.SourceId.make("health-host")
            }).pipe(
              Layer.provideMerge(TestStores.layerAt(filename)),
              Layer.provide(StepBoundary.layer.pipe(Layer.provide(Layer.mergeAll(
                ArtifactStore.layerMemory,
                NodeFileSystem.layer,
                NodePath.layer
              )))),
              Layer.provideMerge(Crypto.layerFromDigest(NodeCrypto.layerDigest)),
              Layer.provide(NodeJj.layerAt(process.cwd()))
            )
          const host = (resuming: boolean) =>
            Effect.scoped(Effect.gen(function*() {
              const services = yield* Layer.build(Layer.fresh(engine()))
              const control = yield* Control.Control
              const scanned = yield* Deferred.make<void>()
              const observed: Control.Service = {
                ...control,
                list: (request) =>
                  control.list(request).pipe(Effect.tap(() =>
                    request._tag === "runs" && request.filters?.status === "parked"
                      ? Deferred.succeed(scanned, undefined) :
                      Effect.void
                  ))
              }
              yield* Effect.forkScoped(
                HealthHost.watch(Health.makeRegistry()).pipe(
                  Effect.provideService(Control.Control, observed),
                  Effect.provideService(FlowRuntime.FlowRuntime, Context.get(services, FlowRuntime.FlowRuntime))
                )
              )
              if (resuming) yield* TestClock.adjust(5_000)
              yield* Deferred.await(scanned)
              const runs = Context.get(services, RunStore.RunStore)
              // Close the host only once its durable timer and waiting row exist.
              for (;;) {
                const lineage = yield* runs.lineage("smithers-health-discovery")
                if (lineage.some((run) => run.status === "suspended")) break
                yield* Effect.yieldNow
              }
              const sql = Context.get(services, SqlClient)
              const roots = yield* sql<{ readonly runId: string }>`SELECT run_id AS "runId" FROM flows_runs
          WHERE json_extract(state_json, '$.flowName') = 'smithers/health/Discovery' AND round_ordinal = 0`
              expect(roots.map((row) => row.runId)).toEqual(["smithers-health-discovery"])
            }))
          yield* host(false)
          yield* host(true)
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    ).pipe(Effect.provide(TestClock.layer()))
  ))
