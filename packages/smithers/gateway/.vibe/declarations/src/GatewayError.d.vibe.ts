/**
 * Typed failures surfaced by the workspace gateway.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
/**
 * Stable failure codes exposed by gateway operations.
 *
 * @since 0.1.0
 * @category errors
 */
export declare const GatewayErrorCode: Schema.Literals<readonly ["bind_failed", "invalid_host", "invalid_origin", "unauthorized", "malformed_request", "request_too_large", "resource_limit", "run_unavailable", "run_not_found"]>;
/**
 * A stable gateway failure code.
 *
 * @since 0.1.0
 * @category errors
 */
export type GatewayErrorCode = typeof GatewayErrorCode.Type;
declare const GatewayError_base: Schema.Class<GatewayError, Schema.TaggedStruct<"@smthrs/gateway/GatewayError", {
    readonly code: Schema.Literals<readonly ["bind_failed", "invalid_host", "invalid_origin", "unauthorized", "malformed_request", "request_too_large", "resource_limit", "run_unavailable", "run_not_found"]>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Struct<{
        readonly _tag: Schema.String;
        readonly code: Schema.optional<Schema.String>;
    }>>;
}>, import("effect/Cause").YieldableError>;
/**
 * A normalized gateway operation failure.
 *
 * @since 0.1.0
 * @category errors
 */
export declare class GatewayError extends GatewayError_base {
}
/**
 * The refusal a numeric setting earns when it is not a positive safe integer,
 * or `undefined` when the gateway can run under it.
 *
 * The keepalive cadence and the request body limit are the same kind of
 * setting and are checked the same way. A cadence of zero turns the keepalive
 * into a tight loop and a body limit of zero refuses every request, so a
 * composition that asks for either is refused before it binds rather than
 * after it is serving.
 *
 * @param name what the value configures, named as the message will read
 * @param value the configured value, or undefined to accept the default
 * @since 1.0.0
 * @category constructors
 */
export declare const settingRefusal: (name: string, value: number | undefined) => GatewayError | undefined;
export {};
