/**
 * Which engine node a retry of a settled module run starts from. Ported from
 * the release-support flow's `retryStep`.
 *
 * @since 1.0.0
 */

import type * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type * as RunInspection from "@smthrs/engine-store/RunInspection"

/**
 * The node a retry of `inspection`'s run starts from: the action step `step`
 * names by action name or node id, or the step the run failed at when `step`
 * is absent. Only action steps that ran are candidates, because a step that
 * never ran has no record to retry from. A refusal names what to pass instead.
 *
 * @category constructors
 * @since 1.0.0
 */
export const select = (
  runId: string,
  inspection: RunInspection.Inspection,
  step: string | undefined
): ControlExecutor.RetryStep => {
  const ran = inspection.steps.filter((candidate) =>
    candidate.kind === "ActionCall" && candidate.action !== null && candidate.attempts.length > 0
  )
  const refused = (reason: string): ControlExecutor.RetryStep => ({ _tag: "Refused", reason: `run ${runId} ${reason}` })
  if (step === undefined) {
    // The run's own failed step, never `failure.nodeId`: that can name a node
    // of a child execution, which this run's record cannot retry from.
    const failures = ran.filter((candidate) => candidate.status === "failed")
    const failed = failures[failures.length - 1]?.nodeId
    return failed === undefined
      ? refused("has no failed step; name the step to retry from")
      : { _tag: "Step", nodeId: failed }
  }
  const named = ran.filter((candidate) => candidate.nodeId === step || candidate.action === step)
  if (named.length === 1) return { _tag: "Step", nodeId: named[0]!.nodeId }
  return named.length === 0
    ? refused(`ran no step ${step}; its steps are ${[...new Set(ran.map((candidate) => candidate.action))].join(", ")}`)
    : refused(`ran ${step} ${named.length} times; name one node: ${named.map((c) => c.nodeId).join(", ")}`)
}
