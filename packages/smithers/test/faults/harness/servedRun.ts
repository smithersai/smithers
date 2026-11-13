/**
 * A run on a served control plane, planned and launched over the wire.
 *
 * Planning and launching use RPC; a separate local operator process approves
 * against the same workspace. Bearer authentication is not approval authority.
 *
 * @since 1.0.0
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import { localDecision } from "./serveProcess.ts"

/**
 * Plans, approves, and launches `system/test`, returning the run id.
 *
 * @since 1.0.0
 * @category constructors
 */
export const launchRun = (
  label: string,
  root: string,
  flowId = "system/test",
  input: Record<string, string> = { case: label }
) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const card = yield* control.plan({ flowId, input })
    const decision = yield* Effect.promise(() => localDecision(root, "approve", card.approval))
    if (decision.status !== 0) return yield* Effect.die(new Error(`local approval failed: ${decision.stderr}`))
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${card.planId}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
      return yield* Effect.die(new Error(`expected an accepted run, got ${receipt._tag}`))
    }
    return { runId: receipt.runId, card }
  })

/**
 * Delivers `count` signals to `runId`, one journal event each.
 *
 * @since 1.0.0
 * @category constructors
 */
export const emitSignals = (
  runId: string,
  count: number,
  prefix = "tick",
  options: { readonly concurrency?: number; readonly onAdmitted?: (count: number) => void } = {}
) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    let admitted = 0
    yield* Effect.forEach(Array.from({ length: count }, (_, index) => index), (index) =>
      Effect.gen(function*() {
        const receipt = yield* control.signal({
          runId,
          signal: { name: prefix, payload: { index } } as never,
          idempotencyKey: `${prefix}:${runId}:${index}`
        })
        if (receipt._tag !== "Accepted" && receipt._tag !== "AlreadyApplied") {
          return yield* Effect.die(new Error(`Signal ${index} was not admitted: ${receipt._tag}`))
        }
        admitted += 1
        if (options.onAdmitted !== undefined) yield* Effect.sync(() => options.onAdmitted!(admitted))
      }), { concurrency: options.concurrency ?? 1, discard: true })
  })
