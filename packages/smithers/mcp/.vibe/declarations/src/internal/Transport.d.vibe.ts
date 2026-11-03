/**
 * The request/notify surface both MCP transports provide, and the failure
 * wording they share. {@link McpClient} speaks to this interface only; stdio
 * and Streamable HTTP differ in how a frame travels, not in what it means.
 *
 * @since 1.0.0-rc.1
 */
import { Effect, Stream } from "effect";
import { McpError } from "../McpError.vibe";
import type * as Rpc from "../../../../src/internal/Rpc.ts";
/**
 * One live connection to an MCP server.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Transport {
    /** Sends a request and resolves with its `result`, or fails with the server's `error`. */
    readonly request: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<unknown, McpError>;
    /** Sends a notification, bounding delivery by the optional positive-integer deadline. */
    readonly notify: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<void, McpError>;
}
/**
 * Default request deadline.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const defaultRequestTimeoutMs = 120000;
/**
 * Default maximum inbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const defaultMaxFrameBytes: number;
/**
 * Default maximum outbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const defaultMaxOutboundFrameBytes: number;
/**
 * The reason sent with a best-effort `notifications/cancelled`.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export declare const cancellationReason = "request no longer awaited";
/**
 * A `connection_closed` failure naming the server.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare const closed: (server: string, reason: string) => McpError;
/**
 * A `timeout` failure naming the server, method and deadline.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare const timeout: (server: string, method: string, timeoutMs: number) => McpError;
/**
 * The model-facing failure for a correlated JSON-RPC error reply. Remote text
 * is withheld; the caller reports it to Diagnostics.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare const replyError: (server: string, method: string, reply: Extract<Rpc.Reply, {
    readonly _tag: "Error";
}>) => McpError;
/**
 * Splits a byte stream into lines in linear time, retaining one bounded
 * partial line. Lines end at LF, with a CR before the LF dropped; with
 * `crTerminates`, as server-sent events require, a lone CR also ends a line.
 * Blank lines are kept: server-sent events use them as delimiters.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export declare const lines: <E>(server: string, maxLineBytes: number, stream: Stream.Stream<Uint8Array, E>, options?: {
    readonly crTerminates?: boolean;
}) => Stream.Stream<string, E | McpError>;
