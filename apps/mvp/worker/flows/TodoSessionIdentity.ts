import { digestSync } from "@smthrs/crypto"
import { RUNNER_STEER_BOUNDARY } from "../../src/features/runs/contract.ts"

/**
 * The boundary a runner's confirmation of `ids` drains under, for job `key` (docs/features/runs.md#steering): the same
 * ids confirmed again replay the same drain, and the run page reads a promotion under `RUNNER_STEER_BOUNDARY` as
 * Delivered.
 */
export const boundaryOf = (key: string, ids: ReadonlyArray<string>): string =>
  `${RUNNER_STEER_BOUNDARY}${key}:${digestSync([...ids].sort().join("\n")).slice(0, 32)}`
