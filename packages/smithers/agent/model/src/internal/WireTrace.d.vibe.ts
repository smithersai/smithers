/**
 * Opt-in wire trace for prompt-cache and latency debugging.
 *
 * An injected `WireTrace` sink receives two records per model call, paired
 * by `call`.
 *
 * The `request` line is written as the request is first signed: the route,
 * the cache key and `session-id` header (both public, never the signed
 * credential), whether a remembered affinity token rides along, a short hash
 * of the instructions, a hash and kind for each input item, and how many
 * leading input items match the previous request on the same cache key. A
 * prefix that stops growing while the transcript grows is the signature of a
 * request the provider cannot read back from cache.
 *
 * The `response` line is written when the call ends, however it ends: how it
 * ended, the HTTP status, the wire timing with every failed try, the usage,
 * the response id, the served tier, and the few response headers a provider
 * sends to identify and time a request. No request header is ever written.
 *
 * @since 1.0.0-rc.1
 * @internal
 */
import { Effect } from "effect";
import type { Timing, Usage } from "../ModelEvent.vibe";
import type * as Sink from "../WireTrace.vibe";
interface Traced {
    readonly routeId: string;
    readonly protocolId: string;
    readonly publicHeaders: Readonly<Record<string, string>>;
    readonly bodyText: string;
    /** Whether the request leaves with a remembered affinity token. */
    readonly affinity?: boolean | undefined;
}
/**
 * The trace line for one prepared request; `history` is per process.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export declare const line: (prepared: Traced, history?: Map<string, ReadonlyArray<string>>) => Record<string, unknown>;
/**
 * One call's sink, retained so both records reach the same host.
 * @category models
 * @since 1.0.0
 */
export interface TracedCall {
    readonly id: number;
    readonly sink: Sink.WireTrace;
}
/**
 * Records a request only when the host supplied a sink.
 * @category tracing
 * @since 1.0.0
 */
export declare const record: (prepared: Traced, sink: Sink.WireTrace | undefined) => Effect.Effect<TracedCall | undefined>;
/**
 * What one call's response line is written from. Everything here is what the
 * provider answered or how long it took; nothing here is what was signed.
 *
 * @category models
 * @since 1.0.0
 */
export interface Answered {
    readonly routeId: string;
    readonly protocolId: string;
    /**
     * How the call ended: `settled` with a stop reason, `ended` when the stream
     * finished without one, `interrupted` when its fiber was, or the code of the
     * failure that ended it.
     */
    readonly outcome: string;
    readonly stopReason?: string | undefined;
    /** The answered response's HTTP status, or the last failed try's. */
    readonly status?: number | undefined;
    readonly timing: Timing;
    readonly usage: Usage;
    readonly responseId?: string | undefined;
    readonly servedTier?: string | undefined;
    /** The answered response's headers; only {@link reportedHeaders} are kept. */
    readonly headers?: Readonly<Record<string, string>> | undefined;
}
/**
 * The response headers a provider sends to identify a request and to say how
 * long its own side took. They are copied by name; no other header is read,
 * so a cookie or a routing token never reaches the trace.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const reportedHeaders: ReadonlyArray<string>;
/**
 * The trace line for one call's response.
 *
 * @category models
 * @since 1.0.0
 */
export declare const responseLine: (call: number, answered: Answered, at: number) => Record<string, unknown>;
/**
 * Records a response on the sink that received the request, if any.
 * @category tracing
 * @since 1.0.0
 */
export declare const recordResponse: (call: TracedCall | undefined, answered: () => Answered, at: number) => Effect.Effect<void>;
export {};
