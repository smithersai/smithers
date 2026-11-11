import { describe, expect, it } from "vitest"
import type { Config, Event, State } from "../src/index.ts"
import { empty, initialConfig, isTerminal, parseLine, pending, plan, ready, settle, step } from "../src/index.ts"
import { trace } from "./support/Generate.ts"
import { violation } from "./support/Invariant.ts"

/**
 * The theorems of the Lean reference, checked on the states this package's
 * kernel produces over random traces. Each `it` names the theorem it mirrors.
 */

interface Step {
  readonly seed: number
  readonly config: Config
  readonly before: State
  readonly event: Event
  readonly after: State
}

/** Every event of every trace, with the state before and after it. */
const steps = (seeds: number, length: number): ReadonlyArray<Step> => {
  const out: Array<Step> = []
  for (let seed = 1; seed <= seeds; seed++) {
    let config = initialConfig
    let state = empty
    for (const text of trace(seed, length)) {
      const line = parseLine(text)
      if (line === undefined) continue
      if (line._tag === "config") {
        config = line.config
        state = empty
        continue
      }
      const event = line._tag === "plan" ? plan(config, state) : line.event
      if (event === undefined) continue
      const after = step(config, state, event)
      out.push({ seed, config, before: state, event, after })
      state = after
    }
  }
  return out
}

const all = steps(250, 150)

const same = (left: State, right: State): boolean => JSON.stringify(left) === JSON.stringify(right)

describe("the reference's theorems hold on the kernel", () => {
  it("covers landings, blames, fixes, verdicts and cancels", () => {
    const tags = new Set(all.filter((entry) => !same(entry.before, entry.after)).map((entry) => entry.event._tag))
    expect([...tags].sort()).toEqual(
      ["blame", "cancel", "enqueue", "fixed", "gaveUp", "land", "result", "start", "withdraw"]
    )
    expect(all.length).toBeGreaterThan(20_000)
  })

  it("Inv.step: every state satisfies the invariant", () => {
    const broken = all.flatMap((entry) => {
      const field = violation(entry.config, entry.after)
      return field === undefined ? [] : [`seed ${entry.seed}: ${field}`]
    })
    expect(broken).toEqual([])
  })

  it("main_moves_only_by_land, main_only_grows: only a landing moves the target, and only by appending", () => {
    for (const entry of all) {
      if (entry.event._tag !== "land") expect(entry.after.main).toEqual(entry.before.main)
      expect(entry.after.main.slice(0, entry.before.main.length)).toEqual(entry.before.main)
    }
  })

  it("step_idempotent: delivering any event twice is delivering it once", () => {
    for (const entry of all) {
      expect(same(step(entry.config, entry.after, entry.event), entry.after)).toBe(true)
    }
  })

  it("ended_is_final, never_lost: an ended change never changes and no change disappears", () => {
    for (const entry of all) {
      for (const [index, change] of entry.before.changes.entries()) {
        const later = entry.after.changes[index]!
        expect([later.id, later.seq, later.priority]).toEqual([change.id, change.seq, change.priority])
        if (isTerminal(change.status)) expect(later).toEqual(change)
      }
    }
  })

  it("plan_takes_effect: every decision the policy makes changes the state", () => {
    for (const entry of all) {
      const event = plan(entry.config, entry.after)
      if (event !== undefined) expect(same(step(entry.config, entry.after, event), entry.after)).toBe(false)
    }
  })

  it("no_deadlock: with checks and a run slot, an idle queue with ready changes is waiting on a pending run", () => {
    for (const entry of all) {
      const { config, after } = entry
      if (config.required.length === 0 || config.maxRuns === 0) continue
      if (plan(config, after) === undefined && ready(after).length > 0) {
        expect(after.runs.some((run) => pending(config, run))).toBe(true)
      }
    }
  })

  it("the policy settles: it never decides forever without the world", () => {
    for (const entry of all) {
      const settled = settle(entry.config, 200, entry.after)
      expect(plan(entry.config, settled)).toBeUndefined()
    }
  })
})
