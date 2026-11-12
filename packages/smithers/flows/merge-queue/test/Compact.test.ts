import { describe, expect, it } from "vitest"
import type { Config, Event, State } from "../src/index.ts"
import {
  Driver,
  empty,
  fresh,
  initialConfig,
  isTerminal,
  parseLine,
  plan,
  pruned,
  run,
  runPruned,
  settle,
  settlePruned,
  step
} from "../src/index.ts"
import { trace } from "./support/Generate.ts"

const config: Config = { required: [1], maxAttempts: 1, maxBatch: 2, maxRuns: 2, window: 3, defaultDuration: 10 }

/** A queue in which change 1 merged, 2 is unmergeable, 3 was withdrawn, 4 is being fixed and 5 waits. */
const mixed: State = run(config, empty, [
  { _tag: "enqueue", id: 1, priority: 0 },
  { _tag: "start", count: 1 },
  { _tag: "result", run: 0, check: 1, verdict: "pass", duration: 5 },
  { _tag: "push", run: 0 },
  { _tag: "land", run: 0 },
  { _tag: "enqueue", id: 2, priority: 0 },
  { _tag: "start", count: 1 },
  { _tag: "result", run: 1, check: 1, verdict: "fail", duration: 5 },
  { _tag: "blame", run: 1 },
  { _tag: "gaveUp", id: 2, attempt: 1, detail: "redo it" },
  { _tag: "enqueue", id: 3, priority: 0 },
  { _tag: "withdraw", id: 3 },
  { _tag: "enqueue", id: 4, priority: 0 },
  { _tag: "start", count: 1 },
  { _tag: "result", run: 2, check: 1, verdict: "fail", duration: 5 },
  { _tag: "blame", run: 2 },
  { _tag: "enqueue", id: 5, priority: 0 }
])

