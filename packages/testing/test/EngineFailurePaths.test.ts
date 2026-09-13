/**
 * Typed engine failures and lifecycle edges shared by the two reference
 * subjects.
 *
 * These are the black-box paths conformance consumers depend on when an id was
 * never claimed, a step fails, a race is malformed, or a live execution is
 * joined through resume. Each assertion names the stable error code or the
 * durable result and journal fields the caller observes.
 */
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Ref from "effect/Ref"
import * as Scheduler from "effect/Scheduler"
import * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import type { EngineSubject as Subject, FlowSpec, StepSpec } from "../src/EngineSubject.ts"
import * as EngineSubject from "../src/EngineSubject.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as MemoryEngine from "../src/MemoryEngine.ts"
import { type EngineSubjectError, EngineUnavailableError } from "../src/TestingError.ts"
import { describe, expect, it } from "../src/Vitest.ts"

const flowLayer = FlowEngineLike.layerOver(FlowEngine.layerMemory)

const onEachSubject = (
  name: string,
  body: (engine: Subject) => Effect.Effect<void, unknown>
): void => {
  it.scoped(`MemoryEngine ${name}`, () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      yield* body(yield* MemoryEngine.make(store))
    }))
  it.scoped(`FlowEngineLike ${name}`, () =>
    Effect.flatMap(EngineSubject.EngineSubject, body).pipe(Effect.provide(flowLayer)))
}

describe("execution lifecycle parity", () => {
  it.scoped("MemoryEngine skips sparse positions when replaying and locating the interrupted frontier", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      let calls = 0
      const winner: StepSpec = {
        kind: "step",
        key: "sparse-winner",
        sealed: true,
        run: () =>
          Effect.sync(() => {
            calls++
            return "winner"
          })
      }
      const branches = new Array<StepSpec>(2)
      branches[1] = winner
      const steps = new Array<StepSpec>(4)
      steps[1] = winner
      steps[2] = { kind: "race", key: "sparse-race", sealed: false, branches }
      steps[3] = { kind: "step", key: "frontier", sealed: false, run: () => Effect.interrupt }
      const executionId = "testing/sparse-replay"
      expect((yield* engine.run({ flow: { name: executionId, steps }, executionId, payload: null })).status)
        .toBe("suspended")
      yield* engine.interrupt(executionId)
      expect((yield* engine.result(executionId)).status).toBe("aborted")
      expect(calls).toBe(1)
      expect(yield* engine.journal(executionId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ stepKey: "frontier", outcome: "aborted" })
      ]))
    }))

  for (const operation of ["result", "resume", "run"] as const) {
    onEachSubject(
      `reports aborted through ${operation} after interrupting a suspended execution`,
      (engine) =>
        Effect.gen(function*() {
          const executionId = `testing/suspended-interrupt/${operation}`
          const flow: FlowSpec = {
            name: executionId,
            steps: [{ key: "park", sealed: false, kind: "step", run: () => Effect.interrupt }]
          }
          const options = { flow, payload: undefined, executionId }
          expect(yield* engine.run(options)).toEqual({ executionId, status: "suspended" })

          yield* engine.interrupt(executionId)
          const observed = operation === "run" ? engine.run(options) : engine[operation](executionId)
          expect(yield* TestClock.withLive(observed.pipe(Effect.timeout("3 seconds")))).toEqual({
            executionId,
            status: "aborted"
          })
        })
    )
  }

  onEachSubject("preserves a completed result when interrupted again", (engine) =>
    Effect.gen(function*() {
      const executionId = "testing/completed-interrupt"
      const options = {
        flow: { name: executionId, steps: [] },
        payload: "done",
        executionId
      }
      const completed = yield* engine.run(options)
      for (let attempt = 0; attempt < 2; attempt++) {
        yield* engine.interrupt(executionId)
        expect(yield* engine.result(executionId)).toEqual(completed)
        expect(yield* engine.resume(executionId)).toEqual(completed)
        expect(yield* engine.run(options)).toEqual(completed)
      }
    }))

  for (const field of ["flow", "payload"] as const) {
    onEachSubject(`does not reserve a key refused by a ${field} conflict`, (engine) =>
      Effect.gen(function*() {
        const executionId = `testing/refused-key/${field}`
        const idempotencyKey = `${executionId}/key`
        const flow: FlowSpec = {
          name: executionId,
          steps: [{ key: "echo", sealed: false, kind: "step", run: (input) => Effect.succeed(input) }]
        }
        yield* engine.run({ flow, payload: "original", executionId })
        const retry = {
          flow: field === "flow" ? { ...flow, name: `${flow.name}/different` } : flow,
          payload: field === "payload" ? "different" : "original",
          idempotencyKey
        }
        const error = yield* engine.run({ ...retry, executionId }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "ExecutionConflictError", field })

        const accepted = yield* engine.run(retry)
        expect(accepted.executionId).not.toBe(executionId)
        expect(accepted).toMatchObject({ status: "completed", value: retry.payload })
        expect(yield* engine.run(retry)).toEqual(accepted)
      }))
  }
})

