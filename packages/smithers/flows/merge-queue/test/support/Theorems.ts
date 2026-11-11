/**
 * The theorems of the Lean reference as checks on a kernel's behaviour.
 *
 * `test/Invariant.test.ts` runs them on this package's kernel; the mutation
 * runner (`scripts/mutants.ts`) runs them on kernels with a planted bug.
 */

import type { Config, Event, Line, Result, Run, State, Status } from "../../src/index.ts"
import { random, trace } from "./Generate.ts"
import { violation } from "./Invariant.ts"

/** The part of a kernel the checks drive. */
export interface Kernel {
  readonly empty: State
  readonly initialConfig: Config
  readonly parseLine: (text: string) => Line | undefined
  readonly step: (config: Config, state: State, event: Event) => State
  readonly plan: (config: Config, state: State) => Event | undefined
  readonly settle: (config: Config, fuel: number, state: State) => State
  readonly ready: (state: State) => ReadonlyArray<unknown>
  readonly pending: (config: Config, run: Run) => boolean
  readonly isTerminal: (status: Status) => boolean
  readonly live: (state: State, run: Run) => ReadonlyArray<unknown> | undefined
  readonly green: (config: Config, results: ReadonlyArray<Result>) => boolean
  readonly complete: (config: Config, results: ReadonlyArray<Result>) => boolean
  readonly failed: (results: ReadonlyArray<Result>) => boolean
  readonly passed: (results: ReadonlyArray<Result>, check: number) => boolean
}

/** One event of one trace, with the state before and after it. */
export interface Step {
  readonly seed: number
  readonly config: Config
  readonly before: State
  readonly event: Event
  readonly after: State
}

/** Every event of every trace for the seeds `1..seeds`, run through the kernel. */
export const steps = (kernel: Kernel, seeds: number, length: number): ReadonlyArray<Step> => {
  const out: Array<Step> = []
  for (let seed = 1; seed <= seeds; seed++) {
    let config = kernel.initialConfig
    let state = kernel.empty
    for (const text of trace(seed, length)) {
      const line = kernel.parseLine(text)
      if (line === undefined) continue
      if (line._tag === "config") {
        config = line.config
        state = kernel.empty
        continue
      }
      const event = line._tag === "plan" ? kernel.plan(config, state) : line.event
      if (event === undefined) continue
      const after = kernel.step(config, state, event)
      out.push({ seed, config, before: state, event, after })
      state = after
    }
  }
  return out
}

/** Whether two states hold the same values. */
export const same = (left: State, right: State): boolean => JSON.stringify(left) === JSON.stringify(right)

/** One theorem of the reference, as a check on one step. */
export interface Theorem {
  /** The Lean theorems it mirrors. */
  readonly name: string
  readonly statement: string
  readonly holds: (kernel: Kernel, entry: Step) => boolean
}

