import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Ref, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  type Config,
  empty,
  type Event,
  initialConfig,
  landNow,
  nextStart,
  plan,
  settle,
  type State,
  step
} from "../src/Kernel.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const integer = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const scenario = Arbitrary.schema(Schema.Struct({
  count: integer(2, 7),
  checks: integer(1, 3),
  slots: integer(1, 5),
  batch: integer(0, 4),
  attempts: integer(0, 2),
  tape: Schema.Array(integer(0, 255)).check(Schema.isMinLength(1), Schema.isMaxLength(15))
}))

const cohort = (config: Config, count: number, priority: (index: number) => number) => {
  let state = empty
  for (let i = 0; i < count; i++) {
    // IDs decrease on purpose: sorting them would reverse FIFO.
    state = step(config, state, { _tag: "enqueue", id: count - i, priority: priority(i) })
  }
  return state
}

// Measure.lean counts *all* held trees (including stale ones), but counts failed
// prefixes only in the current ready order. Compute both independently of plan.
function observe(config: Config, state: State) {
  const ready = state.changes.filter((c) => c.status._tag === "queued")
    .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
  const key = (parts: State["main"]) => parts.map((p) => p.id + "." + p.rev).join("/")
  const held = new Map<string, { failed: boolean }>()
  let owed = 0
  let pending = 0
  for (const run of state.runs) {
    const tree = key([...run.base, ...run.batch])
    const failed = run.results.some((r) => r.verdict === "fail")
    held.set(tree, { failed: failed || held.get(tree)?.failed === true })
    const missing = config.required.filter((check) => !run.results.some((r) => r.check === check)).length
    owed += missing
    if (missing > 0 && !failed) pending++
  }
  const prefixes = ready.map((_, index) => held.get(key([...state.main, ...ready.slice(0, index + 1)])))
  const failedIndex = prefixes.findIndex((p) => p?.failed)
  const openPrefixes = prefixes.slice(0, failedIndex < 0 ? prefixes.length : failedIndex).filter((p) => !p).length
  const openProbes = ready.filter((c) => !held.has(key([...state.main, c]))).length
  const pushed = state.runs.find((r) => r.id === state.pushing)
  const candidate = pushed ? [...pushed.base, ...pushed.batch] : []
  const suffix = candidate.slice(state.main.length)
  const pushing = key(candidate.slice(0, state.main.length)) === key(state.main) && suffix.length > 0 &&
    suffix.every((p) => ready.some((c) => c.id === p.id && c.rev === p.rev))
  const budget = state.changes.reduce((sum, c) => {
    if (c.status._tag !== "queued" && c.status._tag !== "fixing") return sum
    return sum + 2 * Math.max(0, config.maxAttempts - c.attempts) + (c.status._tag === "fixing" ? 2 : 1)
  }, 0)
  const weight = config.required.length + 2
  const measure = budget * (weight * 2 * state.changes.length + 2) + weight * (openPrefixes + openProbes)
    + Number(!pushing) + state.runs.length + owed
  return { measure, prefixes, failedIndex, pending, ready }
}

const checkReport = <A, E>(report: Fuzz.Report<A, E>) => expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")