describe("unknown execution ids", () => {
  onEachSubject("fails reads and resume with engine_unavailable", (engine) =>
    Effect.gen(function*() {
      const executionId = "testing/unknown/execution"
      const operations: ReadonlyArray<readonly [string, Effect.Effect<unknown, EngineSubjectError>]> = [
        ["result", engine.result(executionId)],
        ["resume", engine.resume(executionId)],
        ["journal", engine.journal(executionId)]
      ] as const

      for (const [operation, effect] of operations) {
        const error = yield* Effect.flip(effect)
        expect(error._tag, operation).toBe("EngineUnavailableError")
        expect(error.code, operation).toBe("engine_unavailable")
        expect((error as EngineUnavailableError).message, operation).toContain(executionId)
      }

      const interrupted = yield* Effect.exit(engine.interrupt(executionId))
      expect(interrupted._tag).toBe("Success")
      const stillUnknown = yield* Effect.flip(engine.result(executionId))
      expect(stillUnknown.code).toBe("engine_unavailable")
    }))
})

describe("failed flow bodies", () => {
  onEachSubject("journals a typed step failure", (engine) =>
    Effect.gen(function*() {
      const executionId = `testing/failed-step/${engine.name}`
      const refused = {
        _tag: "EngineUnavailableError",
        code: "engine_unavailable",
        message: "the step dependency is unavailable"
      } as const
      const result = yield* engine.run({
        flow: {
          name: `testing/failed-step/${engine.name}`,
          steps: [{
            key: "failed-step",
            sealed: false,
            kind: "step",
            run: () => Effect.fail(refused)
          }]
        },
        payload: undefined,
        executionId
      })

      expect(result).toMatchObject({
        executionId,
        status: "failed",
        value: { code: "engine_unavailable", message: "the step dependency is unavailable" }
      })
      expect(yield* engine.journal(executionId)).toEqual([
        expect.objectContaining({
          index: 0,
          stepKey: "failed-step",
          kind: "step",
          outcome: "failed",
          value: expect.objectContaining({ code: "engine_unavailable" })
        })
      ])
    }))

  onEachSubject("rejects a race with no branches", (engine) =>
    Effect.gen(function*() {
      const executionId = `testing/empty-race/${engine.name}`
      const result = yield* engine.run({
        flow: {
          name: `testing/empty-race/${engine.name}`,
          steps: [{ key: "empty-race", sealed: true, kind: "race", branches: [] }]
        },
        payload: undefined,
        executionId
      })

      expect(result.status).toBe("failed")
      expect(result.value).toMatchObject({ code: "engine_unavailable" })
      expect((result.value as EngineUnavailableError).message).toContain("has no branches")
      const journal = yield* engine.journal(executionId)
      expect(journal).toEqual(
        engine.name === "MemoryEngine"
          ? [expect.objectContaining({ stepKey: "empty-race", kind: "race", outcome: "failed" })]
          : []
      )
    }))

  onEachSubject("executes a nested race branch", (engine) =>
    Effect.gen(function*() {
      const executionId = `testing/nested-race/${engine.name}`
      const flow: FlowSpec = {
        name: `testing/nested-race/${engine.name}`,
        steps: [{
          key: "outer-race",
          sealed: true,
          kind: "race",
          branches: [{
            key: "inner-race",
            sealed: true,
            kind: "race",
            branches: [{
              key: "winner",
              sealed: true,
              kind: "step",
              run: () => Effect.succeed("nested-winner")
            }]
          }, {
            key: "inner-race-loser",
            sealed: false,
            kind: "race",
            branches: [{
              key: "nested-loser",
              sealed: false,
              kind: "step",
              run: () => Effect.never
            }]
          }]
        }]
      }

      const result = yield* engine.run({ flow, payload: undefined, executionId })
      expect(result).toMatchObject({ executionId, status: "completed", value: "nested-winner" })
      expect(yield* engine.journal(executionId)).toContainEqual(
        expect.objectContaining({ stepKey: "inner-race", kind: "race", outcome: "completed" })
      )
    }))
})

