/**
 * Defines named wait points for durable flow executions.
 *
 * A `DurableDeferred` has a stable name and schemas for the value that will be
 * recorded later. Flows can await it, suspend when no result exists yet, and
 * resume after its result is recorded. Tokens identify the flow name,
 * execution id, and deferred name so external code can complete the correct
 * wait point later.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type * as Brand from "effect/Brand";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Flow from "../../../src/Flow/index.ts";
import { FlowInstance } from "./FlowRuntime/FlowInstance.vibe";
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.vibe";
declare const TypeId = "@smthrs/flow/DurableDeferred";
/**
 * Named durable deferred value whose completion is persisted by the flow
 * engine and encoded with success and error schemas.
 *
 * @category models
 * @since 0.1.0
 */
export interface DurableDeferred<Success extends Schema.Constraint, Error extends Schema.Constraint = Schema.Never> {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly successSchema: Success;
    readonly errorSchema: Error;
    readonly exitSchema: Schema.Exit<Schema.Top, Schema.Top, Schema.Top>;
    readonly withActionAttempt: Effect.Effect<DurableDeferred<Success, Error>>;
}
/**
 * Type-erased durable deferred shape for APIs that only need the deferred
 * identity and name.
 *
 * @category models
 * @since 0.1.0
 */
export interface Any {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
}
/**
 * Type-erased durable deferred shape that also exposes success, error, and
 * exit schemas.
 *
 * @category models
 * @since 0.1.0
 */
export interface AnyWithProps {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly successSchema: Schema.Top;
    readonly errorSchema: Schema.Top;
    readonly exitSchema: Schema.Exit<any, any, any>;
}
/**
 * Creates a named durable deferred with optional success and error schemas for
 * persisted completion.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <Success extends Schema.Constraint = Schema.Void, Error extends Schema.Constraint = Schema.Never>(name: string, options?: {
    readonly success?: Success | undefined;
    readonly error?: Error | undefined;
}) => DurableDeferred<Success, Error>;
declare const await_: <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>) => Effect.Effect<Success["Type"], Error["Type"], FlowRuntime | FlowInstance | Success["DecodingServices"] | Error["DecodingServices"]>;
export { 
/**
 * Waits for the durable deferred, suspending the current flow when no
 * persisted completion is available.
 *
 * @category combinators
 * @since 0.1.0
 */
await_ as await };
/**
 * Runs an effect and records its exit into the durable deferred, resuming
 * flows that are waiting on that deferred.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const into: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>): <R>(effect: Effect.Effect<Success["Type"], Error["Type"], R>) => Effect.Effect<Success["Type"], Error["Type"], R | FlowRuntime | FlowInstance | Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint, R>(effect: Effect.Effect<Success["Type"], Error["Type"], R>, self: DurableDeferred<Success, Error>): Effect.Effect<Success["Type"], Error["Type"], R | FlowRuntime | FlowInstance | Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"]>;
};
/**
 * Runs effects as a durable race, returning a previously persisted result when
 * present or completing a named deferred with the first success. The race
 * fails only when every effect fails.
 *
 * @category racing
 * @since 0.1.0
 */
export declare const raceAll: <const Effects extends NonEmptyReadonlyArray<Effect.Effect<any, any, any>>, Success extends Schema.Schema<Effect.Success<Effects[number]>>, Error extends Schema.Schema<Effect.Error<Effects[number]>>>(options: {
    name: string;
    success: Success;
    error: Error;
    effects: Effects;
}) => Effect.Effect<Effect.Success<Effects[number]>, Effect.Error<Effects[number]>, Effect.Services<Effects[number]> | Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"] | FlowRuntime | FlowInstance>;
/**
 * Runtime brand identifier for durable deferred tokens.
 *
 * @category type IDs
 * @since 0.1.0
 */
export declare const TokenTypeId = "@smthrs/flow/DurableDeferred/Token";
/**
 * Type-level brand identifier for `Token` values.
 *
 * @category type IDs
 * @since 0.1.0
 */
export type TokenTypeId = typeof TokenTypeId;
/**
 * Branded string token identifying a durable deferred for a flow
 * execution.
 *
 * A token is an address, not a credential. It is unsigned base64url JSON of
 * the flow name, execution id, and deferred name, and `tokenFromExecutionId`
 * and `tokenFromPayload` rebuild it from those values alone. Anyone who can
 * call `done`, `succeed`, `fail`, `failCause`, or `HumanTask.answer` against
 * the run's `FlowRuntime` can complete an open wait whose address they know or
 * derive. A host that exposes completion to other parties must authorize the
 * caller before it calls one of them.
 *
 * @category token
 * @since 0.1.0
 */
export type Token = Brand.Branded<string, TokenTypeId>;
/**
 * Schema for branded durable deferred tokens.
 *
 * @category token
 * @since 0.1.0
 */
