/** Finalization uses the existing guest publication route and native receipt. */
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer } from "effect"
import { StackPublication, StackPublicationInput } from "./landing-schema.ts"
import { Landing } from "./landing.ts"
import { NativeCoding, NativeCodingError, requestIdFor, SourcePublication } from "./native.ts"
import { CodingError } from "./schema.ts"
import { PublicationInput } from "./vibe-schema.ts"
export { PublicationInput } from "./vibe-schema.ts"

const RetainSource = Action.make("coding/publish-vibe-source", {
  payload: PublicationInput,
  success: SourcePublication,
  error: CodingError,
  nondeterministic: true
})

/** A native child receipt gives the same recursive debugger an exact source. */
export const PublishVibeSource = Flow.make("coding/PublishVibeSource", {
  payload: PublicationInput,
  success: SourcePublication,
  error: CodingError,
  body: Node.capture({}, (input) => RetainSource.call(input))
})

export const publicationLayers = Layer.mergeAll(
  Interpreter.layer(PublishVibeSource),
  RetainSource.toLayer(({ source, phase }) =>
    Effect.gen(function*() {
      const native = yield* NativeCoding
      if (native.sourcePublication !== "cloud") {
        return yield* new CodingError({
          code: "unavailable",
          message: "This workspace has local-only source capability; cloud finalization is unavailable"
        })
      }
      const instance = yield* FlowRuntime.FlowInstance
      // The original may no longer be the local head. The existing helper checks
      // its exact remote ACK first; an absent pin plus a moved source refuses.
      return yield* native.publishOriginalSource({
        requestId: requestIdFor(instance.executionId, `vibe-source/${phase}`),
        source: { ...source, kind: "resolved" }
      })
    }).pipe(Effect.mapError((error) =>
      error instanceof CodingError ? error : error instanceof NativeCodingError && error.code === "revision_conflict"
        ? new CodingError({
          code: "stale_revision",
          message:
            `The ${phase} source was not retained before it changed; this finalization cannot use a newer source in its place`
        })
        : new CodingError({
          code: "unavailable",
          message: "Exact source retention could not be acknowledged; finalization cannot continue"
        })
    ))
  )
)

const PublishStackAction = Action.make("coding/publish-stack", {
  payload: StackPublicationInput,
  success: StackPublication,
  error: CodingError,
  nondeterministic: true
})

/**
 * Publish a rewritten stack's tip to a branch under a lease on its expected old
 * head, and confirm the remote carries every Change at its rewritten commit.
 * The journaled receipt is the confirmation; a replay after a lost reply
 * confirms the already-published tip without pushing again.
 */
export const PublishStack = Flow.make("coding/PublishStack", {
  payload: StackPublicationInput,
  success: StackPublication,
  error: CodingError,
  body: Node.capture({}, (input) => PublishStackAction.call(input))
})

export const stackPublicationLayers = Layer.mergeAll(
  Interpreter.layer(PublishStack),
  PublishStackAction.toLayer((input) =>
    Effect.flatMap(Landing, (landing) =>
      landing.kind === "backend"
        ? Effect.fail(
          new CodingError({
            code: "unavailable",
            message: "This host lands through the backend; stack publication needs a local lander's repository"
          })
        )
        : landing.publishStack(input))
  )
)
