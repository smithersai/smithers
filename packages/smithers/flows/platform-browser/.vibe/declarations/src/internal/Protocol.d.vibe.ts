/**
 * The messages the engine's leader and its followers exchange over the
 * engine's `BroadcastChannel`.
 *
 * - A follower posts a request (`Start`, `Retry`, `Poll`, `Cancel`, `Signal`, and the
 *   reads `Inspect` and `List`) under its own client id and a request number;
 *   only the leader answers, with `Replied` or `Refused` addressed to that
 *   client and number.
 * - A worker that becomes leader posts `Leader`, and every follower posts its
 *   unanswered requests again. Every request is idempotent, so a request the
 *   previous leader handled before it died is safe to handle twice.
 * - The leader posts `RunChanged` for every event its engine commits.
 *
 * Payloads, values and results travel as JSON, encoded with the flow's own
 * schemas. Nothing on the channel is logged.
 *
 * @since 1.0.0
 */
import { Flow } from "@smthrs/flow";
import * as Schema from "effect/Schema";
/**
 * Admit `executionId` with `payload` and drive it in the background.
 * `origin` is the door and actor kind the tab started it with, which the
 * engine keeps for the run's usage metrics (`@smthrs/flow` `RunMetrics`).
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Start: Schema.TaggedStruct<"Start", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly origin: Schema.optionalKey<Schema.Struct<{
        readonly door: Schema.String;
        readonly actor: Schema.String;
    }>>;
}>;
/**
 * Admit `executionId` as a retry of the settled run `source` from its node
 * `step` (`FlowRuntime.retryFrom`).
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Retry: Schema.TaggedStruct<"Retry", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly source: Schema.String;
    readonly step: Schema.String;
}>;
/**
 * Read `executionId`'s result, or `null` while it has none.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Poll: Schema.TaggedStruct<"Poll", {
    client: Schema.String;
    id: Schema.Number;
    flow: Schema.String;
    executionId: Schema.String;
}>;
/**
 * Request cancellation of `executionId`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Cancel: Schema.TaggedStruct<"Cancel", {
    client: Schema.String;
    id: Schema.Number;
    flow: Schema.String;
    executionId: Schema.String;
}>;
/**
 * Resolve `executionId`'s `WaitFor` point `name` with `value`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Signal: Schema.TaggedStruct<"Signal", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly name: Schema.String;
    readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>;
/**
 * Read one run: its lifecycle, steps, children and the journal page after
 * `afterSeq`, at most `limit` events. The reply's `result` is the run's
 * redacted, bounded `RunInspection.Inspection`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Inspect: Schema.TaggedStruct<"Inspect", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly runId: Schema.String;
    readonly afterSeq: Schema.optionalKey<Schema.Number>;
    readonly limit: Schema.optionalKey<Schema.Number>;
}>;
/**
 * List runs newest first, `limit` at a time from `cursor`; `roots`, the
 * default, keeps the runs with no parent. The reply's `result` is a
 * `RunInspection.RunList`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const List: Schema.TaggedStruct<"List", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly limit: Schema.optionalKey<Schema.Number>;
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly roots: Schema.optionalKey<Schema.Boolean>;
    readonly flows: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>;
/**
 * Any request a follower sends.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Request: Schema.Union<readonly [Schema.TaggedStruct<"Start", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly origin: Schema.optionalKey<Schema.Struct<{
        readonly door: Schema.String;
        readonly actor: Schema.String;
    }>>;
}>, Schema.TaggedStruct<"Retry", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly source: Schema.String;
    readonly step: Schema.String;
}>, Schema.TaggedStruct<"Poll", {
    client: Schema.String;
    id: Schema.Number;
    flow: Schema.String;
    executionId: Schema.String;
}>, Schema.TaggedStruct<"Cancel", {
    client: Schema.String;
    id: Schema.Number;
    flow: Schema.String;
    executionId: Schema.String;
}>, Schema.TaggedStruct<"Signal", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly name: Schema.String;
    readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.TaggedStruct<"Inspect", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly runId: Schema.String;
    readonly afterSeq: Schema.optionalKey<Schema.Number>;
    readonly limit: Schema.optionalKey<Schema.Number>;
}>, Schema.TaggedStruct<"List", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly limit: Schema.optionalKey<Schema.Number>;
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly roots: Schema.optionalKey<Schema.Boolean>;
    readonly flows: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>]>;
/**
 * The value form of {@link Request}.
 *
 * @category protocol
 * @since 1.0.0
 */
