/**
 * Tests describe the queue as traces: the same lines the Lean reference reads.
 */

import type { Config, State } from "../../src/index.ts"
import { apply, empty, initialConfig, parseLine } from "../../src/index.ts"

/** The settings most tests use: two checks, two fix attempts, batches of two, two runs at once. */
export const standard = "config required=1,2 maxAttempts=2 maxBatch=2 maxRuns=2 window=3 defaultDuration=60"

/** Runs trace lines from an empty queue and returns where it ends. */
export const play = (...lines: ReadonlyArray<string>): { readonly config: Config; readonly state: State } => {
  let config = initialConfig
  let state = empty
  for (const text of lines) {
    const line = parseLine(text)
    if (line === undefined) throw new Error(`not a trace line: ${text}`)
    ;[config, state] = apply(config, state, line)
  }
  return { config, state }
}

/** The status tag of each change, by id. */
export const statuses = (state: State): Readonly<Record<number, string>> =>
  Object.fromEntries(state.changes.map((change) => [change.id, change.status._tag]))

/** The ids of the parts in the target's tree. */
export const mainIds = (state: State): ReadonlyArray<number> => state.main.map((entry) => entry.id)
