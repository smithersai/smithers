/**
 * The race pin's conversion of an engine failure into its own typed
 * conformance diagnostic.
 *
 * The double starts both real pin-supplied branch closures, then fails the run
 * itself. This reaches the defensive successful-fiber check without weakening
 * the assertion to an untyped exit check.
 */
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { EngineSubject as Subject, FlowSpec, JournalEntryLike, StepSpec } from "../src/EngineSubject.ts"
import * as EngineSubject from "../src/EngineSubject.ts"
import * as MemoryEngine from "../src/MemoryEngine.ts"
import * as Race from "../src/pins/Race.ts"
import * as Replay from "../src/pins/Replay.ts"
import { EngineUnavailableError } from "../src/TestingError.ts"
import { expect, it } from "../src/Vitest.ts"

const failingRaceSubject: Subject = EngineSubject.make({
  name: "failing-race-subject",
  run: ((options) =>
    Effect.gen(function*() {
      const race = options.flow.steps[0]
      if (race?.kind === "race") {
        yield* Effect.forEach(
          race.branches,
          (branch) =>
            branch.kind === "step"
              ? branch.run(options.payload).pipe(Effect.forkChild({ startImmediately: true }))
              : Effect.void,
          { discard: true }
        )
        yield* Effect.yieldNow
      }
      return yield* Effect.fail(new EngineUnavailableError({ message: "race execution escaped" }))
    })) as Subject["run"],
  result: () => Effect.fail(new EngineUnavailableError({ message: "no result" })),
  interrupt: () => Effect.void,
  resume: () => Effect.fail(new EngineUnavailableError({ message: "no resume" })),
  journal: () => Effect.succeed([])
})

it.effect("reports a failed fresh race with the conformance code and pin", () =>
  Effect.gen(function*() {
    const error = yield* Race.cases[0]!.run(failingRaceSubject).pipe(Effect.flip)
    expect(error).toMatchObject({
      code: "conformance_violation",
      pin: "race/loser-interrupted"
    })
    expect((error as { readonly message: string }).message).toContain("fresh race escaped as a failure or defect")
  }))

it.scoped("reports a subject that re-races instead of replaying its recorded winner", () =>
  Effect.gen(function*() {
    const store = yield* MemoryEngine.makeStore()
    const base = yield* MemoryEngine.make(store)
    let submitted: Parameters<Subject["run"]>[0] | undefined
    let replayExecutionId: string | undefined
    let replaying = false
    const rerunsOnResume = EngineSubject.make({
      name: "reruns-race-on-resume",
      run: (options) => {
        submitted = options
        return base.run(options)
      },
      result: base.result,
      interrupt: base.interrupt,
      resume: (executionId) =>
        Effect.suspend(() => {
          if (submitted === undefined) {
            return Effect.fail(new EngineUnavailableError({ message: "nothing was submitted" }))
          }
          replaying = true
          replayExecutionId = `${executionId}/incorrect-replay`
          return base.run({ ...submitted, executionId: replayExecutionId })
        }),
      journal: (executionId) => base.journal(replaying ? replayExecutionId! : executionId)
    })

    const error = yield* Race.cases[1]!.run(rerunsOnResume).pipe(Effect.flip)
    expect(error).toMatchObject({
      code: "conformance_violation",
      pin: "race/recorded-winner-replay"
    })
    expect((error as { readonly message: string }).message).toContain("reconstruct the journaled winner")
  }))

const raceBranchKeys = (flow: FlowSpec): ReadonlySet<string> => {
  const keys = new Set<string>()
  const visit = (step: StepSpec): void => {
    if (step.kind !== "race") return
    for (const branch of step.branches) {
      keys.add(branch.key)
      visit(branch)
    }
  }
  flow.steps.forEach(visit)
  return keys
}

interface ReflectedExecution {
  readonly journal: ReadonlyArray<JournalEntryLike>
}

interface ReflectedState {
  readonly executions: ReadonlyMap<string, ReflectedExecution>
}

// The store exposes no mutation API, and `resume` runs the flow the store
// already holds, so rewriting the submitted spec cannot express this subject.
// Reflection builds the one implementation the race replay pins exist to
// reject: an engine that still caches terminal results and completed steps but
// has lost the recorded winner it would otherwise replay.
const forgetRecordedWinners = (
  store: MemoryEngine.EngineStore,
  branchKeys: ReadonlySet<string>
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const stateRef = Reflect.get(
      store,
      Object.getOwnPropertySymbols(store)[0]!
    ) as Ref.Ref<ReflectedState>
    return Ref.update(stateRef, (state) => {
      const executions = new Map<string, ReflectedExecution>()
      for (const [executionId, execution] of state.executions) {
        executions.set(executionId, {
          ...execution,
          journal: execution.journal.filter(
            (entry) => !(branchKeys.has(entry.stepKey) && entry.outcome === "completed")
          )
        })
      }
      return { ...state, executions }
    })
  })

it.scoped("reports a subject that keeps terminal results but forgets its recorded race winner", () =>
  Effect.gen(function*() {
    const store = yield* MemoryEngine.makeStore()
    const base = yield* MemoryEngine.make(store)
    let branchKeys: ReadonlySet<string> = new Set()
    const forgetsWinners = EngineSubject.make({
      name: "forgets-recorded-race-winners",
      run: (options) => {
        branchKeys = raceBranchKeys(options.flow)
        return base.run(options)
      },
      result: base.result,
      interrupt: base.interrupt,
      resume: (executionId) => Effect.andThen(forgetRecordedWinners(store, branchKeys), base.resume(executionId)),
      journal: base.journal
    })

    // Only race reconstruction is gone: completed-prefix and suspended-frontier
    // replay still hold, which is exactly the subject the race pins used to
    // certify while resuming a finished execution.
    for (const replayCase of Replay.cases) {
      yield* replayCase.run(forgetsWinners)
    }

    for (const pin of ["race/recorded-winner-replay", "race/recorded-loser-interruption"]) {
      const conformanceCase = Race.cases.find((candidate) => candidate.name === pin)!
      const error = yield* conformanceCase.run(forgetsWinners).pipe(Effect.flip)
      expect(error, pin).toMatchObject({ code: "conformance_violation", pin })
    }
  }))

it.scoped("completed-prefix replay rejects an engine that preserves terminal results but loses sealed steps", () =>
  Effect.gen(function*() {
    const store = yield* MemoryEngine.makeStore()
    const base = yield* MemoryEngine.make(store)
    let prefixKeys: ReadonlySet<string> = new Set()
    const forgetsPrefix = EngineSubject.make({
      name: "forgets-completed-prefix",
      run: (options) => {
        prefixKeys = new Set(options.flow.steps.filter((step) => step.sealed).map((step) => step.key))
        return base.run(options)
      },
      result: base.result,
      interrupt: base.interrupt,
      resume: (executionId) =>
        Effect.flatMap(base.result(executionId), (result) =>
          result.status === "completed"
            ? base.resume(executionId)
            : Effect.andThen(forgetRecordedWinners(store, prefixKeys), base.resume(executionId))),
      journal: base.journal
    })
    const pin = Replay.cases.find((candidate) => candidate.name === "replay/completed-prefix")!
    const error = yield* pin.run(forgetsPrefix).pipe(Effect.flip)
    expect(error).toMatchObject({ code: "conformance_violation", pin: pin.name })
  }))