export type Request = typeof Request.Type;
/**
 * The leader handled the request. `result` is the encoded flow result a
 * `Poll` read, the read an `Inspect` or a `List` made, and `null` for every
 * other request.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Replied: Schema.TaggedStruct<"Replied", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly result: Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>;
/**
 * The leader refused the request. `error` is the failure's tag, never its
 * message.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Refused: Schema.TaggedStruct<"Refused", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly error: Schema.String;
}>;
/**
 * A worker took the lock and serves requests from now on.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Leader: Schema.TaggedStruct<"Leader", {}>;
/**
 * The leader's engine committed an event of `eventType` for `executionId`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const RunChanged: Schema.TaggedStruct<"RunChanged", {
    readonly executionId: Schema.String;
    readonly eventType: Schema.String;
}>;
/**
 * Every message on the channel.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Message: Schema.Union<readonly [Schema.TaggedStruct<"Start", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly origin: Schema.optionalKey<Schema.Struct<{
        readonly door: Schema.String;
        readonly actor: Schema.String;
    }>>;
}>, Schema.TaggedStruct<"Retry", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly source: Schema.String;
    readonly step: Schema.String;
}>, Schema.TaggedStruct<"Poll", {
    client: Schema.String;
    id: Schema.Number;
    flow: Schema.String;
    executionId: Schema.String;
}>, Schema.TaggedStruct<"Cancel", {
    client: Schema.String;
    id: Schema.Number;
    flow: Schema.String;
    executionId: Schema.String;
}>, Schema.TaggedStruct<"Signal", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly flow: Schema.String;
    readonly executionId: Schema.String;
    readonly name: Schema.String;
    readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.TaggedStruct<"Inspect", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly runId: Schema.String;
    readonly afterSeq: Schema.optionalKey<Schema.Number>;
    readonly limit: Schema.optionalKey<Schema.Number>;
}>, Schema.TaggedStruct<"List", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly limit: Schema.optionalKey<Schema.Number>;
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly roots: Schema.optionalKey<Schema.Boolean>;
    readonly flows: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>, Schema.TaggedStruct<"Replied", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly result: Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.TaggedStruct<"Refused", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly error: Schema.String;
}>, Schema.TaggedStruct<"Leader", {}>, Schema.TaggedStruct<"RunChanged", {
    readonly executionId: Schema.String;
    readonly eventType: Schema.String;
}>]>;
/**
 * The value form of {@link Message}.
 *
 * @category protocol
 * @since 1.0.0
 */
export type Message = typeof Message.Type;
/**
 * Decodes a channel message, or `undefined` for anything else posted there.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const decode: (input: unknown) => Message | undefined;
/**
 * Encodes a message for `postMessage`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const encode: (message: Message) => unknown;
/**
 * Posted by an engine worker to its own tab, never on the channel: its engine
 * could not be built, and `error` is the failure's tag. The tab then has no
 * engine.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Stopped: Schema.TaggedStruct<"@smthrs/platform-browser/EngineStopped", {
    readonly error: Schema.String;
}>;
/**
 * Decodes a worker's message to its tab as {@link Stopped}, or `undefined`
 * for anything else the worker posts.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const decodeStopped: (input: unknown) => typeof Stopped.Type | undefined;
/**
 * The shared wire codec of a flow's terminal result.
 * @category codecs
 * @since 1.0.0
 */
export declare const resultCodec: (flow: Pick<Flow.Any, "successSchema" | "errorSchema">) => Schema.Codec<Flow.Result<unknown, unknown>, Schema.Json>;
