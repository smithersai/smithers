/**
 * The invariant the Lean reference proves for every reachable state
 * (`lean/MergeQueue/Invariant.lean`, `Inv`), checked here on the states this
 * package's kernel produces. Returns the name of the first field that fails.
 */

import type { Config, State } from "../../src/Kernel.ts"
import { green, pendingCount, tree } from "../../src/Kernel.ts"

const unique = (values: ReadonlyArray<number>): boolean => new Set(values).size === values.length

const sameParts = (
  left: ReadonlyArray<{ id: number; rev: number }>,
  right: ReadonlyArray<{ id: number; rev: number }>
) =>
  left.length === right.length &&
  left.every((entry, index) => entry.id === right[index]!.id && entry.rev === right[index]!.rev)

/** The first violated field of the invariant, or `undefined` when it holds. */
export const violation = (config: Config, state: State): string | undefined => {
  if (!unique(state.changes.map((change) => change.id))) return "changeIds"
  if (!state.changes.every((change) => change.seq < state.nextSeq)) return "seqs"
  if (!unique(state.runs.map((run) => run.id))) return "runIds"
  if (!state.runs.every((run) => run.id < state.nextRun)) return "runFresh"
  if (!state.runs.every((run) => unique(tree(run).map((entry) => entry.id)))) return "runTrees"
  if (!state.runs.every((run) => run.results.every((result) => config.required.includes(result.check)))) {
    return "resultsRequired"
  }
  if (!state.runs.every((run) => unique(run.results.map((result) => result.check)))) return "resultsUnique"
  if (!unique(state.main.map((entry) => entry.id))) return "mainNodup"
  const merged = state.changes.filter((change) => change.status._tag === "merged")
  if (!state.main.every((entry) => merged.some((change) => change.id === entry.id && change.rev === entry.rev))) {
    return "mainMerged"
  }
  if (!merged.every((change) => state.main.some((entry) => entry.id === change.id && entry.rev === change.rev))) {
    return "mergedMain"
  }
  if (!state.changes.every((change) => change.attempts <= config.maxAttempts)) return "attempts"
  if (
    !state.changes.every((change) => change.status._tag !== "unmergeable" || change.status.reason.detail !== "")
  ) return "reasons"
  let end: ReadonlyArray<{ id: number; rev: number }> = []
  for (const landing of state.landed) {
    if (!sameParts(landing.base, end)) return "chain"
    end = [...landing.base, ...landing.batch]
  }
  if (!sameParts(state.main, end)) return "chain"
  if (
    !state.landed.every((landing) => landing.batch.length > 0 && (landing.foreign || green(config, landing.results)))
  ) {
    return "landings"
  }
  if (pendingCount(config, state) > config.maxRuns) return "pending"
  const counts = new Map<number, number>()
  for (const sample of state.history) counts.set(sample.check, (counts.get(sample.check) ?? 0) + 1)
  if ([...counts.values()].some((count) => count > config.window)) return "historyBounded"
  return undefined
}
