import { Context, Effect, Schema, Stream } from "effect";
import type { Event } from "./conversation.ts";
/** Which backend a `Factory` talks to. */
export type Mode = "mock" | "live";
declare const Unavailable_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "Unavailable";
} & Readonly<A>;
/** vibelang.smithers.sh couldn't be reached, or answered with something that isn't the protocol. */
export declare class Unavailable extends Unavailable_base<{
    readonly reason: string;
}> {
}
declare const Refused_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "Refused";
} & Readonly<A>;
/** The sequencer refused a post: `empty`, `too-long`, `duplicate`, `busy` or `not-replying`. */
export declare class Refused extends Refused_base<{
    readonly refusal: string;
}> {
}
/** The wire form of a conversation's events, as `conversation.ts` defines them. */
export declare const Posted: Schema.Struct<{
    readonly type: Schema.Literal<"Posted">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
    readonly clientId: Schema.String;
    readonly name: Schema.String;
    readonly text: Schema.String;
}>;
export type Posted = typeof Posted.Type;
export declare const ReplyStarted: Schema.Struct<{
    readonly type: Schema.Literal<"ReplyStarted">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
}>;
export type ReplyStarted = typeof ReplyStarted.Type;
export declare const ReplyDelta: Schema.Struct<{
    readonly type: Schema.Literal<"ReplyDelta">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
    readonly text: Schema.String;
}>;
export type ReplyDelta = typeof ReplyDelta.Type;
export declare const ReplyFinished: Schema.Struct<{
    readonly type: Schema.Literal<"ReplyFinished">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
}>;
export type ReplyFinished = typeof ReplyFinished.Type;
export declare const ReplyFailed: Schema.Struct<{
    readonly type: Schema.Literal<"ReplyFailed">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
    readonly reason: Schema.String;
}>;
export type ReplyFailed = typeof ReplyFailed.Type;
/** Decodes one event off the wire. */
export declare const EventSchema: Schema.Union<readonly [Schema.Struct<{
    readonly type: Schema.Literal<"Posted">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
    readonly clientId: Schema.String;
    readonly name: Schema.String;
    readonly text: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"ReplyStarted">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"ReplyDelta">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
    readonly text: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"ReplyFinished">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"ReplyFailed">;
    readonly seq: Schema.Number;
    readonly id: Schema.String;
    readonly reason: Schema.String;
}>]>;
type Factory_shape = {
    readonly mode: Mode;
    post(conversation: string, clientId: string, name: string, text: string): Effect.Effect<void, Unavailable | Refused>;
    events(conversation: string, after: number): Stream.Stream<Event, Unavailable>;
};
declare const Factory_base: Context.ServiceClass<Factory, "@smthrs/vibelang-site/src/core/Factory#Factory", Factory_shape>;
/**
 * The factory. `post` asks the sequencer to record a person's message; the agent answers on its own, and every
 * client sees the answer through `events`. `events(conversation, after)` replays the conversation's events numbered
 * above `after`, then follows new ones until the stream is closed.
 */
export declare class Factory extends Factory_base {
}
export declare namespace Factory {
    type Shape = Factory_shape;
}
export {};
