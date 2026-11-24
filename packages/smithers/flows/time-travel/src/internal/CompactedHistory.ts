/**
 * The refusal time travel raises when an operation needs journal history that
 * compaction already deleted.
 *
 * @since 1.0.0
 */

import { error, type TimeTravelError } from "../TimeTravelError.ts"

/**
 * A `not_found` refusal for history below a run's compaction floor.
 *
 * The records under the floor no longer exist, so a frame there is not a
 * point the run can be read from or truncated back to. The floor travels in
 * the cause as `checkpointSeq`, the same field the journal's `compacted`
 * error carries, so a caller can resync from that checkpoint.
 *
 * @since 1.0.0
 * @category constructors
 */
export const refusal = (runId: string, checkpointSeq: number, cause?: unknown): TimeTravelError =>
  error(
    "not_found",
    `run ${runId} is compacted through sequence ${checkpointSeq}; history below that checkpoint no longer exists`,
    { checkpointSeq, ...(cause === undefined ? {} : { cause }) }
  )
