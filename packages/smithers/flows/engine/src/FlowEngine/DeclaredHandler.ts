import { Deadline, Flow, FlowRuntime } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { renderDiagnostic } from "../internal/Diagnostic.ts"
import { resetActionContext } from "./Dispatch.ts"
import type { Encoded } from "./Encoded.ts"
import { CurrentRegistrations } from "./RegistrationGate.ts"

type Handler = Parameters<Encoded["register"]>[1]

/**
 * Fails with a body error the flow declares, and dies with any other. The
 * defect is the error itself, not the schema issue about it, so the message
 * survives; and a defect, unlike an undeclared failure, can be encoded into
 * the settled run. `FlowProxyServer` redacts it before it leaves the process.
 */
const failDeclared = (flow: Flow.Any, error: unknown) =>
  Effect.matchEffect(flow.errorSchema.makeEffect(error), {
    onFailure: () =>
      Effect.logError("A flow body failed with an error outside its declared error schema").pipe(
        Effect.annotateLogs({ flow: flow._tag, error: renderDiagnostic(error) }),
        Effect.andThen(Effect.die(error))
      ),
    onSuccess: () => Effect.fail(error)
  })

/** Checks a round's success against the declared schema. A handoff round has none of its own. */
const succeedDeclared = (flow: Flow.Any, value: unknown) =>
  Effect.flatMap(FlowRuntime.FlowInstance, (instance) =>
    instance.handoff === undefined
      ? Effect.as(Effect.orDie(flow.successSchema.makeEffect(value)), value)
      : Effect.succeed(value))

/**
 * Wraps a registered body for the driver: bounded by the flow's deadline,
 * held to its declared schemas and capability ceilings, and run with the
 * registration's services under the caller's, in a fresh dispatch context.
 * @private
 */
export const declaredHandler = (
  flow: Flow.Any,
  services: Context.Context<FlowRuntime.FlowRuntime>,
  execute: (payload: object, executionId: string) => Effect.Effect<unknown, unknown, unknown>
): Handler => {
  const bounded = Deadline.bound({ flowName: flow._tag, deadline: flow.deadline })
  return (payload, executionId) =>
    Effect.suspend(() => bounded(execute(payload, executionId))).pipe(
      // Schema validation must retain cause annotations: dispatch recorded the
      // failing node, action and actual attempt before it reached this boundary.
      Effect.catchCause((cause) =>
        Effect.forEach(cause.reasons, (reason) =>
          Cause.isFailReason(reason)
            ? failDeclared(flow, reason.error).pipe(Effect.catchCause((checked) =>
              Effect.succeed(checked.reasons.map((validated) => validated.annotate(Cause.reasonAnnotations(reason))))
            ))
            : Effect.succeed([reason])).pipe(Effect.flatMap((reasons) =>
              Effect.failCause(Cause.fromReasons(reasons.flat()))
            ))
      ),
      Effect.flatMap((value) =>
        succeedDeclared(flow, value)
      ),
      Flow.attenuateCapabilities(Flow.capabilityCeilings(flow.annotations)),
      Effect.updateContext((input) => {
        const caller = input.pipe(Context.omit(CurrentRegistrations))
        return resetActionContext(Context.merge(services, caller)) as Context.Context<any>
      })
    )
}