export declare const Token: Schema.brand<Schema.String, TokenTypeId>;
declare const TokenInvalid_base: Schema.Class<TokenInvalid, Schema.TaggedStruct<"@smthrs/flow/DurableDeferred/TokenInvalid", {
    readonly code: Schema.withConstructorDefault<Schema.Literals<readonly ["malformed_token", "deferred_mismatch"]>>;
    readonly message: Schema.String;
}>, Cause.YieldableError>;
/**
 * A completion token could not be decoded into its durable address.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class TokenInvalid extends TokenInvalid_base {
}
declare const TokenParsed_base: Schema.Class<TokenParsed, Schema.Struct<{
    readonly flowName: Schema.String;
    readonly executionId: Schema.String;
    readonly deferredName: Schema.String;
}>, {}>;
/**
 * Schema for a decoded durable deferred token containing the flow
 * name, execution ID, and deferred name.
 *
 * @category token
 * @since 0.1.0
 */
export declare class TokenParsed extends TokenParsed_base {
    /**
     * Encodes the parsed flow, execution, and deferred names back into a token.
     *
     * @since 0.1.0
     */
    get asToken(): Token;
    /**
     * Schema for decoding and encoding durable deferred tokens as strings.
     *
     * @since 0.1.0
     */
    static readonly FromString: Schema.decodeTo<typeof TokenParsed, Schema.decodeTo<Schema.fromJsonString<Schema.Tuple<readonly [Schema.String, Schema.String, Schema.String]>>, Schema.String, never, never>, never, never>;
    /**
     * Decodes a durable deferred token string into its parsed components.
     *
     * @since 0.1.0
     */
    static readonly fromString: (input: string, options?: import("effect/SchemaAST").ParseOptions) => TokenParsed;
    /**
     * Encodes parsed durable deferred token components into a token string.
     *
     * @since 0.1.0
     */
    static readonly encode: (input: TokenParsed, options?: import("effect/SchemaAST").ParseOptions) => string;
    /**
     * Parses an untrusted token into its durable address with a typed,
     * bounded diagnostic on failure.
     *
     * @category token
     * @since 1.0.0
     */
    static readonly parse: (token: string) => Effect.Effect<TokenParsed, TokenInvalid>;
}
/**
 * Creates a token for a durable deferred using the current flow instance's
 * flow name and execution ID.
 *
 * @category token
 * @since 0.1.0
 */
export declare const token: <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>) => Effect.Effect<Token, never, FlowInstance>;
/**
 * Creates a durable deferred token from an explicit flow, execution ID,
 * and deferred name.
 *
 * @category token
 * @since 0.1.0
 */
export declare const tokenFromExecutionId: {
    (options: {
        readonly flow: Flow.Any;
        readonly executionId: string;
    }): <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>) => Token;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly flow: Flow.Any;
        readonly executionId: string;
    }): Token;
};
/**
 * Creates a durable deferred token by deriving the flow execution ID from
 * the supplied flow payload.
 *
 * The payload identifies a previously started execution only when the flow
 * declares `idempotencyKey` or the host installs the opt-in `derived`
 * execution-id source. Otherwise the default `fresh` source mints a new
 * execution ID on every call, so the token addresses no earlier run. To
 * complete an existing execution without stable identity, keep its execution
 * ID and use {@link tokenFromExecutionId}.
 *
 * @category token
 * @since 0.1.0
 */
export declare const tokenFromPayload: {
    <W extends Flow.Any>(options: {
        readonly flow: W;
        readonly payload: Flow.PayloadSchema<W>["~type.make.in"];
    }): <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>) => Effect.Effect<Token, never, Crypto.Crypto | Flow.PayloadSchema<W>["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint, W extends Flow.Any>(self: DurableDeferred<Success, Error>, options: {
        readonly flow: W;
        readonly payload: Flow.PayloadSchema<W>["~type.make.in"];
    }): Effect.Effect<Token, never, Crypto.Crypto | Flow.PayloadSchema<W>["EncodingServices"]>;
};
/**
 * Completes the durable deferred identified by a token with the supplied exit,
 * encoding the result through the deferred schemas.
 *
 * The token is not a credential (see {@link Token}): authorize the caller
 * before completing a wait on its behalf.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const done: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly token: Token;
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>;
    }): (self: DurableDeferred<Success, Error>) => Effect.Effect<void, TokenInvalid, FlowRuntime | Success["EncodingServices"] | Error["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly token: Token;
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>;
    }): Effect.Effect<void, TokenInvalid, FlowRuntime | Success["EncodingServices"] | Error["EncodingServices"]>;
};
/**
 * Completes the durable deferred identified by a token with a successful
 * value.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const succeed: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly token: Token;
        readonly value: Success["Type"];
    }): (self: DurableDeferred<Success, Error>) => Effect.Effect<void, TokenInvalid, FlowRuntime | Success["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly token: Token;
        readonly value: Success["Type"];
    }): Effect.Effect<void, TokenInvalid, FlowRuntime | Success["EncodingServices"]>;
};
/**
 * Completes the durable deferred identified by a token with a typed failure.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const fail: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly token: Token;
        readonly error: Error["Type"];
    }): (self: DurableDeferred<Success, Error>) => Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly token: Token;
        readonly error: Error["Type"];
    }): Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]>;
};
/**
 * Completes the durable deferred identified by a token with a failure cause.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const failCause: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly token: Token;
        readonly cause: Cause.Cause<Error["Type"]>;
    }): (self: DurableDeferred<Success, Error>) => Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly token: Token;
        readonly cause: Cause.Cause<Error["Type"]>;
    }): Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]>;
};
