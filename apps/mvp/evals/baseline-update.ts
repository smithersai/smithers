import type { Runner } from "@smthrs/evals"

/** Whether the run is eligible to replace the complete committed baseline. */
export const canUpdateBaseline = (
  failed: number,
  unsafe: number,
  unscored: number,
  selected: number,
  total: number,
): boolean => failed === 0 && unsafe === 0 && unscored === 0 && selected > 0 && selected === total

/**
 * Each case and scorer of `run` that measured nothing: a scorer that failed, such as a judge that couldn't be reached,
 * leaves its case run but unscored, and a baseline written from it would drop that score unseen.
 */
export const unscored = (run: Runner.RunResult): ReadonlyArray<string> =>
  run.observations.filter((observation) => observation.kind !== "score").map((observation) =>
    `${observation.case}/${observation.scorerName ?? observation.scorer}`
  )
