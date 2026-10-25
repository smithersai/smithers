/**
 * One model call as a durable, sealed flow step.
 *
 * `ModelStep.run` is the way a flow calls a model. It runs inside a flow body,
 * dispatches the call as one `@smthrs/flow` action, and records the provider's
 * whole answer as that action's value. A resumed execution replays the record
 * instead of calling the provider again.
 *
 * - **Key.** The action's idempotency key digests the credential-free prepared
 *   request (route, protocol, URL, public headers and canonical body bytes)
 *   together with the encoded `ModelRequest`. Credentials are applied after
 *   preparation and never enter it. Without a declared cache environment the
 *   engine scopes the key to the execution, so another execution with the same
 *   request calls the provider itself.
 * - **Retries.** `retryPolicy` is the one place that decides them: the step
 *   makes one HTTP request per attempt, and neither it nor the route's
 *   `RequestExecutor` retries inside one. A failure
 *   another attempt may clear (a dropped connection, a body that ends without
 *   a settlement, `transport`, `provider_internal`, `rate_limited`,
 *   `quota_exceeded`, or HTTP 429, 503, 504 or 529) fails the attempt without
 *   sealing it, and the policy waits the provider's `Retry-After` when it named
 *   one. A refusal no wait can clear (`ModelError.isTerminalRefusal`: an HTTP
 *   402, or a quota that names no reset and no model scope) is sealed on its
 *   first attempt: asking again would spend five more calls on the same
 *   refusal. Every other provider error is sealed as a typed value in
 *   {@link Result.error}.
 * - **Liveness.** Each attempt, each streamed event and each chunk of bytes
 *   the provider sends, a keep-alive included, is a heartbeat. An attempt
 *   silent for `heartbeatTimeoutMs` fails, and `retryPolicy` decides whether
 *   another runs. An attempt that runs past `callTimeoutMs` is cut off and
 *   sealed as a `call_timeout` error. Both default by the request's reasoning
 *   effort, so a model that thinks longer gets longer.
 * - **Streaming.** `onEvent` receives each provider event while the call runs.
 *   A replay hands it the recorded events, without calling the provider.
 *
 * Delivery is at least once. A process that dies, or a fiber cut off, after
 * the provider accepted a call but before the step sealed its answer leaves
 * nothing durable to say how the call ended, so the resumed execution calls
 * the provider again. The `agent_model_step_redispatches` counter counts each
 * such repeat.
 *
 * @since 1.0.0-rc.16
 */

import { type FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { CellTurn } from "@smthrs/harness"
import { type Model, ModelError, type ModelEvent, type ModelRequest } from "@smthrs/model"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { RouteResolver } from "./FlowEngineLike.ts"
import * as Internal from "./internal/ModelStep.ts"

/**
 * One model call.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface Options {
  /** The action name, such as `chat/answer/model`. Part of the key. */
  readonly name: string
  readonly request: ModelRequest.ModelRequest
  /** The model that streams the call, with its credential applied. */
  readonly model: Model.Model
  /**
   * The same route's credential-free preparation, which the key digests;
   * `FlowEngineLike.routeResolver` builds one from a configured route. A
   * resolver that disagrees with `model` keys the step on bytes the provider
   * never receives.
   */
  readonly route: RouteResolver
  /** Retries every failure the step does not seal. Defaults to {@link defaultRetryPolicy}. */
  readonly retryPolicy?: RetryPolicy.RetryPolicy | undefined
  /**
   * Milliseconds an attempt may go without a sign of life: an event, or bytes
   * such as a keep-alive. Zero disarms it. Defaults to
   * {@link heartbeatTimeoutMsFor} the request's reasoning effort.
   */
  readonly heartbeatTimeoutMs?: number | undefined
  /**
   * Milliseconds one provider call may take before it is cut off and sealed
   * as a `call_timeout` error. Zero disarms it. Defaults to
   * {@link callTimeoutMsFor} the request's reasoning effort.
   */
  readonly callTimeoutMs?: number | undefined
  /**
   * Receives each event while the call runs, and the recorded events on a
   * replay. An attempt that follows a failed or cut-off one starts with a
   * `retry` event: fold events as `ModelEvent.settledMessage` does, discarding
   * what came before a `retry`. `onEvent` runs inside the step, so a slow one
   * delays the call.
   */
  readonly onEvent?: ((event: ModelEvent.ModelEvent) => Effect.Effect<void>) | undefined
}

