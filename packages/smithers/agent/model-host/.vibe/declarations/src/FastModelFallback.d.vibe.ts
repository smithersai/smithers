/**
 * Host-selected fast-model fallbacks over the canonical model stream.
 *
 * @since 1.0.0
 */
import { type Model } from "@smthrs/model";
import { Effect } from "effect";
/**
 * Builds one model that streams from the first host-owned source and falls back
 * to the next only when a source fails as unavailable (authentication, rate limit,
 * quota, transport, call timeout or provider fault) before emitting any output.
 * A failure after output became visible, or on the last source, is returned as is.
 * `onFallback` runs with the index of the source about to be tried and is
 * interrupted after one second so a notification cannot block inference. With no
 * sources the stream fails with `no_route`.
 *
 * @since 1.0.0
 * @category constructors
 */
export declare const fastModelFallback: (sources: ReadonlyArray<{
    readonly model: Model.Model;
    readonly modelId: string;
    readonly outputTokenLimitSupported?: boolean;
}>, onFallback?: (index: number) => Effect.Effect<void>) => Model.Model;