/** The reference's theorems that can be checked one step at a time. */
export const theorems: ReadonlyArray<Theorem> = [
  {
    name: "Inv.step",
    statement: "every state satisfies the invariant",
    holds: (_, entry) => violation(entry.config, entry.after) === undefined
  },
  {
    name: "main_moves_only_by_land, main_only_grows",
    statement: "only a landing moves the target, and only by appending",
    holds: (_, entry) =>
      (entry.event._tag === "land" || JSON.stringify(entry.after.main) === JSON.stringify(entry.before.main))
      && JSON.stringify(entry.after.main.slice(0, entry.before.main.length)) === JSON.stringify(entry.before.main)
  },
  {
    name: "step_idempotent",
    statement: "delivering any event twice is delivering it once",
    holds: (kernel, entry) => same(kernel.step(entry.config, entry.after, entry.event), entry.after)
  },
  {
    name: "ended_is_final, never_lost",
    statement: "an ended change never changes and no change disappears",
    holds: (kernel, entry) =>
      entry.before.changes.every((change, index) => {
        const later = entry.after.changes[index]
        return later !== undefined && later.id === change.id && later.seq === change.seq
          && later.priority === change.priority
          && (!kernel.isTerminal(change.status) || JSON.stringify(later) === JSON.stringify(change))
      })
  },
  {
    name: "plan_takes_effect",
    statement: "every decision the policy makes changes the state",
    holds: (kernel, entry) => {
      const event = kernel.plan(entry.config, entry.after)
      return event === undefined || !same(kernel.step(entry.config, entry.after, event), entry.after)
    }
  },
  {
    name: "no_deadlock",
    statement: "with checks and a run slot, an idle queue with ready changes is waiting on a pending run",
    holds: (kernel, entry) =>
      entry.config.required.length === 0 || entry.config.maxRuns === 0
      || kernel.plan(entry.config, entry.after) !== undefined || kernel.ready(entry.after).length === 0
      || entry.after.runs.some((run) => kernel.pending(entry.config, run))
  },
  {
    name: "enqueue_always_accepted, enqueue_keeps_runs_live",
    statement: "a new change is accepted in every state and disturbs no run in flight",
    holds: (kernel, entry) => {
      const id = 1 + Math.max(0, ...entry.after.changes.map((change) => change.id))
      const next = kernel.step(entry.config, entry.after, { _tag: "enqueue", id, priority: 9 })
      return next.changes.some((change) => change.id === id && change.status._tag === "queued")
        && JSON.stringify(next.runs) === JSON.stringify(entry.after.runs)
        && JSON.stringify(next.main) === JSON.stringify(entry.after.main)
        && entry.after.runs.every((run) =>
          JSON.stringify(kernel.live(next, run)) === JSON.stringify(kernel.live(entry.after, run))
        )
    }
  },
  {
    name: "free_slot_is_used, fixing_is_out_of_the_way",
    statement: "the queue never idles with a free slot and a waiting change, and a change being fixed is not waited on",
    holds: (kernel, entry) =>
      (entry.config.required.length === 0 || entry.config.maxRuns === 0 || kernel.ready(entry.after).length === 0
        || entry.after.runs.some((run) => kernel.pending(entry.config, run))
        || kernel.plan(entry.config, entry.after) !== undefined)
      && (kernel.ready(entry.after) as ReadonlyArray<{ readonly status: Status }>).every((change) =>
        change.status._tag === "queued"
      )
  },
  {
    name: "the policy settles",
    statement: "the policy never decides forever without the world",
    holds: (kernel, entry) => kernel.plan(entry.config, kernel.settle(entry.config, 200, entry.after)) === undefined
  }
]

/** One theorem of the reference about a function of the kernel, for any input. */
export interface Law {
  readonly name: string
  readonly statement: string
  readonly holds: (kernel: Kernel) => boolean
}

/** Result sets of every shape, including ones no run can hold: duplicates and checks that are not required. */
const resultSets = (count: number): ReadonlyArray<readonly [Config, ReadonlyArray<Result>]> => {
  const next = random(7)
  return Array.from({ length: count }, () => {
    const required = [1, 2, 3].filter(() => next() < 0.6)
    const results = Array.from({ length: Math.floor(next() * 6) }, (): Result => ({
      check: 1 + Math.floor(next() * 4),
      verdict: next() < 0.75 ? "pass" : "fail"
    }))
    const config: Config = { required, maxAttempts: 1, maxBatch: 1, maxRuns: 1, window: 1, defaultDuration: 1 }
    return [config, results] as const
  })
}

/** The reference's theorems about `green`, which hold for every result set. */
export const laws: ReadonlyArray<Law> = [
  {
    name: "green_complete, green_not_failed, green_checked",
    statement: "a green result is complete, has no failure, and passed at least one required check",
    holds: (kernel) =>
      resultSets(4000).every(([config, results]) =>
        !kernel.green(config, results)
        || (kernel.complete(config, results) && !kernel.failed(results) && config.required.length > 0
          && config.required.every((check) => kernel.passed(results, check)))
      )
  },
  {
    name: "green_of_complete",
    statement: "a complete result with no failure is green when a check is required",
    holds: (kernel) =>
      resultSets(4000).every(([config, results]) =>
        kernel.green(config, results)
        || !(config.required.length > 0 && kernel.complete(config, results) && !kernel.failed(results))
      )
  }
]

/** For each theorem a kernel breaks, the first seed that shows it. */
export const broken = (kernel: Kernel, all: ReadonlyArray<Step>): ReadonlyArray<string> => [
  ...theorems.flatMap((theorem) => {
    const failing = all.find((entry) => !theorem.holds(kernel, entry))
    return failing === undefined ? [] : [`${theorem.name} (seed ${failing.seed})`]
  }),
  ...laws.flatMap((law) => law.holds(kernel) ? [] : [law.name])
]