describe("MemoryEngine live execution joins", () => {
  // Real elapsed time: the timeout is the assertion that a startup entry did
  // not leave either public lifecycle operation parked on an empty deferred.
  it.live("does not wedge lifecycle operations when the run caller is interrupted during startup", () =>
    Effect.gen(function*() {
      for (let schedulerTurns = 0; schedulerTurns < 12; schedulerTurns++) {
        const store = yield* MemoryEngine.makeStore()
        const engine = yield* MemoryEngine.make(store)
        const release = yield* Latch.make()
        const executionId = `testing/memory/interrupted-start-${schedulerTurns}`
        const running = yield* engine.run({
          flow: {
            name: executionId,
            steps: [{
              key: "waiting",
              sealed: false,
              kind: "step",
              run: () => Effect.as(release.await, "done")
            }]
          },
          payload: undefined,
          executionId
        }).pipe(
          Effect.provideService(Scheduler.MaxOpsBeforeYield, 4),
          Effect.forkChild()
        )

        for (let turn = 0; turn < schedulerTurns; turn++) yield* Effect.yieldNow
        yield* Fiber.interrupt(running).pipe(Effect.timeout("2 seconds"))
        yield* release.open

        const resumed = yield* Effect.exit(engine.resume(executionId)).pipe(
          Effect.timeout("2 seconds"),
          Effect.exit
        )
        const interrupted = yield* Effect.exit(engine.interrupt(executionId)).pipe(
          Effect.timeout("2 seconds"),
          Effect.exit
        )
        expect(Exit.isSuccess(resumed), `resume wedged after ${schedulerTurns} scheduler turns`).toBe(true)
        expect(Exit.isSuccess(interrupted), `interrupt wedged after ${schedulerTurns} scheduler turns`).toBe(true)
      }
    }))

  it.live("removes a provisional active entry when arming fails", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/failed-arming"
      let attempts = 0
      const flow: FlowSpec = {
        name: executionId,
        steps: [{
          key: "suspend-once",
          sealed: false,
          kind: "step",
          run: () =>
            Effect.suspend(() => {
              attempts += 1
              return attempts === 1 ? Effect.interrupt : Effect.succeed("done")
            })
        }]
      }
      expect((yield* engine.run({ flow, payload: undefined, executionId })).status).toBe("suspended")

      interface ReflectedStoreState {
        readonly executions: ReadonlyMap<string, unknown>
        readonly idempotencyIndex: ReadonlyMap<string, string>
        readonly nextExecutionId: number
      }
      class MissingSecondReadMap<K, V> extends Map<K, V> {
        private reads = 0

        override get(key: K): V | undefined {
          this.reads += 1
          return this.reads === 2 ? undefined : super.get(key)
        }
      }

      // The store intentionally exposes no mutation API. Reflection here only
      // creates the otherwise impossible failure between start's successful
      // read and its status write, proving the provisional map entry is rolled
      // back rather than testing a second happy-path resume.
      const stateRef = Reflect.get(
        store,
        Object.getOwnPropertySymbols(store)[0]!
      ) as Ref.Ref<ReflectedStoreState>
      const state = yield* Ref.get(stateRef)
      yield* Ref.set(stateRef, {
        ...state,
        executions: new MissingSecondReadMap(state.executions)
      })

      const failure = yield* Effect.flip(engine.resume(executionId))
      expect(failure.code).toBe("engine_unavailable")
      expect(yield* engine.resume(executionId).pipe(Effect.timeout("2 seconds"))).toEqual({
        executionId,
        status: "completed",
        value: "done"
      })
    }))

  it.scoped("resume joins the deferred of an execution that is still running", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      const executionId = "testing/memory/live-resume"
      const flow: FlowSpec = {
        name: "testing/memory/live-resume",
        steps: [{
          key: "waiting",
          sealed: false,
          kind: "step",
          run: () => Effect.andThen(started.open, Effect.as(release.await, "done"))
        }]
      }

      const running = yield* engine.run({ flow, payload: undefined, executionId }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* started.await
      const resumed = yield* engine.resume(executionId).pipe(Effect.forkChild({ startImmediately: true }))
      yield* release.open

      expect(yield* Fiber.join(running)).toEqual({ executionId, status: "completed", value: "done" })
      expect(yield* Fiber.join(resumed)).toEqual({ executionId, status: "completed", value: "done" })
    }))

  // Real elapsed time: two callers must contend for one claim, which a frozen
  // clock cannot schedule.
  it.live("claims one worker when two resume callers contend for the same execution", () =>
    Effect.gen(function*() {
      for (const ops of [3, 4, 5, 6, 7, 8]) {
        const store = yield* MemoryEngine.makeStore()
        const engine = yield* MemoryEngine.make(store)
        const release = yield* Latch.make()
        const executionId = `testing/memory/contended-resume-${ops}`
        let frontierRuns = 0
        const flow: FlowSpec = {
          name: executionId,
          steps: [{
            key: "frontier",
            sealed: false,
            kind: "step",
            run: () =>
              Effect.suspend(() => {
                frontierRuns += 1
                return frontierRuns === 1 ? Effect.interrupt : Effect.as(release.await, `run-${frontierRuns}`)
              })
          }]
        }
        expect((yield* engine.run({ flow, payload: undefined, executionId })).status).toBe("suspended")

        const resumes = yield* Effect.all(
          [engine.resume(executionId), engine.resume(executionId)],
          { concurrency: "unbounded" }
        ).pipe(
          Effect.provideService(Scheduler.MaxOpsBeforeYield, ops),
          Effect.forkChild({ startImmediately: true })
        )
        for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
        yield* release.open
        const results = yield* Fiber.join(resumes).pipe(Effect.timeout("10 seconds"))

        expect(results, `resumes disagreed at ${ops} ops`).toEqual([
          { executionId, status: "completed", value: "run-2" },
          { executionId, status: "completed", value: "run-2" }
        ])
        expect(frontierRuns, `the frontier step ran twice at ${ops} ops`).toBe(2)
        const journal = yield* engine.journal(executionId)
        expect(
          journal.filter((entry) => entry.stepKey === "frontier" && entry.outcome === "completed"),
          `two workers journalled the frontier at ${ops} ops`
        ).toHaveLength(1)
      }
    }))

  it.scoped("runs a later race that reuses an unsealed branch key instead of replaying the earlier winner", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/race-occurrence"
      let contenderRuns = 0
      const contender = (): StepSpec => ({
        key: "contender",
        sealed: false,
        kind: "step",
        run: () => Effect.sync(() => `win-${++contenderRuns}`)
      })
      const result = yield* engine.run({
        flow: {
          name: executionId,
          steps: [
            { key: "first-race", sealed: false, kind: "race", branches: [contender()] },
            { key: "second-race", sealed: false, kind: "race", branches: [contender()] }
          ]
        },
        payload: undefined,
        executionId
      })

      expect(result).toEqual({ executionId, status: "completed", value: "win-2" })
      expect(contenderRuns).toBe(2)
      const journal = yield* engine.journal(executionId)
      expect(
        journal
          .filter((entry) => entry.stepKey === "contender" && entry.outcome === "completed")
          .map((entry) => entry.value)
      ).toEqual(["win-1", "win-2"])
    }))

  it.scoped("replays a sealed branch key shared by two races", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/race-sealed-alias"
      let contenderRuns = 0
      const contender = (): StepSpec => ({
        key: "contender",
        sealed: true,
        kind: "step",
        run: () => Effect.sync(() => `win-${++contenderRuns}`)
      })
      const result = yield* engine.run({
        flow: {
          name: executionId,
          steps: [
            { key: "first-race", sealed: true, kind: "race", branches: [contender()] },
            { key: "second-race", sealed: true, kind: "race", branches: [contender()] }
          ]
        },
        payload: undefined,
        executionId
      })

      expect(result).toEqual({ executionId, status: "completed", value: "win-1" })
      expect(contenderRuns).toBe(1)
      const journal = yield* engine.journal(executionId)
      expect(
        journal.filter((entry) => entry.stepKey === "contender" && entry.outcome === "completed")
      ).toHaveLength(1)
    }))

  it.scoped("interrupting a completed execution preserves its terminal result", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/terminal-interrupt"
      const completed = yield* engine.run({
        flow: {
          name: "testing/memory/terminal-interrupt",
          steps: [{ key: "done", sealed: false, kind: "step", run: () => Effect.succeed("done") }]
        },
        payload: undefined,
        executionId
      })
      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual(completed)
    }))

  it.scoped("suspends and aborts without inventing a frontier after every sealed step is recorded", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const executionScope = yield* Scope.make()
      const engine = yield* MemoryEngine.make(store).pipe(Effect.provideService(Scope.Scope, executionScope))
      const executionId = "testing/memory/recorded-tail"
      let runs = 0
      const sealed: StepSpec = {
        key: "sealed",
        sealed: true,
        kind: "step",
        run: () => Effect.sync(() => ++runs)
      }
      const running = yield* engine.run({
        flow: {
          name: "testing/memory/recorded-tail",
          steps: Array.from({ length: 50_000 }, () => sealed)
        },
        payload: undefined,
        executionId
      }).pipe(Effect.forkChild({ startImmediately: true }))

      while ((yield* engine.journal(executionId)).length === 0) {
        yield* Effect.yieldNow
      }
      yield* Scope.close(executionScope, Exit.void)

      expect(yield* Fiber.join(running)).toEqual({ executionId, status: "suspended" })
      expect(runs).toBe(1)
      expect(yield* engine.journal(executionId)).toEqual([
        expect.objectContaining({ stepKey: "sealed", outcome: "completed", value: 1 })
      ])

      const restarted = yield* MemoryEngine.make(store)
      yield* restarted.interrupt(executionId)
      expect(yield* restarted.result(executionId)).toEqual({ executionId, status: "aborted" })
      expect(yield* restarted.journal(executionId)).toHaveLength(1)
    }))

  it.scoped("replays a nested race winner recorded before its wrapper", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const executionScope = yield* Scope.make()
      const engine = yield* MemoryEngine.make(store).pipe(Effect.provideService(Scope.Scope, executionScope))
      const loserStarted = yield* Latch.make()
      const loserFinalizing = yield* Latch.make()
      const releaseLoser = yield* Latch.make()
      const executionId = "testing/memory/nested-race-replay"
      let winnerRuns = 0
      const flow: FlowSpec = {
        name: "testing/memory/nested-race-replay",
        steps: [{
          key: "outer",
          sealed: true,
          kind: "race",
          branches: [{
            key: "nested",
            sealed: true,
            kind: "race",
            branches: [{
              key: "winner",
              sealed: true,
              kind: "step",
              run: () => Effect.andThen(loserStarted.await, Effect.sync(() => ++winnerRuns))
            }, {
              key: "loser",
              sealed: false,
              kind: "step",
              run: () =>
                Effect.acquireUseRelease(
                  loserStarted.open,
                  () => Effect.never,
                  () => Effect.andThen(loserFinalizing.open, releaseLoser.await)
                )
            }]
          }]
        }]
      }
      const running = yield* engine.run({ flow, payload: undefined, executionId }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* loserFinalizing.await

      const partial = yield* engine.journal(executionId)
      expect(partial).toContainEqual(expect.objectContaining({ stepKey: "winner", outcome: "completed", value: 1 }))
      expect(partial).not.toContainEqual(expect.objectContaining({ stepKey: "nested", outcome: "completed" }))

      const closing = yield* Scope.close(executionScope, Exit.void).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* releaseLoser.open
      yield* Fiber.join(closing)
      expect((yield* Fiber.join(running)).status).toBe("suspended")

      const restarted = yield* MemoryEngine.make(store)
      expect(yield* restarted.resume(executionId)).toEqual({ executionId, status: "completed", value: 1 })
      expect(winnerRuns).toBe(1)
      expect(yield* restarted.journal(executionId)).toContainEqual(
        expect.objectContaining({ stepKey: "nested", outcome: "completed", value: 1 })
      )
    }))

  it.scoped("finds the suspended frontier after completed sealed and occurrence steps", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/suspended-frontier"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/suspended-frontier",
          steps: [
            { key: "sealed", sealed: true, kind: "step", run: () => Effect.succeed("sealed") },
            { key: "sealed", sealed: true, kind: "step", run: () => Effect.succeed("unused") },
            { key: "occurrence", sealed: false, kind: "step", run: () => Effect.succeed("first") },
            { key: "occurrence", sealed: false, kind: "step", run: () => Effect.succeed("second") },
            { key: "frontier", sealed: false, kind: "step", run: () => Effect.interrupt }
          ]
        },
        payload: undefined,
        executionId
      })
      expect(result.status).toBe("suspended")

      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
      const journal = yield* engine.journal(executionId)
      expect(journal.filter((entry) => entry.stepKey === "sealed" && entry.outcome === "completed")).toHaveLength(1)
      expect(journal.filter((entry) => entry.stepKey === "occurrence" && entry.outcome === "completed")).toHaveLength(2)
      expect(journal.at(-1)).toMatchObject({ stepKey: "frontier", outcome: "aborted" })
    }))

  it.scoped("finds the suspended frontier after a completed race", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/race-frontier"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/race-frontier",
          steps: [{
            key: "race",
            sealed: true,
            kind: "race",
            branches: [{ key: "winner", sealed: false, kind: "step", run: () => Effect.succeed("won") }]
          }, {
            key: "frontier",
            sealed: false,
            kind: "step",
            run: () => Effect.interrupt
          }]
        },
        payload: undefined,
        executionId
      })
      expect(result.status).toBe("suspended")
      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
      expect((yield* engine.journal(executionId)).at(-1)).toMatchObject({
        stepKey: "frontier",
        outcome: "aborted"
      })
    }))

  it.scoped("reuses a recorded race winner while resuming its later frontier", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      let raceRuns = 0
      let frontierRuns = 0
      const executionId = "testing/memory/race-resume"
      const flow: FlowSpec = {
        name: "testing/memory/race-resume",
        steps: [{
          key: "race",
          sealed: true,
          kind: "race",
          branches: [{
            key: "winner",
            sealed: false,
            kind: "step",
            run: () => Effect.sync(() => ++raceRuns).pipe(Effect.as("won"))
          }]
        }, {
          key: "frontier",
          sealed: false,
          kind: "step",
          run: () =>
            Effect.suspend(() => {
              frontierRuns += 1
              return frontierRuns === 1 ? Effect.interrupt : Effect.succeed("resumed")
            })
        }]
      }

      expect((yield* engine.run({ flow, payload: undefined, executionId })).status).toBe("suspended")
      expect(yield* engine.resume(executionId)).toEqual({ executionId, status: "completed", value: "resumed" })
      expect({ raceRuns, frontierRuns }).toEqual({ raceRuns: 1, frontierRuns: 2 })
    }))

  it.scoped("records a failed race branch before another branch wins", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/race-branch-failure"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/race-branch-failure",
          steps: [{
            key: "race",
            sealed: true,
            kind: "race",
            branches: [{
              key: "refused",
              sealed: false,
              kind: "step",
              run: () => Effect.fail({ code: "engine_unavailable", message: "branch refused" })
            }, {
              key: "winner",
              sealed: false,
              kind: "step",
              run: () => Effect.andThen(Effect.yieldNow, Effect.succeed("winner"))
            }]
          }]
        },
        payload: undefined,
        executionId
      })
      expect(result).toEqual({ executionId, status: "completed", value: "winner" })
      expect(yield* engine.journal(executionId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stepKey: "refused",
          outcome: "failed",
          value: { code: "engine_unavailable", message: "branch refused" }
        }),
        expect.objectContaining({ stepKey: "winner", outcome: "completed", value: "winner" })
      ]))
    }))

  it.scoped("records a branch that self-interrupts before another branch wins", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/race-self-interrupt"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/race-self-interrupt",
          steps: [{
            key: "race",
            sealed: true,
            kind: "race",
            branches: [{
              key: "self-interrupted",
              sealed: false,
              kind: "step",
              run: () => Effect.interrupt
            }, {
              key: "winner",
              sealed: false,
              kind: "step",
              run: () => Effect.andThen(Effect.yieldNow, Effect.succeed("winner"))
            }]
          }]
        },
        payload: undefined,
        executionId
      })
      expect(result).toEqual({ executionId, status: "completed", value: "winner" })
      expect(yield* engine.journal(executionId)).toContainEqual(
        expect.objectContaining({ stepKey: "self-interrupted", outcome: "aborted" })
      )
    }))

  it.scoped("finds a race itself as the frontier when no branch completed", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/suspended-race-frontier"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/suspended-race-frontier",
          steps: [{
            key: "suspended-race",
            sealed: true,
            kind: "race",
            branches: [{
              key: "self-interrupted",
              sealed: false,
              kind: "step",
              run: () => Effect.interrupt
            }]
          }]
        },
        payload: undefined,
        executionId
      })
      expect(result.status).toBe("suspended")
      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
      expect((yield* engine.journal(executionId)).at(-1)).toMatchObject({
        stepKey: "suspended-race",
        outcome: "aborted"
      })
    }))

  it.scoped("provides the engine through its public layer", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* EngineSubject.EngineSubject.pipe(Effect.provide(MemoryEngine.layer(store)))
      expect(engine.name).toBe("MemoryEngine")
    }))
})