/**
 * What a model step settled with.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface Result {
  /** The provider's events, in order, as recorded. */
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
  /** The provider error the step sealed, when the provider refused the request. */
  readonly error?: ModelError.ModelError | undefined
  /** Whether this run answered from the record, without calling the provider. */
  readonly replayed: boolean
}

/**
 * Everything a model step fails with: a transient provider failure, such as a
 * capacity refusal or a dropped connection, that `retryPolicy` gave up on, a
 * permission failure from the route, or an engine failure deriving the key.
 *
 * @category schemas
 * @since 1.0.0-rc.16
 */
export const Failure = Internal.Failure

/**
 * The decoded form of {@link Failure}.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export type Failure = typeof Internal.Failure.Type

/**
 * The default retry policy for failures a step does not seal: at most six
 * attempts, the first retry after one second and each next one after twice the
 * last, with up to a fifth of each delay shaved off at random so concurrent
 * steps refused together do not return together. A provider's `Retry-After`
 * replaces the delay, up to thirty seconds. A permission failure is never
 * retried.
 *
 * The bound counts attempts, not wall-clock time: a model call's attempts run
 * from milliseconds to its call timeout, and a window long enough for a
 * reasoning call would let a provider refusing fast be asked for minutes.
 *
 * @category policies
 * @since 1.0.0-rc.16
 */
export const defaultRetryPolicy: RetryPolicy.RetryPolicy = RetryPolicy.make({
  initialMs: 1_000,
  factor: 2,
  maxMs: 30_000,
  maxAttempts: 6,
  jitterRatio: 0.2,
  nonRetryable: ["@smthrs/capability/PermissionRequired", "@smthrs/capability/PermissionDenied"]
})

/**
 * The default for {@link Options.heartbeatTimeoutMs} at a reasoning effort.
 *
 * | effort                            | silence allowed |
 * | --------------------------------- | --------------- |
 * | `none`, `minimal`, `low`          | 60 s            |
 * | unset, `medium`, `high`           | 300 s           |
 * | `xhigh`, `max`                    | no bound (0)    |
 *
 * A model that reasons can say nothing while it thinks, and a route that
 * emits an event only when an item completes says nothing through a whole
 * think. 300 s is stock Codex's stream idle timeout and the agent loop's
 * silence bound below `xhigh`; an unset effort takes the provider's default,
 * which reasons. At `xhigh` and `max` silence is not evidence of a stall, so
 * {@link callTimeoutMsFor} is the only bound, as it is in the agent loop.
 *
 * @category policies
 * @since 1.0.0
 */
export const heartbeatTimeoutMsFor = (effort: ModelRequest.ReasoningEffort | undefined): number => {
  switch (effort) {
    case "none":
    case "minimal":
    case "low":
      return 60_000
    case "xhigh":
    case "max":
      return 0
    default:
      return 300_000
  }
}

/**
 * The default for {@link Options.callTimeoutMs} at a reasoning effort: the
 * ceiling the agent loop gives one model call (`CellTurn.modelCallMsFor` in
 * `@smthrs/harness`).
 *
 * | effort                                    | ceiling |
 * | ----------------------------------------- | ------- |
 * | unset, `none`, `minimal`, `low`, `medium` | 300 s   |
 * | `high`                                    | 900 s   |
 * | `xhigh`, `max`                            | 1,800 s |
 *
 * @category policies
 * @since 1.0.0
 */
export const callTimeoutMsFor: (effort: ModelRequest.ReasoningEffort | undefined) => number = CellTurn.modelCallMsFor

