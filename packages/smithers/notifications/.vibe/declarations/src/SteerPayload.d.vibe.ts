/**
 * The steering vocabulary carried inside a notification payload.
 *
 * A steer crosses two packages that must not depend on each other. A control
 * plane admits it into the durable queue; a harness drains it at a turn
 * boundary and turns it into a change the model sees. Both depend on this
 * package, so the shape they have to agree on lives here rather than in
 * either of them.
 *
 * The payload is stored as JSON in the journal, which makes decoding the
 * interesting half. Only a `human-steer` or `human-followup` carries a steer: a
 * `system-event` decodes as nothing whatever its payload says, because system
 * events carry webhook bodies and machine reports, and reading one as an
 * instruction would let its producer message the model or change its seat,
 * thinking, or tools. Inside a human notification, a record carrying a `body`
 * string and no `kind` decodes as a message, because that is what a minimal
 * caller means by it: the control plane's steer RPC accepts the same shape. A
 * payload this module cannot classify decodes as nothing at all.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import type * as Notification from "./Notification.vibe";
/**
 * How hard the model should think.
 *
 * A subset of `ModelRequest.ReasoningEffort` in `@smthrs/model`, which this
 * package deliberately does not depend on: a durable payload schema that
 * pulled in a provider client would make every queue reader carry one. Every
 * literal here is one of that schema's, so the harness assigns a `Thinking`
 * to a `ReasoningEffort` directly; `ReasoningEffort` also admits `"max"`,
 * which steering does not offer.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Thinking: Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh"]>;
/**
 * How hard the model should think.
 *
 * @category models
 * @since 0.1.0
 */
export type Thinking = typeof Thinking.Type;
/**
 * A message inserted into the transcript at the next turn boundary.
 *
 * The body may be empty. An operator who steers an empty message has still told
 * the run something: that a human is watching, and that the turn should
 * continue. Refusing it here would turn a deliberate nudge into a lost steer.
 *
 * @category models
 * @since 0.1.0
 */
export declare const MessagePayload: Schema.Struct<{
    readonly kind: Schema.Literal<"Message">;
    readonly body: Schema.String;
}>;
/**
 * The decoded form of {@link MessagePayload}.
 *
 * @category models
 * @since 0.1.0
 */
export type MessagePayload = typeof MessagePayload.Type;
/**
 * A model-seat change that applies from the next turn on.
 *
 * @category models
 * @since 0.1.0
 */
export declare const SeatPayload: Schema.Struct<{
    readonly kind: Schema.Literal<"Seat">;
    readonly seat: Schema.NonEmptyString;
}>;
/**
 * The decoded form of {@link SeatPayload}.
 *
 * @category models
 * @since 0.1.0
 */
export type SeatPayload = typeof SeatPayload.Type;
/**
 * A thinking-level change that applies from the next turn on.
 *
 * @category models
 * @since 0.1.0
 */
export declare const ThinkingPayload: Schema.Struct<{
    readonly kind: Schema.Literal<"Thinking">;
    readonly thinking: Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh"]>;
}>;
/**
 * The decoded form of {@link ThinkingPayload}.
 *
 * @category models
 * @since 0.1.0
 */
export type ThinkingPayload = typeof ThinkingPayload.Type;
/**
 * Tools added to the active set for future turns.
 *
 * Additive only: steering can widen what the agent may reach for, and cannot
 * narrow it, because a turn already in flight may hold a call to a tool a
 * narrowing steer would have removed.
 *
 * @category models
 * @since 0.1.0
 */
export declare const ToolsPayload: Schema.Struct<{
    readonly kind: Schema.Literal<"Tools">;
    readonly toolNames: Schema.NonEmptyArray<Schema.NonEmptyString>;
}>;
/**
 * The decoded form of {@link ToolsPayload}.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolsPayload = typeof ToolsPayload.Type;
/**
 * Any steering item a notification payload can carry.
 *
 * @category models
 * @since 0.1.0
 */
export declare const SteerPayload: Schema.Union<readonly [Schema.Struct<{
    readonly kind: Schema.Literal<"Message">;
    readonly body: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"Seat">;
    readonly seat: Schema.NonEmptyString;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"Thinking">;
    readonly thinking: Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh"]>;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"Tools">;
    readonly toolNames: Schema.NonEmptyArray<Schema.NonEmptyString>;
}>]>;
/**
 * Any steering item a notification payload can carry.
 *
 * @category models
 * @since 0.1.0
 */
export type SteerPayload = typeof SteerPayload.Type;
/**
 * Reads a notification as a steering item, or reports that it is not one.
 *
 * The notification, not its payload, is the argument: a `system-event` is
 * never a steer, so the classification cannot be separated from who sent it.
 *
 * @param notification the admitted notification
 * @category conversions
 * @since 0.1.0
 */
export declare const decode: (notification: Notification.Notification) => SteerPayload | undefined;
/**
 * The payload a steering item is stored as.
 *
 * Every item is written with its `kind`, including a message: the body-only
 * form is read as a convenience and never written.
 *
 * The result is typed as the item itself. Every item is JSON, so it is
 * assignable to `Notification.payload` without an assertion.
 *
 * The returned record shares no mutable structure with `item`. A caller hands
 * the result to an admission that serializes it later, so an array still
 * aliased to the caller could change what is durably journaled after the call
 * returned.
 *
 * @param item the steering item
 * @category conversions
 * @since 0.1.0
 */
export declare const encode: (item: SteerPayload) => SteerPayload;
