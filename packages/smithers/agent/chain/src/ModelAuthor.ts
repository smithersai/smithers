/**
 * The model-backed author seat.
 *
 * The seat never calls a model itself. It asks the {@link Step} port to run
 * one model call as a durable step, and the host binds that port to its
 * durable engine (`ModelStep.run` from `@smthrs/agent`, one `@smthrs/flow`
 * action per call), which supplies the retries, the deadline and the sealed
 * record a resumed run replays. `@smthrs/chain` cannot depend on the engine,
 * so the port is the seam. {@link layerStepUnsealed} binds it straight to a
 * `Model.Model` for tests and replay models.
 *
 * The seat maps an author input onto the sealed
 * request shape of the harness's sealed steps: prefix as the stable system
 * part, context lines as one user message, no tools, `toolChoice: "none"`
 * (https://chain.smithers.sh/contract/). Prior art, copied rather than
 * imported: the sealed steps in
 * packages/smithers/agent/harness/src/CellTurn.ts.
 *
 * @since 0.1.0
 */

import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Context, Effect, Layer, Stream } from "effect"
import * as Author from "./Author.ts"
import { failureCode } from "./internal/failureCode.ts"

/**
 * Joins an assistant message's visible text parts — the one fold every
 * consumer of a settled message shares, so "what counts as visible text"
 * has exactly one definition.
 */
const visibleText = (message: ModelRequest.AssistantMessage): string =>
  message.content
    .filter((part): part is ModelRequest.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

/**
 * Which model the seat calls, and the generation parameters it calls with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Config {
  readonly modelId: string
  readonly params?: ModelRequest.GenerationParams | undefined
  /** The durable step's name, part of its key. Defaults to {@link defaultStepName}. */
  readonly stepName?: string | undefined
}

/**
 * The step name the seat's model calls run under when {@link Config.stepName}
 * is unset.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultStepName = "chain/author/model"

/**
 * One model call for the durable engine to run: the step's name and the
 * request. Both are stable for one author input, so an engine that keys a
 * step on them replays the recorded answer instead of calling the provider
 * again.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface StepCall {
  readonly name: string
  readonly request: ModelRequest.ModelRequest
}

/**
 * The port's one operation: run the call as one durable step and return the
 * provider's events in order. The binding owns retries and the deadline; it
 * fails only once its engine has given up, or with a refusal the engine
 * sealed.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface StepService {
  readonly run: (call: StepCall) => Effect.Effect<ReadonlyArray<ModelEvent.ModelEvent>, unknown>
}

/**
 * The durable model step port the author seat calls through.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Step extends Context.Service<Step, StepService>()("/chain/ModelAuthor/Step") {}

/**
 * Binds the port straight to the ambient `Model.Model`, with no engine
 * between them: one stream per call, no retry, nothing sealed. It is for
 * tests, for replay models, and for a host whose `Model.Model` is itself a
 * sealed step (`ModelStep.model` from `@smthrs/agent`). A production host
 * binds {@link Step} to its durable engine.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerStepUnsealed: Layer.Layer<Step, never, Model.Model> = Layer.effect(Step)(
  Effect.gen(function*() {
    const model = yield* Model.Model
    return Step.of({
      run: (call) => Effect.map(Stream.runCollect(model.stream(call.request)), (events) => Array.from(events))
    })
  })
)

/**
 * The pure mapping from an author input to the wire-neutral request — the
 * same function derives test fixtures, so a mapping drift breaks the
 * replay match loudly instead of silently changing the step key.
 *
 * The prefix is host-supplied. `Prompt.assemble` places a fixed rule before
 * the catalog and encodes repository descriptions as labelled, untrusted
 * data; this mapping preserves that boundary in the system part.
 *
 * Degenerate inputs collapse to wire-valid shapes: an empty prefix emits
 * no system part at all, and an empty context (reachable from any script
 * via a garbage author payload) becomes one placeholder line — providers
 * reject empty system blocks and empty user content outright.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const requestFor = (config: Config) => (input: Author.Input): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId: config.modelId,
    system: input.prefix === "" ? [] : [ModelRequest.SystemPart.make({ text: input.prefix })],
    messages: [
      ModelRequest.Message.user(
        (input.context.length === 0 ? ["(no context was provided)"] : input.context)
          .map((text) => ModelRequest.TextPart.make({ text }))
      )
    ],
    tools: [],
    toolChoice: "none",
    params: config.params ?? ModelRequest.GenerationParams.make()
  })

const unavailable = (message: string, cause: string): Author.AuthorError =>
  new Author.AuthorError({ cause, code: "author_unavailable", message })

// A route stack fails with tagged errors that often carry no code of their
// own, so the tag is the seat's last stable answer before "unknown".
const causeOf = (error: unknown): string => failureCode(error, ["code", "_tag"])

const describeFailure = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const record = error as { readonly _tag?: unknown; readonly code?: unknown; readonly message?: unknown }
    const parts = [record._tag, record.code, record.message].filter(
      (part): part is string => typeof part === "string"
    )
    if (parts.length > 0) return parts.join(": ")
  }
  return String(error)
}

/**
 * Builds the author seat over the ambient durable step port. The seat makes
 * one step call per author input and never retries it: a failure the step
 * reports is one its engine already gave up on.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (config: Config): Effect.Effect<Author.Service, never, Step> =>
  Effect.gen(function*() {
    const step = yield* Step
    const request = requestFor(config)
    const name = config.stepName ?? defaultStepName
    return Author.make({
      author: Effect.fn("ModelAuthor.author")((input) =>
        Effect.gen(function*() {
          const events = yield* step.run({ name, request: request(input) })
          const settled = ModelEvent.ModelEvent.settledMessage(events)
          // `settledMessage` folds an unsettled stream to stopReason
          // "aborted", so one guard covers interruption, truncation
          // ("length"), filtering, and provider errors alike — none of
          // them may pass as a complete authored output.
          if (settled.message.stopReason !== "stop") {
            return yield* unavailable(
              `the model stream settled with stopReason "${settled.message.stopReason}"`,
              settled.message.stopReason
            )
          }
          const text = visibleText(settled.message)
          if (text.trim() === "") {
            // A reasoning-only response is a seat failure, not an empty
            // authored script (the harness's sealed steps in
            // packages/smithers/agent/harness/src/CellTurn.ts fail the same way).
            return yield* unavailable("the model returned no visible text", "no_text")
          }
          return text
        }).pipe(
          Effect.mapError((error) =>
            error instanceof Author.AuthorError
              ? error
              : unavailable(describeFailure(error), causeOf(error))
          )
        )
      )
    })
  })

/**
 * The production author layer: `Author` from the durable {@link Step} port.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (config: Config): Layer.Layer<Author.Author, never, Step> =>
  Layer.effect(Author.Author)(make(config))
