/**
 * Random traces for the differential tests.
 *
 * A trace is generated against this package's own kernel, so most events are
 * ones the queue is ready for (a result for a run that exists, a fix answer
 * for the right attempt), mixed with late, duplicate, stale and malformed
 * ones. The same seed always gives the same trace.
 */

import type { Config, State } from "../../src/Kernel.ts"
import { empty, initialConfig, parseLine, plan, step } from "../../src/Kernel.ts"

/** A small seeded generator (mulberry32). */
export const random = (seed: number): () => number => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const below = (next: () => number, bound: number): number => Math.floor(next() * bound)

const pick = <A>(next: () => number, items: ReadonlyArray<A>): A | undefined => items[below(next, items.length)]

const configLine = (next: () => number): string => {
  const required = [1, 2, 3, 4].filter(() => next() < 0.6)
  return [
    "config",
    `required=${required.join(",")}`,
    `maxAttempts=${below(next, 4)}`,
    `maxBatch=${below(next, 5)}`,
    `maxRuns=${below(next, 5)}`,
    `window=${below(next, 4)}`,
    `defaultDuration=${below(next, 100)}`
  ].join(" ")
}

const malformed = ["", "bogus", "enqueue 1", "enqueue x 2", "result 0 1 maybe 3", "land", "plan now", "start -1"]

const eventLine = (next: () => number, config: Config, state: State): string => {
  const roll = next()
  const change = pick(next, state.changes)
  const run = pick(next, state.runs)
  const check = next() < 0.9 ? pick(next, config.required) ?? below(next, 6) : below(next, 6)
  if (roll < 0.3) return "plan"
  if (roll < 0.34) return state.pushing !== null ? `land ${state.pushing}` : "plan"
  if (roll < 0.46) return `enqueue ${next() < 0.9 ? state.changes.length + 1 : below(next, 6)} ${below(next, 3)}`
  if (roll < 0.74) {
    const verdict = next() < 0.8 ? "pass" : "fail"
    return `result ${next() < 0.95 && run !== undefined ? run.id : below(next, 8)} ${check} ${verdict} ${
      below(next, 90)
    }`
  }
  if (roll < 0.82) {
    const attempt = change !== undefined && next() < 0.85 ? change.attempts : below(next, 4)
    return `fixed ${change?.id ?? below(next, 6)} ${attempt}`
  }
  if (roll < 0.85) {
    const attempt = change !== undefined && next() < 0.85 ? change.attempts : below(next, 4)
    return `gaveup ${change?.id ?? below(next, 6)} ${attempt}${next() < 0.8 ? " needs a rewrite" : ""}`
  }
  if (roll < 0.88) return `withdraw ${change?.id ?? below(next, 6)}`
  if (roll < 0.9) return `start ${below(next, 5)}`
  if (roll < 0.91) return `foreign ${next() < 0.8 ? 100 + state.changes.length : below(next, 6)}`
  if (roll < 0.925) return `push ${run?.id ?? below(next, 8)}`
  if (roll < 0.94) return `land ${next() < 0.85 && state.pushing !== null ? state.pushing : run?.id ?? below(next, 8)}`
  if (roll < 0.96) return `blame ${run?.id ?? below(next, 8)}`
  if (roll < 0.98) return `cancel ${run?.id ?? below(next, 8)}`
  return pick(next, malformed)!
}

/** One trace: a config line followed by `length` event lines. */
export const trace = (seed: number, length: number): ReadonlyArray<string> => {
  const next = random(seed)
  const first = configLine(next)
  const parsed = parseLine(first)
  let config = parsed?._tag === "config" ? parsed.config : initialConfig
  let state = empty
  const lines = [first]
  for (let index = 0; index < length; index++) {
    const text = eventLine(next, config, state)
    lines.push(text)
    const line = parseLine(text)
    if (line?._tag === "event") state = step(config, state, line.event)
    if (line?._tag === "plan") {
      const planned = plan(config, state)
      if (planned !== undefined) state = step(config, state, planned)
    }
    if (line?._tag === "config") {
      config = line.config
      state = empty
    }
  }
  return lines
}
