/**
 * The messages the engine's leader and its followers exchange over the
 * engine's `BroadcastChannel`.
 *
 * - A follower posts a request (`Start`, `Poll`, `Cancel`, `Signal`, and the
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

import { Flow } from "@smthrs/flow"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const addressed = {
  client: Schema.String,
  id: Schema.Number
}

const execution = {
  ...addressed,
  flow: Schema.String,
  executionId: Schema.String
}

/**
 * Admit `executionId` with `payload` and drive it in the background.
 * `origin` is the door and actor kind the tab started it with, which the
 * engine keeps for the run's usage metrics (`@smthrs/flow` `RunMetrics`).
 *
 * @category protocol
 * @since 1.0.0
 */
export const Start = Schema.TaggedStruct("Start", {
  ...execution,
  payload: Schema.Json,
  origin: Schema.optionalKey(Schema.Struct({ door: Schema.String, actor: Schema.String }))
})

/**
 * Read `executionId`'s result, or `null` while it has none.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Poll = Schema.TaggedStruct("Poll", execution)

/**
 * Request cancellation of `executionId`.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Cancel = Schema.TaggedStruct("Cancel", execution)

/**
 * Resolve `executionId`'s `WaitFor` point `name` with `value`.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Signal = Schema.TaggedStruct("Signal", { ...execution, name: Schema.String, value: Schema.Json })

/**
 * Read one run: its lifecycle, steps, children and the journal page after
 * `afterSeq`, at most `limit` events. The reply's `result` is the run's
 * redacted, bounded `RunInspection.Inspection`.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Inspect = Schema.TaggedStruct("Inspect", {
  ...addressed,
  runId: Schema.String,
  afterSeq: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number)
})

/**
 * List runs newest first, `limit` at a time from `cursor`; `roots`, the
 * default, keeps the runs with no parent. The reply's `result` is a
 * `RunInspection.RunList`.
 *
 * @category protocol
 * @since 1.0.0
 */
export const List = Schema.TaggedStruct("List", {
  ...addressed,
  limit: Schema.optionalKey(Schema.Number),
  cursor: Schema.optionalKey(Schema.String),
  roots: Schema.optionalKey(Schema.Boolean),
  flows: Schema.optionalKey(Schema.Array(Schema.String))
})

/**
 * Any request a follower sends.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Request = Schema.Union([Start, Poll, Cancel, Signal, Inspect, List])

/**
 * The value form of {@link Request}.
 *
 * @category protocol
 * @since 1.0.0
 */
export type Request = typeof Request.Type

/**
 * The leader handled the request. `result` is the encoded flow result a
 * `Poll` read, the read an `Inspect` or a `List` made, and `null` for every
 * other request.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Replied = Schema.TaggedStruct("Replied", { ...addressed, result: Schema.NullOr(Schema.Json) })

/**
 * The leader refused the request. `error` is the failure's tag, never its
 * message.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Refused = Schema.TaggedStruct("Refused", { ...addressed, error: Schema.String })

/**
 * A worker took the lock and serves requests from now on.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Leader = Schema.TaggedStruct("Leader", {})

/**
 * The leader's engine committed an event of `eventType` for `executionId`.
 *
 * @category protocol
 * @since 1.0.0
 */
export const RunChanged = Schema.TaggedStruct("RunChanged", { executionId: Schema.String, eventType: Schema.String })

/**
 * Every message on the channel.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Message = Schema.Union([Start, Poll, Cancel, Signal, Inspect, List, Replied, Refused, Leader, RunChanged])

/**
 * The value form of {@link Message}.
 *
 * @category protocol
 * @since 1.0.0
 */
export type Message = typeof Message.Type

/**
 * Decodes a channel message, or `undefined` for anything else posted there.
 *
 * @category protocol
 * @since 1.0.0
 */
export const decode = (input: unknown): Message | undefined => Option.getOrUndefined(decodeMessage(input))

const decodeMessage = Schema.decodeUnknownOption(Message)

/**
 * Encodes a message for `postMessage`.
 *
 * @category protocol
 * @since 1.0.0
 */
export const encode: (message: Message) => unknown = Schema.encodeSync(Message)

/**
 * Posted by an engine worker to its own tab, never on the channel: its engine
 * could not be built, and `error` is the failure's tag. The tab then has no
 * engine.
 *
 * @category protocol
 * @since 1.0.0
 */
export const Stopped = Schema.TaggedStruct("@smthrs/platform-browser/EngineStopped", { error: Schema.String })

const decodeStoppedMessage = Schema.decodeUnknownOption(Stopped)

/**
 * Decodes a worker's message to its tab as {@link Stopped}, or `undefined`
 * for anything else the worker posts.
 *
 * @category protocol
 * @since 1.0.0
 */
export const decodeStopped = (input: unknown): typeof Stopped.Type | undefined =>
  Option.getOrUndefined(decodeStoppedMessage(input))

/**
 * The shared wire codec of a flow's terminal result.
 * @category codecs
 * @since 1.0.0
 */
export const resultCodec = (flow: Pick<Flow.Any, "successSchema" | "errorSchema">) =>
  Schema.toCodecJson(Flow.Result({ success: flow.successSchema, error: flow.errorSchema })) as unknown as Schema.Codec<
    Flow.Result<unknown, unknown>,
    Schema.Json
  >
