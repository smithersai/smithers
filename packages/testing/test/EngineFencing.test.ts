/**
 * A dead owner's late result cannot replace a successor's result or journal.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Scheduler from "effect/Scheduler"
import * as Scope from "effect/Scope"
import type { FlowSpec } from "../src/EngineSubject.ts"
import { revokeOwner } from "../src/internal/MemoryEngineOwner.ts"
import * as MemoryEngine from "../src/MemoryEngine.ts"
import * as RestartableEngine from "../src/RestartableEngine.ts"
import { expect, it } from "../src/Vitest.ts"

for (const lateFailure of [false, true]) {
  it.scoped(`preserves an aborted result and journal after a killed step ${lateFailure ? "fails" : "succeeds"}`, () =>
    Effect.gen(function*() {
      const harness = yield* RestartableEngine.make()
      const firstStarted = yield* Latch.make()
      const secondStarted = yield* Latch.make()
      const release = yield* Latch.make()
      let attempts = 0
      let afterRuns = 0
      const executionId = "fenced"
      const flow: FlowSpec = {
        name: "fenced",
        steps: [{
          kind: "step",
          key: "charge",
          sealed: false,
          run: () =>
            Effect.gen(function*() {
              attempts += 1
              yield* (attempts === 1 ? firstStarted.open : secondStarted.open)
              yield* release.await
              return yield* (lateFailure ? Effect.fail("late failure") : Effect.succeed("charged"))
            })
        }, {
          kind: "step",
          key: "after",
          sealed: false,
          run: () => Effect.sync(() => ++afterRuns)
        }]
      }
      const abandoned = yield* harness.engine.run({ flow, executionId, payload: undefined }).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true })
      )
      yield* firstStarted.await
      const resumed = yield* harness.killAndResume(executionId).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* secondStarted.await
      yield* harness.engine.interrupt(executionId)
      const terminal = yield* harness.engine.result(executionId)
      const journal = yield* harness.engine.journal(executionId)
      expect(terminal).toEqual({ executionId, status: "aborted" })
      expect(journal).toEqual([{ index: 0, stepKey: "charge", kind: "step", outcome: "aborted" }])
      yield* release.open
      yield* Fiber.join(abandoned)
      expect(yield* Fiber.join(resumed)).toEqual(terminal)
      expect(yield* harness.engine.result(executionId)).toEqual(terminal)
      expect(yield* harness.engine.journal(executionId)).toEqual(journal)
      expect(afterRuns).toBe(0)
    }))
}

for (const lateFailure of [false, true]) {
  for (const hasAfter of [false, true]) {
    it.scoped(`keeps cancellation by another shared-store instance terminal when a step settles: ${lateFailure}/${hasAfter}`, () =>
      Effect.gen(function*() {
        const store = yield* MemoryEngine.makeStore()
        const engine = yield* MemoryEngine.make(store)
        const canceller = yield* MemoryEngine.make(store)
        const started = yield* Latch.make()
        const release = yield* Latch.make()
        let afterRuns = 0
        const executionId = "cancelled-shared-execution"
        const flow: FlowSpec = {
          name: executionId,
          steps: [
            {
              kind: "step",
              key: "held",
              sealed: false,
              run: () =>
                Effect.gen(function*() {
                  yield* started.open
                  yield* release.await
                  return yield* (lateFailure ? Effect.fail("late failure") : Effect.succeed("late success"))
                })
            },
            ...(hasAfter ?
              [{
                kind: "step" as const,
                key: "after",
                sealed: false,
                run: () => Effect.sync(() => ++afterRuns)
              }] :
              [])
          ]
        }
        const run = yield* engine.run({ flow, executionId, payload: undefined }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* started.await
        yield* canceller.interrupt(executionId)
        expect(yield* canceller.result(executionId)).toEqual({ executionId, status: "aborted" })
        const journal = yield* engine.journal(executionId)
        yield* release.open
        expect(yield* Fiber.join(run)).toEqual({ executionId, status: "aborted" })
        expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
        expect(yield* engine.journal(executionId)).toEqual(journal)
        expect(afterRuns).toBe(0)
      }))
  }
}

it.effect("fails a killed instance's caller when the harness closes over its running step", () =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const harness = yield* RestartableEngine.make().pipe(Scope.provide(scope))
    const started = yield* Latch.make()
    const executionId = "held"
    const flow: FlowSpec = {
      name: executionId,
      steps: [{ kind: "step", key: "held", sealed: false, run: () => Effect.andThen(started.open, Effect.never) }]
    }
    const abandoned = yield* harness.engine.run({ flow, executionId, payload: undefined }).pipe(
      Effect.exit,
      Effect.forkChild({ startImmediately: true })
    )
    yield* started.await
    yield* harness.kill
    const before = yield* harness.engine.result(executionId)
    // Closing the abandoned scope interrupts its worker, whose cleanup write
    // is fenced: the close succeeds and the store keeps the successor's view.
    expect(Exit.isSuccess(yield* Effect.exit(Scope.close(scope, Exit.void)))).toBe(true)
    const exit = yield* Fiber.join(abandoned)
    expect(Exit.findErrorOption(exit)).toMatchObject({ _tag: "Some", value: { _tag: "EngineUnavailableError" } })
    expect(yield* harness.engine.result(executionId)).toEqual(before)
  }))

it.scoped("lets multiple engine instances finish independent executions on a shared store", () =>
  Effect.gen(function*() {
    const store = yield* MemoryEngine.makeStore()
    const first = yield* MemoryEngine.make(store)
    const started = yield* Latch.make()
    const release = yield* Latch.make()
    const flow: FlowSpec = {
      name: "shared",
      steps: [{
        kind: "step",
        key: "held",
        sealed: false,
        run: () => Effect.andThen(started.open, Effect.as(release.await, "first"))
      }]
    }
    const running = yield* first.run({ flow, payload: null, executionId: "first" }).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    yield* started.await
    const second = yield* MemoryEngine.make(store)
    expect(yield* second.run({ flow: { name: "second", steps: [] }, payload: "second", executionId: "second" }))
      .toEqual({ executionId: "second", status: "completed", value: "second" })
    yield* release.open
    expect(yield* Fiber.join(running)).toEqual({ executionId: "first", status: "completed", value: "first" })
    expect(yield* second.journal("first")).toEqual([{
      index: 0,
      stepKey: "held",
      kind: "step",
      outcome: "completed",
      value: "first"
    }])
    expect(yield* first.run({ flow: { name: "third", steps: [] }, payload: "third", executionId: "third" }))
      .toEqual({ executionId: "third", status: "completed", value: "third" })
  }))

it.live("settles every startup joiner when an engine instance is killed", () =>
  Effect.gen(function*() {
    for (const ops of [3, 4, 5, 6, 7, 8]) {
      for (let turns = 0; turns < 10; turns++) {
        const harness = yield* RestartableEngine.make()
        const old = harness.engine
        const release = yield* Latch.make()
        const executionId = "startup"
        const flow: FlowSpec = {
          name: executionId,
          steps: [{
            kind: "step",
            key: "held",
            sealed: false,
            run: () => Effect.as(release.await, "done")
          }]
        }
        const callers = yield* Effect.all(
          Array.from({ length: 3 }, () => Effect.exit(old.run({ flow, executionId, payload: null }))),
          { concurrency: "unbounded" }
        ).pipe(
          Effect.provideService(Scheduler.MaxOpsBeforeYield, ops),
          Effect.forkChild({ startImmediately: true })
        )
        for (let turn = 0; turn < turns; turn++) yield* Effect.yieldNow
        yield* harness.kill
        const current = harness.engine
        yield* release.open
        const results = yield* Fiber.join(callers).pipe(Effect.timeout("2 seconds"))
        expect(results).toHaveLength(3)
        for (const exit of results) {
          if (Exit.isFailure(exit)) {
            expect(Exit.findErrorOption(exit)).toMatchObject({
              _tag: "Some",
              value: { _tag: "EngineUnavailableError" }
            })
          } else {
            expect(exit.value).toEqual({ executionId, status: "completed", value: "done" })
          }
        }
        const result = yield* current.run({ flow, executionId, payload: null })
        expect(result).toEqual({ executionId, status: "completed", value: "done" })
      }
    }
  }))

for (const lateFailure of [false, true]) {
  it.scoped(`does not journal an uninterruptible race branch after cancellation: failure=${lateFailure}`, () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      const executionId = "cancelled-race"
      const flow: FlowSpec = {
        name: executionId,
        steps: [{
          kind: "race",
          key: "race",
          sealed: false,
          branches: [{
            kind: "step",
            key: "held",
            sealed: false,
            run: () =>
              Effect.gen(function*() {
                yield* started.open
                yield* release.await
                return yield* (lateFailure ? Effect.fail("late") : Effect.succeed("late"))
              }).pipe(Effect.uninterruptible)
          }]
        }]
      }
      const run = yield* engine.run({ flow, executionId, payload: null }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* started.await
      const interrupted = yield* engine.interrupt(executionId).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
      const journal = yield* engine.journal(executionId)
      yield* release.open
      yield* Fiber.join(interrupted)
      expect(yield* Fiber.join(run)).toEqual({ executionId, status: "aborted" })
      expect(yield* engine.journal(executionId)).toEqual(journal)
    }))
}

it.live("keeps a cancellation observed during startup terminal across scheduler interleavings", () =>
  Effect.gen(function*() {
    let aborted = 0
    for (const empty of [false, true]) {
      for (let ops = 3; ops <= 16; ops++) {
        for (let turns = 0; turns < 8; turns++) {
          const store = yield* MemoryEngine.makeStore()
          const engine = yield* MemoryEngine.make(store)
          const executionId = "startup-cancel"
          const flow: FlowSpec = {
            name: executionId,
            steps: empty ? [] : [{
              kind: "step",
              key: "step",
              sealed: false,
              run: () => Effect.andThen(Effect.yieldNow, Effect.succeed("done"))
            }]
          }
          const run = yield* engine.run({ flow, executionId, payload: "done" }).pipe(
            Effect.provideService(Scheduler.MaxOpsBeforeYield, ops),
            Effect.forkChild({ startImmediately: true })
          )
          for (let turn = 0; turn < turns; turn++) yield* Effect.yieldNow
          const interrupted = yield* engine.interrupt(executionId).pipe(
            Effect.provideService(Scheduler.MaxOpsBeforeYield, ops),
            Effect.forkChild({ startImmediately: true })
          )
          const observed = yield* engine.result(executionId).pipe(Effect.option)
          yield* Fiber.join(interrupted)
          const result = yield* Fiber.join(run)
          if (observed._tag === "Some" && observed.value.status === "aborted") {
            aborted++
            expect(result).toEqual(observed.value)
            expect(yield* engine.result(executionId)).toEqual(observed.value)
          }
          expect(result.status === "completed" || result.status === "aborted").toBe(true)
        }
      }
    }
    expect(aborted).toBeGreaterThan(0)
  }))

it.live("keeps the facade usable when a kill is interrupted during replacement", () =>
  Effect.gen(function*() {
    for (let ops = 3; ops <= 16; ops++) {
      for (let turns = 0; turns < 6; turns++) {
        const harness = yield* RestartableEngine.make()
        const killing = yield* harness.kill.pipe(
          Effect.provideService(Scheduler.MaxOpsBeforeYield, ops),
          Effect.forkChild({ startImmediately: true })
        )
        for (let turn = 0; turn < turns; turn++) yield* Effect.yieldNow
        yield* Fiber.interrupt(killing)
        expect(
          yield* harness.engine.run({
            flow: { name: "after-kill", steps: [] },
            executionId: "after-kill",
            payload: "available"
          })
        ).toEqual({ executionId: "after-kill", status: "completed", value: "available" })
      }
    }
  }))

it.live("serializes concurrent replacements and retains a usable current owner", () =>
  Effect.gen(function*() {
    const harness = yield* RestartableEngine.make()
    yield* Effect.all([harness.kill, harness.kill, harness.restart, harness.kill], { concurrency: "unbounded" }).pipe(
      Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)
    )
    expect(
      yield* harness.engine.run({
        flow: { name: "after-replacements", steps: [] },
        executionId: "after-replacements",
        payload: "available"
      })
    ).toEqual({ executionId: "after-replacements", status: "completed", value: "available" })
  }))

it.scoped("refuses a killed owner's new claims without writing an execution", () =>
  Effect.gen(function*() {
    const store = yield* MemoryEngine.makeStore()
    const engine = yield* MemoryEngine.make(store)
    yield* revokeOwner(engine)
    expect(
      yield* engine.run({
        flow: { name: "killed", steps: [] },
        payload: null,
        executionId: "killed"
      }).pipe(Effect.flip)
    ).toMatchObject({ _tag: "EngineUnavailableError" })
    expect(yield* engine.result("killed").pipe(Effect.flip)).toMatchObject({ _tag: "EngineUnavailableError" })
  }))

it.live("settles callers when a killed worker is interrupted at startup boundaries", () =>
  Effect.gen(function*() {
    for (let ops = 3; ops <= 16; ops++) {
      for (let turns = 0; turns < 8; turns++) {
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        const store = yield* MemoryEngine.makeStore()
        const engine = yield* MemoryEngine.make(store).pipe(Scope.provide(scope))
        const executionId = "killed-startup"
        const run = yield* engine.run({
          flow: {
            name: executionId,
            steps: [{ kind: "step", key: "held", sealed: false, run: () => Effect.never }]
          },
          executionId,
          payload: null
        }).pipe(
          Effect.exit,
          Effect.provideService(Scheduler.MaxOpsBeforeYield, ops),
          Effect.forkChild({ startImmediately: true })
        )
        for (let turn = 0; turn < turns; turn++) yield* Effect.yieldNow
        yield* revokeOwner(engine)
        yield* Scope.close(scope, Exit.void)
        const completed = yield* Fiber.join(run).pipe(Effect.timeoutOption("2 seconds"))
        expect(completed._tag, `ops=${ops}, turns=${turns}`).toBe("Some")
        if (completed._tag === "None") return
        const exit = completed.value
        expect(Exit.findErrorOption(exit)).toMatchObject({
          _tag: "Some",
          value: { _tag: "EngineUnavailableError" }
        })
      }
    }
  }))

it.live("settles a worker forked into an already closed construction scope", () =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const store = yield* MemoryEngine.makeStore()
    const engine = yield* MemoryEngine.make(store).pipe(Scope.provide(scope))
    yield* Scope.close(scope, Exit.void)
    let ran = false
    const executionId = "closed-scope"
    const result = yield* engine.run({
      flow: {
        name: executionId,
        steps: [{
          kind: "step",
          key: "step",
          sealed: false,
          run: () =>
            Effect.sync(() => {
              ran = true
            })
        }]
      },
      executionId,
      payload: null
    }).pipe(Effect.exit, Effect.timeout("2 seconds"))
    expect(Exit.findErrorOption(result)).toMatchObject({
      _tag: "Some",
      value: { _tag: "EngineUnavailableError" }
    })
    expect(ran).toBe(false)
    expect(yield* engine.result(executionId)).toEqual({ executionId, status: "suspended" })
    expect(yield* engine.journal(executionId)).toEqual([])
  }))
