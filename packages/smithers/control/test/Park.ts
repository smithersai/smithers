/**
 * Parking a run at the runtime, without an executor.
 *
 * The fence suites need a parked, unowned row and no engine. `Control.pause`
 * parks the execution through `ControlExecutor.pause` first and fails
 * `Unavailable` without one, so it is the wrong tool here.
 * `ControlRuntime.writeStatus` performs the control transition alone, and
 * clears the owner for every non-running status.
 */
import { Effect } from "effect"
import type { Service } from "../src/ControlRuntime.ts"
import type { RunId, RunSummary } from "../src/ControlSchema.ts"

/**
 * Parks a run this process owns, releasing the fence it held.
 *
 * @param runtime the control runtime holding the run's fence
 * @param runId the run to park
 */
export const park = (
  runtime: Service,
  runId: RunId
): Effect.Effect<RunSummary, unknown> =>
  Effect.flatMap(
    runtime.claimFence(runId),
    (fence) => runtime.writeStatus(runId, fence, "parked")
  )
