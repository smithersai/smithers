/**
 * Reads a stored release run for its host: which step a retry starts from, and
 * how long each step took.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as RunInspection from "@smthrs/engine-store/RunInspection"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect, Layer } from "effect"
import { ReleaseError } from "./schema.vibe"

/** The stores of one run database and the run reads over them, without an engine. */
export const readLayer = (filename: string, root: string) =>
  RunInspection.layer.pipe(
    Layer.provideMerge(NodeRuntime.storage(filename, root)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
  )

/** The run, its steps and their attempts as the engine recorded them. */
export const inspect = (runId: string) =>
  Effect.flatMap(RunInspection.RunInspection, (inspection) => inspection.inspect(runId))

/** One step of a run: the action it dispatched, how it ended and how long its attempts ran. */
export interface StepTiming {
  readonly step: string
  readonly nodeId: string
  readonly status: RunInspection.Step["status"]
  readonly attempts: number
  /** When the first attempt started; null for a step that never ran. */
  readonly startedAt: string | null
  /** The time its attempts ran, added up; null for a step that never ran or has an open attempt. */
  readonly durationMs: number | null
}

/** Every action step of a run, in the order the plan scheduled them. */
export const stepTimings = (inspection: RunInspection.Inspection): ReadonlyArray<StepTiming> =>
  inspection.steps.flatMap((step) => {
    if (step.kind !== "ActionCall" || step.action === null) return []
    const first = step.attempts[0]
    const open = step.attempts.some((attempt) => attempt.finishedAtMs === null)
    return [{
      step: step.action,
      nodeId: step.nodeId,
      status: step.status,
      attempts: step.attempts.length,
      startedAt: first === undefined ? null : new Date(first.startedAtMs).toISOString(),
      durationMs: first === undefined || open
        ? null
        : step.attempts.reduce((total, attempt) => total + (attempt.finishedAtMs! - attempt.startedAtMs), 0)
    }]
  })

/**
 * The node a retry of this run starts from: the step `from` names by action or
 * node id, or the step the run failed at when `from` is absent.
 */
export const retryStep = (
  inspection: RunInspection.Inspection,
  from: string | undefined
): Effect.Effect<string, ReleaseError> => {
  const steps = stepTimings(inspection).filter((step) => step.attempts > 0)
  const refuse = (message: string) =>
    Effect.fail(new ReleaseError({ step: "retry", message: `Run ${inspection.run.runId}: ${message}` }))
  if (from === undefined) {
    const failed = inspection.run.failure?.nodeId ?? steps.findLast((step) => step.status === "failed")?.nodeId
    return failed === undefined ? refuse("no failed step to retry from; name one with --from") : Effect.succeed(failed)
  }
  const named = steps.filter((step) => step.nodeId === from || step.step === from)
  if (named.length === 1) return Effect.succeed(named[0]!.nodeId)
  const choices = (named.length === 0 ? steps.map((step) => step.step) : named.map((step) => step.nodeId)).join(", ")
  return refuse(
    named.length === 0
      ? `no step ${from} that ran; its steps are ${choices}`
      : `${from} ran ${named.length} times; name one node: ${choices}`
  )
}
