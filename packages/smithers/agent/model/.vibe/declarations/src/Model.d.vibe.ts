/**
 * The one provider seam: a request in, a stream of typed events out.
 *
 * Everything a consumer needs to reach a provider is behind this service, so a
 * flow, a harness or a test swaps the implementation without knowing which
 * protocol, endpoint or credential answers the call.
 *
 * @since 0.1.0
 */
import type { Permission } from "@smthrs/capability";
import { Context, Effect, Layer, Stream } from "effect";
import type { ModelError } from "./ModelError.vibe";
import type { ModelEvent } from "./ModelEvent.vibe";
import type { ModelRequest } from "../../../src/ModelRequest.ts";
/**
 * Provider and kernel failures surfaced by a model stream.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export type ModelFailure = ModelError | Permission.PermissionRequired | Permission.PermissionDenied | Permission.GrantStoreError;
/**
 * The one provider seam: a request in, a stream of events out.
 * Cancellation is fiber interruption, so there is no abort parameter.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Model {
    /** OpenTelemetry provider name declared by the deployment. */
    readonly providerName?: string;
    /** Streams model progress; cancellation is fiber interruption only. */
    readonly stream: (request: ModelRequest) => Stream.Stream<ModelEvent, ModelFailure>;
}
/**
 * The {@link Model} service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export declare const Model: Context.Service<Model, Model>;
/**
 * What a model stream runs each time the provider shows it is still there.
 *
 * A route runs it for every chunk of response bytes it receives, including a
 * keep-alive comment or a ping frame that decodes to no event. A provider can
 * think for minutes without streaming an event while it keeps the connection
 * alive, so a caller that bounds silence, such as a durable step's heartbeat,
 * provides its beat here and counts those chunks as progress. The default does
 * nothing.
 *
 * @example
 * ```ts
 * import { Model } from "@smthrs/model"
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 *
 * const watched = (model: Model.Model, request: Parameters<Model.Model["stream"]>[0], beat: Effect.Effect<void>) =>
 *   model.stream(request).pipe(Stream.provideService(Model.Liveness, beat))
 * ```
 *
 * @category references
 * @since 1.0.0
 */
export declare const Liveness: Context.Reference<Effect.Effect<void>>;
/**
 * Builds a {@link Model} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (implementation: Model) => Model;
/**
 * Provides {@link Model} from an implementation of its one method.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layer: (implementation: Model) => Layer.Layer<Model>;
/**
 * A {@link Model} that fails every stream with `no_route`, so an
 * environment with no provider configured reports that rather than hanging.
 * Overrides replace individual methods.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const makeNoop: (overrides?: Partial<Model>) => Model;
/**
 * Wraps one model call in an OpenTelemetry GenAI client span.
 *
 * The span is named `chat <model>` and carries `gen_ai.operation.name`,
 * `gen_ai.request.model`, the declared `gen_ai.provider.name`, the provider's `gen_ai.usage.input_tokens` and
 * `gen_ai.usage.output_tokens` as they stream in, the call's USD cost so far as
 * `gen_ai.usage.cost` when the model is priced (see {@link Pricing.cost}), and
 * `gen_ai.response.finish_reasons` from the settlement. When the settlement
 * says where the call's time went it also carries each stage as
 * `smithers.model.<stage>` (`smithers.model.headers_ms`,
 * `smithers.model.first_output_ms`, `smithers.model.attempts`) and the tier
 * that served it as `smithers.model.served_tier`. Prompt and response content
 * never reach the span, and neither does a failure's text: a failed span, and
 * every span the call opens under it, records the error's tag and code (for
 * example `flows/model/ModelError: rate_limited`) with no message or stack
 * from the provider, while the stream still fails with the original error.
 *
 * @category tracing
 * @since 1.0.0
 */
export declare const withGenAiSpan: (request: ModelRequest, providerName?: string) => <E, R>(stream: Stream.Stream<ModelEvent, E, R>) => Stream.Stream<ModelEvent, E, R>;
/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerNoop: (overrides?: Partial<Model>) => Layer.Layer<Model>;
