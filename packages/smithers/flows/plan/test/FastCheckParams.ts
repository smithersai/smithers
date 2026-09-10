import { FastCheck } from "effect/testing"

/**
 * Shared FastCheck parameters for the plan property suites: `FC_NUM_RUNS` and
 * `FC_SEED` override the per-suite defaults, and an interrupt past the time
 * limit fails the run instead of shrinking it away.
 */
export const params = (
  defaultRuns: number,
  defaultSeed?: number
): {
  readonly numRuns: number
  readonly seed?: number
  readonly interruptAfterTimeLimit: number
  readonly markInterruptAsFailure: boolean
} => ({
  numRuns: Number(process.env.FC_NUM_RUNS ?? defaultRuns),
  ...(process.env.FC_SEED === undefined
    ? defaultSeed === undefined ? {} : { seed: defaultSeed }
    : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>)