describe("Lean merge-queue theorems on reachable kernel states", () => {
  it("every policy decision and effective answer spends the global measure until all changes end", async () => {
    checkReport(
      await Effect.runPromise(Fuzz.run(scenario, (s) =>
        Effect.gen(function*() {
          const config = {
            ...initialConfig,
            required: Array.from({ length: s.checks }, (_, i) => i + 1),
            maxBatch: s.batch,
            maxRuns: s.slots,
            maxAttempts: s.attempts
          }
          const word = (i: number) => s.tape[i % s.tape.length]!
          const initial = cohort(config, s.count, (i) => word(i) % 3)
          let state = initial
          const events: Event[] = []
          const bound = observe(config, initial).measure
          // A change fails one required check until it has received this many fixes.
          const fixesNeeded = (id: number) => word(id) % 3
          const withdrawn = word(0) % (s.count + 1)
          for (;;) {
            const before = observe(config, state)
            const start = nextStart(config, state)
            if (start !== undefined && before.failedIndex === -1) {
              const longest = before.prefixes.reduce((n, p, i) => p === undefined ? n : i + 1, 0)
              expect(before.pending).toBeLessThan(config.maxRuns)
              expect(start).toBeGreaterThan(longest)
              expect(start).toBeLessThanOrEqual(longest + Math.max(config.maxBatch, 1))
            }
            const choices: Event[] = []
            const decision = plan(config, state)
            if (decision) choices.push(decision)
            if (state.pushing !== null && state.runs.some((run) => run.id === state.pushing)) {
              const land: Event = { _tag: "land", run: state.pushing }
              if (step(config, state, land) !== state) choices.push(land)
            }
            for (const c of state.changes.filter((c) => c.status._tag === "fixing")) {
              choices.push(
                word(c.id + 1) % 4 === 0
                  ? { _tag: "gaveUp", id: c.id, attempt: c.attempts, detail: "redo" }
                  : { _tag: "fixed", id: c.id, attempt: c.attempts }
              )
            }
            for (const run of state.runs) {
              for (const check of config.required) {
                if (run.results.some((r) => r.check === check)) continue
                const red = run.batch.some((p) => p.rev < fixesNeeded(p.id) && check === 1 + p.id % s.checks)
                choices.push({
                  _tag: "result",
                  run: run.id,
                  check,
                  duration: word(events.length),
                  verdict: red ? "fail" : "pass"
                })
              }
            }
            const event = !events.length && withdrawn > 0 ?
              { _tag: "withdraw", id: withdrawn } as const
              : choices[word(events.length) % choices.length]
            if (!event) break
            const next = step(config, state, event)
            if (event._tag === "start") {
              const expected = before.ready.slice(0, event.count).map(({ id, rev }) => ({ id, rev }))
              expect(next.runs.at(-1)?.batch).toEqual(expected)
            }
            if (event._tag === "land") {
              const added = next.main.slice(state.main.length)
              const ids = new Set(added.map((p) => p.id))
              const expected = before.ready.filter((c) => ids.has(c.id)).map(({ id, rev }) => ({ id, rev }))
              expect(added).toEqual(expected)
              expect(next.landed.at(-1)).toMatchObject({ base: state.main, batch: expected, run: event.run })
            }
            const after = observe(config, next).measure
            expect(after, JSON.stringify(event)).toBeLessThan(before.measure)
            events.push(event)
            expect(events.length + after).toBeLessThanOrEqual(bound)
            state = next
          }
          expect(plan(config, state)).toBeUndefined()
          for (const c of state.changes) {
            const expected = c.id === withdrawn ?
              "withdrawn"
              : fixesNeeded(c.id) > config.maxAttempts || (fixesNeeded(c.id) > 0 && word(c.id + 1) % 4 === 0)
              ? "unmergeable" :
              "merged"
            expect(c.status._tag).toBe(expected)
            expect(state.main.some((p) => p.id === c.id && p.rev === c.rev)).toBe(expected === "merged")
          }
          const cut = word(0) % (events.length + 1)
          const replay = (from: State, history: Event[]) => history.reduce((s, e) => step(config, s, e), from)
          const restored: State = JSON.parse(JSON.stringify(replay(initial, events.slice(0, cut))))
          expect(replay(restored, events.slice(cut))).toEqual(state)
          return true
        }), { seed, executions: pureExecutions }))
    )
  })

  it("all failed runs refuse every landing, including direct attempts on a held run", async () => {
    checkReport(
      await Effect.runPromise(Fuzz.run(scenario, (s) =>
        Effect.gen(function*() {
          const config = { ...initialConfig, required: [1, 2], maxRuns: s.slots, maxBatch: s.batch }
          const initial = cohort(config, s.count, () => 0)
          const waiting = settle(config, observe(config, initial).measure, initial)
          expect(waiting.runs.length).toBeGreaterThan(0)
          const ref = yield* Ref.make(waiting)
          yield* Effect.forEach(waiting.runs, (r) =>
            Ref.update(
              ref,
              (state) =>
                step(config, state, { _tag: "result", run: r.id, check: 1 + r.id % 2, verdict: "fail", duration: 1 })
            ), { concurrency: "unbounded" })
          const red = yield* Ref.get(ref)
          for (const r of red.runs) {
            expect(r.results.some((result) => result.verdict === "fail")).toBe(true)
            expect(step(config, red, { _tag: "push", run: r.id })).toEqual(red)
            expect(step(config, red, { _tag: "land", run: r.id })).toEqual(red)
            expect(landNow(config, red, r.id)).toEqual(red)
          }
          expect(red.landed).toEqual([])
          return true
        }), { seed, executions: ioExecutions, execution: FuzzSimulation.execution() }))
    )
  })

  // A stronger claim than Order.lean's start_takes_the_first. The second
  // singleton probe can turn green before the first change has a CI result.
  it("independent green singleton probe lands without waiting on an earlier pending change (NeverBlocks.lean)", () => {
    const config = { ...initialConfig, required: [1], maxRuns: 3, maxBatch: 2 }
    let state = step(config, empty, { _tag: "enqueue", id: 1, priority: 0 })
    state = step(config, state, { _tag: "enqueue", id: 2, priority: 0 })
    // With three slots the normal policy starts [1,2], probes [1], then probes [2].
    state = settle(config, observe(config, state).measure, state)
    const second = state.runs.find((r) => r.batch.length === 1 && r.batch[0]?.id === 2)
    if (second) {
      state = step(config, state, { _tag: "result", run: second.id, check: 1, duration: 1, verdict: "pass" })
      const push = plan(config, state)
      if (push?._tag === "push") state = step(config, step(config, state, push), { _tag: "land", run: push.run })
    }
    // NeverBlocks.lean intentionally allows a live green singleton probe to land ahead of an earlier pending change.
    expect(state.main.map((p) => p.id)).toEqual([2])
  })

  it("green speculative prefix waves land equal-priority changes in strict arrival order", async () => {
    checkReport(
      await Effect.runPromise(Fuzz.run(scenario, (s) =>
        Effect.gen(function*() {
          const config = { ...initialConfig, required: [1], maxRuns: s.slots, maxBatch: s.batch }
          let state = cohort(config, s.count, () => 0)
          const fifo = state.changes.map((c) => c.id)
          for (let wave = 0; state.main.length < fifo.length; wave++) {
            expect(wave).toBeLessThan(s.count)
            state = settle(config, observe(config, state).measure, state)
            const runs = [...state.runs]
            if (s.tape[wave % s.tape.length]! % 2) runs.reverse()
            for (const r of runs) {
              state = step(config, state, { _tag: "result", run: r.id, check: 1, verdict: "pass", duration: 1 })
            }
            const push = plan(config, state)
            if (push?._tag !== "push") {
              throw new Error("green prefix wave did not push")
            }
            state = step(config, step(config, state, push), { _tag: "land", run: push.run })
            expect(state.landed.flatMap((l) => l.batch.map((p) => p.id))).toEqual(fifo.slice(0, state.main.length))
          }
          expect(state.main.map((p) => p.id)).toEqual(fifo)
          return true
        }), { seed, executions: pureExecutions }))
    )
  })
})
