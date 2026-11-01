/**
 * Bounded byte-stream framing, independent of provider protocol decoding.
 *
 * @since 0.1.0
 */
import * as Sse from "effect/encoding/Sse";
import * as Stream from "effect/Stream";
import { ModelError } from "./ModelError.js";
/**
 * A byte-stream framing strategy selected independently of a protocol.
 *
 * @since 0.1.0
 * @category models
 */
export interface Framing<Frame> {
    readonly id: string;
    readonly frame: <E, R>(stream: Stream.Stream<Uint8Array, E, R>) => Stream.Stream<Frame, E | Sse.SseError | ModelError, R>;
}
/**
 * Inclusive default UTF-8 byte budget for one pending record (4 MiB).
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultMaxRecordBytes: number;
/**
 * Inclusive raw response budget (64 MiB), including delimiters and comments.
 * This also bounds argument text accumulated across separate tool-call frames.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultMaxResponseBytes: number;
/**
 * Finite framing budgets. Record bytes exclude a line's terminator for NDJSON;
 * SSE counts the event's lines with normalized LF terminators, excluding the
 * terminating blank line. The response budget counts every original byte.
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
    readonly maxRecordBytes?: number | undefined;
    readonly maxResponseBytes?: number | undefined;
}
/**
 * Creates bounded SSE framing. Incomplete final events are discarded; malformed
 * UTF-8 uses the TextDecoder replacement policy. Budget failures are terminal
 * invalid_provider_output errors and never contain response text.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeSse: (limits?: Limits) => Framing<string>;
/**
 * Incrementally decodes bounded UTF-8 SSE. Empty events and the [DONE] sentinel
 * are discarded. See makeSse for limits and the incomplete-event policy.
 *
 * @since 0.1.0
 * @category framing
 */
export declare const sse: Framing<string>;
/**
 * Creates bounded NDJSON framing. Blank lines are discarded. A partial final
 * line is emitted so protocol JSON decoding can report truncation. Malformed
 * UTF-8 follows the TextDecoder replacement policy, as SSE does.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeNdjson: (limits?: Limits) => Framing<string>;
/**
 * One JSON document per line, under the default record and response budgets.
 * See makeNdjson for the intentional partial-final-record policy.
 *
 * @since 0.1.0
 * @category framing
 */
export declare const ndjson: Framing<string>;