describe("what the queue keeps", () => {
  it("is the state without the changes that ended and without the landings, and nothing else changes", () => {
    expect(mixed.changes.map((change) => [change.id, change.status._tag])).toEqual([
      [1, "merged"],
      [2, "unmergeable"],
      [3, "withdrawn"],
      [4, "fixing"],
      [5, "queued"]
    ])
    expect(mixed.landed).toHaveLength(1)
    const kept = pruned(mixed)
    expect(kept).toEqual({ ...mixed, changes: mixed.changes.slice(3), landed: [] })
    expect(pruned(kept)).toEqual(kept)
    expect(pruned(empty)).toEqual(empty)
  })

  it("an id is never used again: only handing in an ended id is refused by the rule", () => {
    const events: ReadonlyArray<readonly [Event, boolean]> = [
      [{ _tag: "enqueue", id: 1, priority: 0 }, false],
      [{ _tag: "enqueue", id: 2, priority: 3 }, false],
      [{ _tag: "foreign", id: 3 }, false],
      // A change the queue still holds is refused by the kernel itself, pruned or not.
      [{ _tag: "enqueue", id: 4, priority: 0 }, true],
      [{ _tag: "foreign", id: 5 }, true],
      [{ _tag: "enqueue", id: 6, priority: 0 }, true],
      [{ _tag: "foreign", id: 7 }, true],
      // Every other event may name an ended change: it changes nothing either way.
      [{ _tag: "withdraw", id: 1 }, true],
      [{ _tag: "fixed", id: 2, attempt: 1 }, true],
      [{ _tag: "gaveUp", id: 2, attempt: 1, detail: "again" }, true],
      [{ _tag: "probe", id: 3 }, true]
    ]
    for (const [event, allowed] of events) expect(fresh(mixed, event), JSON.stringify(event)).toBe(allowed)
  })

  it("an ended id handed in again is the one place the pruned queue differs, which is why the rule exists", () => {
    const again: Event = { _tag: "enqueue", id: 3, priority: 0 }
    expect(fresh(mixed, again)).toBe(false)
    expect(step(config, mixed, again)).toBe(mixed)
    expect(step(config, pruned(mixed), again).changes.map((change) => change.id)).toEqual([4, 5, 3])
  })

  it(
    "random traces: the queue that keeps the pruned state decides what the queue that keeps everything decides",
    () => {
      let compared = 0
      let ended = 0
      let refused = 0
      for (let seed = 1; seed <= 150; seed++) {
        let settings = initialConfig
        let full = empty
        let kept = empty
        for (const text of trace(seed, 120)) {
          const line = parseLine(text)
          if (line === undefined) continue
          if (line._tag === "config") {
            settings = line.config
            full = empty
            kept = empty
            continue
          }
          // The next decision is the same.
          expect(plan(settings, kept), `seed ${seed}: ${text}`).toEqual(plan(settings, full))
          const event = line._tag === "plan" ? plan(settings, full) : line.event
          if (event === undefined) continue
          if (!fresh(full, event)) {
            refused += 1
            continue
          }
          const next = step(settings, full, event)
          const stepped = step(settings, kept, event)
          // The same changes end, with the same reasons and landings.
          const endings = Driver.ended(full, next)
          expect(Driver.ended(kept, stepped), `seed ${seed}: ${text}`).toEqual(endings)
          ended += endings.length
          full = next
          kept = pruned(stepped)
          // What is kept is exactly the pruning of everything, so the two never drift.
          expect(kept, `seed ${seed}: ${text}`).toEqual(pruned(full))
          // The world is told to do the same: the push, the CI jobs, the fix briefs.
          expect(Driver.commands(settings, kept), `seed ${seed}: ${text}`).toEqual(Driver.commands(settings, full))
          expect(Driver.drained(kept), `seed ${seed}: ${text}`).toBe(Driver.drained(full))
          compared += 1
        }
        expect(kept.changes.every((change) => !isTerminal(change.status))).toBe(true)
        expect(kept.landed).toEqual([])
      }
      // The traces did end changes and did try to reuse ended ids, so the comparison was not vacuous.
      expect(compared).toBeGreaterThan(8_000)
      expect(ended).toBeGreaterThan(400)
      expect(refused).toBeGreaterThan(20)
    },
    240_000
  )

  it(
    "random rounds: folding events and settling on the pruned queue is the pruning of the same round on the full queue",
    () => {
      let rounds = 0
      let ended = 0
      for (let seed = 1; seed <= 150; seed++) {
        let settings = initialConfig
        let full = empty
        let kept = empty
        let events: Array<Event> = []
        // The full queue's state as the events of the round under construction arrive, to apply the rule.
        let arriving = empty
        const close = (context: string): void => {
          const fuel = 1 + (seed % 7)
          const next = settle(settings, fuel, run(settings, full, events))
          const seen: Array<readonly [State, State]> = []
          const folded = runPruned(settings, kept, events, (before, after) => void seen.push([before, after]))
          expect(folded, context).toEqual(pruned(run(settings, full, events)))
          expect(seen, context).toHaveLength(events.length)
          expect(settlePruned(settings, fuel, folded), context).toEqual(pruned(next))
          // The driver's round: the same state, and the same changes ended.
          const settled = settle(settings, Driver.settleFuel, run(settings, full, events))
          const advanced = Driver.advance(settings, kept, events)
          expect(advanced.state, context).toEqual(pruned(settled))
          const byId = (left: { readonly id: number }, right: { readonly id: number }): number => left.id - right.id
          const expected = [...Driver.ended(full, settled)].sort(byId)
          expect([...advanced.ended].sort(byId), context).toEqual(expected)
          ended += expected.length
          rounds += 1
          full = settled
          kept = advanced.state
          arriving = full
          events = []
        }
        for (const text of trace(seed, 160)) {
          const line = parseLine(text)
          if (line === undefined) continue
          if (line._tag === "config") {
            settings = line.config
            full = empty
            kept = empty
            arriving = empty
            events = []
            continue
          }
          if (line._tag === "plan") {
            close(`seed ${seed}, round ${rounds}`)
            continue
          }
          if (!fresh(arriving, line.event)) continue
          events.push(line.event)
          arriving = step(settings, arriving, line.event)
        }
      }
      expect(rounds).toBeGreaterThan(2_500)
      expect(ended).toBeGreaterThan(500)
    },
    240_000
  )
})
