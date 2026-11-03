/**
 * Projects a connected MCP server's tools as an ordinary {@link FlowBinding.Source}.
 *
 * This is the whole adapter: `@smthrs/harness/FlowBinding`'s own module doc
 * already names the target directly: "a standard filesystem flow, a memory
 * flow, an incoming MCP tool, a durable child agent" are all just a flow
 * declaration plus the code that runs it. Nothing about the harness, the
 * registry, or the cell loop needs to know a given flow's implementation
 * happens to proxy a remote MCP `tools/call`; a cell that reads a file and a
 * cell that calls an MCP tool run the identical two lines.
 *
 * @since 1.0.0-rc.0
 */
import * as Effects from "@smthrs/core/Effects";
import * as FlowBinding from "@smthrs/harness/FlowBinding";
import { Effect, Schema, Scope } from "effect";
import * as McpClient from "../../../src/McpClient.ts";
import { McpError } from "./McpError.vibe";
/**
 * Decoded input accepted by every MCP tool flow, which is whatever the remote
 * tool's own JSON Schema describes. The registry still discloses the real parameter
 * shape, as shown by {@link toolBinding}. This is only the runtime decode, and it
 * is permissive because the server, not this adapter, owns validation.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Args: Schema.$Record<Schema.String, Schema.Unknown>;
/**
 * Decoded output returned by every MCP tool flow, carrying the tool's content
 * blocks by shape plus whether the server reported an error.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Result: Schema.Struct<{
    readonly content: Schema.$Array<Schema.$Record<Schema.String, Schema.Unknown>>;
    readonly isError: Schema.Boolean;
    readonly structuredContent: Schema.optional<Schema.$Record<Schema.String, Schema.Unknown>>;
}>;
/**
 * The authority every MCP tool flow declares.
 *
 * An MCP tool is opaque code this adapter does not control, the same
 * situation `@smthrs/registry/MarkdownFlow` calls "unprojectable authority"
 * for a skill with no declared `capabilities`: the honest declaration is
 * everything, not a guess.
 *
 * It is spelled as one exact `namespace:operation:resource` per action because
 * the cell boundary reads each declaration with `Capability.parse`, which
 * rejects anything that does not have exactly those three colon-separated
 * components. An unparseable declaration counts as unauthorized. The list is
 * derived from `Capability.Action.literals`, so adding a host action cannot
 * silently omit it from MCP tools, and it is frozen so no caller can narrow
 * or widen what every tool declares. Each binding records it deduplicated and
 * sorted, as `FlowBinding.make` records every declaration.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const capabilities: ReadonlyArray<string>;
/**
 * The conservative effect envelope every MCP tool flow declares.
 *
 * @category effects
 * @since 1.0.0-rc.0
 */
export declare const effects: Effects.Declaration;
/**
 * Selects and names the tools projected from one MCP catalog.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ProjectionOptions {
    /** Exact tool names to project. Omitted or empty means every tool. */
    readonly include?: ReadonlyArray<string> | undefined;
    /** Exact tool names to drop, applied after `include`. */
    readonly exclude?: ReadonlyArray<string> | undefined;
    /** Replaces the default `mcp/<server>` flow-name prefix. */
    readonly namePrefix?: string | undefined;
}
/**
 * Projects an already-connected MCP session's tool catalog as a
 * {@link FlowBinding.Source}, one flow per tool.
 *
 * The client is a precondition, not a parameter this constructor resolves:
 * connecting is a scoped effect (it owns a subprocess), and a `Source` is not
 * scoped, so the host composes {@link McpClient.connect} once, at the same
 * place it composes every other scoped kernel service, and passes the live
 * client here.
 *
 * This constructor is total: it applies exact filters to the catalog it is
 * given. Use {@link connected} when unknown `include` names and an empty
 * `namePrefix` must fail loudly against a freshly fetched catalog.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const mcp: (client: McpClient.McpClient, options?: ProjectionOptions) => FlowBinding.Source;
/**
 * Connects to an MCP server and projects its tools in one step.
 *
 * This is the checked entry point: it validates projection options against
 * the freshly fetched catalog before constructing the source. An empty prefix
 * fails before spawning. Failed or interrupted setup, including projection
 * validation, releases the connection before returning to the caller.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const connected: <O extends McpClient.ConnectOptions>(options: O & ProjectionOptions) => Effect.Effect<FlowBinding.Source, McpError, McpClient.Requirements<O> | Scope.Scope>;
