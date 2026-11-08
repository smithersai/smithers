/**
 * Parking a run the way an operator does, now that `pause` is gone.
 *
 * `Control.pause` used to be the one call that released a run's ownership
 * without settling it, and half the fence suites leaned on it to reach a
 * parked, unowned row. 1.0.0-rc.0 removes it (the release policy, "Attributed
 * pause"): it flipped the control row and parked no engine run, which is the
 * partial behavior the release scope forbids. The transition itself is not gone —
 * `ControlRuntime.writeStatus` performs it, and clears the owner for every
 * non-running status — so this is the same two lines the suites used to spell
 * with `pause`, in one place.
 */
import { Effect } from "effect"
import type { Service } from "../src/ControlRuntime.vibe"
import type { RunId, RunSummary } from "../src/ControlSchema.vibe"

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