/**
 * Calls a model as one durable, sealed step of the running flow.
 *
 * @example
 * ```ts
 * import { FlowEngineLike, ModelStep } from "@smthrs/agent"
 * import { type Model, ModelEvent, type ModelRequest } from "@smthrs/model"
 * import * as Effect from "effect/Effect"
 *
 * const answer = (
 *   model: Model.Model,
 *   route: FlowEngineLike.RouteResolver,
 *   request: ModelRequest.ModelRequest
 * ) =>
 *   Effect.gen(function*() {
 *     const result = yield* ModelStep.run({ name: "chat/answer/model", request, model, route })
 *     return ModelEvent.ModelEvent.settledMessage(result.events).message
 *   })
 * ```
 *
 * @category execution
 * @since 1.0.0-rc.16
 */
export const run = (
  options: Options
): Effect.Effect<Result, Failure, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance> =>
  Effect.gen(function*() {
    const prepared = yield* options.route.prepare(options.request)
    const key = yield* Internal.key(Internal.material(options.request), prepared)
    const effort = options.request.params.reasoningEffort
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? heartbeatTimeoutMsFor(effort)
    const { recorded, replayed } = yield* Internal.dispatch({
      name: options.name,
      key,
      request: options.request,
      model: options.model,
      retryPolicy: options.retryPolicy ?? defaultRetryPolicy,
      heartbeatTimeoutMs: heartbeatTimeoutMs === 0 ? undefined : heartbeatTimeoutMs,
      callTimeoutMs: options.callTimeoutMs ?? callTimeoutMsFor(effort),
      // No quota controller parks this step, so a refusal no wait clears is its answer.
      sealTerminal: true,
      onEvent: options.onEvent
    })
    if (replayed && options.onEvent !== undefined) {
      yield* Effect.forEach(recorded.events, options.onEvent, { discard: true })
    }
    return { events: recorded.events, ...(recorded.error === undefined ? {} : { error: recorded.error }), replayed }
  })

/**
 * The services a model step runs on: the engine, the running execution and
 * the host's `Crypto`, which derives the key.
 *
 * @category models
 * @since 1.0.0
 */
export type Requirements = Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance

/**
 * A `Model` whose every call is one sealed {@link run} of the running flow,
 * for code that takes a `Model` and calls it itself, such as
 * `Evaluator.layerFromSeat`. Build it inside a step, where the execution is
 * running; each request it streams is keyed, sealed and replayed as
 * {@link run} keys, seals and replays it, under `options.name`.
 *
 * Its stream emits the recorded events once the step settles, not while the
 * provider answers: use {@link run} with `onEvent` to watch a call live. A
 * refusal the step sealed fails the stream after those events, as the
 * provider's own stream would. A step failure fails it with the same error,
 * and an engine failure deriving the key fails it as a `ModelError` whose
 * code is `unknown`.
 *
 * @example
 * ```ts
 * import { type FlowEngineLike, ModelStep } from "@smthrs/agent"
 * import { Evaluator, type Model } from "@smthrs/model"
 * import * as Effect from "effect/Effect"
 *
 * // Each reading the judge takes is a sealed step named "judge/model".
 * const judge = (seat: { readonly model: Model.Model; readonly route: FlowEngineLike.RouteResolver }) =>
 *   Effect.map(
 *     ModelStep.model({ name: "judge/model", ...seat }),
 *     (model) => Evaluator.layerFromSeat({ modelId: "judge", model })
 *   )
 * ```
 *
 * @category execution
 * @since 1.0.0
 */
export const model = (
  options: Omit<Options, "request" | "onEvent">
): Effect.Effect<Model.Model, never, Requirements> =>
  Effect.map(Effect.context<Requirements>(), (context) => ({
    ...(options.model.providerName === undefined ? {} : { providerName: options.model.providerName }),
    stream: (request) =>
      Stream.unwrap(
        run({ ...options, request }).pipe(
          Effect.map((result) => {
            const events = Stream.fromIterable(result.events)
            return result.error === undefined ? events : Stream.concat(events, Stream.fail(result.error))
          }),
          Effect.mapError((failure) =>
            failure._tag === "/harness/HarnessError"
              ? new ModelError.ModelError({ code: "unknown", message: failure.message })
              : failure
          ),
          Effect.provideContext(context)
        )
      )
  }))
