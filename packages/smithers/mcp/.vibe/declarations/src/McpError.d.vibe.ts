/**
 * The single typed error returned by the MCP client and flow adapter.
 *
 * @since 1.0.0-rc.0
 */
import { Schema } from "effect";
/**
 * Stable, model-facing failure codes for MCP operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const Code: Schema.Literals<readonly ["spawn_failed", "connection_closed", "timeout", "protocol_error", "tool_not_found", "tool_failed", "invalid_response"]>;
/**
 * Stable, model-facing failure codes for MCP operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Code = typeof Code.Type;
declare const McpError_base: Schema.Class<McpError, Schema.TaggedStruct<"flows/mcp/McpError", {
    readonly code: Schema.Literals<readonly ["spawn_failed", "connection_closed", "timeout", "protocol_error", "tool_not_found", "tool_failed", "invalid_response"]>;
    readonly message: Schema.String;
    readonly server: Schema.optional<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * A recoverable MCP client or flow-adapter failure.
 *
 * Handlers keep ordinary tool outcomes (the remote tool's own `isError`
 * result) in the success channel; this error is reserved for failures of the
 * MCP session itself: the server would not exist, the pipe closed, a
 * response could not be parsed.
 *
 * Client-created messages withhold raw process/remote diagnostics and
 * user-controlled property paths. Trusted hosts can opt into Diagnostics for
 * bounded Redacted details. Successful tool output is not scrubbed.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export declare class McpError extends McpError_base {
}
export {};
