/**
 * The `lsp` flow: one code-intelligence query per call.
 *
 * The handler checks the path and 1-based position each operation needs,
 * authorizes the path as a read through the guarded `FileSystem` (the server
 * process reads the file on its own), forwards the query to the bound
 * `LanguageServer`, and returns the server's answer unchanged in `result`.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as LanguageServer from "./LanguageServer.vibe";
import * as StdError from "./StdError.vibe";
/**
 * The registry name of the `lsp` flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const name = "lsp";
/**
 * The one-line description the model sees for the `lsp` flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export declare const description = "Inspect code intelligence through the configured language server.";
/**
 * What the `lsp` flow accepts.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
    readonly operation: Schema.Literals<readonly ["hover", "definition", "references", "implementation", "documentSymbols", "workspaceSymbols", "prepareCallHierarchy", "callHierarchyIncoming", "callHierarchyOutgoing", "diagnostics"]>;
    readonly path: Schema.optional<Schema.String>;
    readonly line: Schema.optional<Schema.Int>;
    readonly character: Schema.optional<Schema.Int>;
    readonly query: Schema.optional<Schema.String>;
}>;
/**
 * Decoded input accepted by the `lsp` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * What the `lsp` flow returns.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Output: Schema.Struct<{
    readonly result: Schema.Unknown;
}>;
/**
 * Decoded output returned by the `lsp` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type;
/**
 * The declared effect envelope of the `lsp` flow, before any input is known.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effects: import("@smthrs/plan/Effects").Declaration;
/**
 * Returns the workspace-wide envelope every language-server query needs.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effectsFor: (_input: typeof Input.Type) => import("@smthrs/plan/Effects").Declaration;
/**
 * The authority the `lsp` flow requires.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: string[];
/**
 * The `lsp` flow declaration: schemas, capabilities, and effects, with the
 * implementation attached separately.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
    readonly name: "lsp";
    readonly description: "Inspect code intelligence through the configured language server.";
    readonly input: Schema.Struct<{
        readonly operation: Schema.Literals<readonly ["hover", "definition", "references", "implementation", "documentSymbols", "workspaceSymbols", "prepareCallHierarchy", "callHierarchyIncoming", "callHierarchyOutgoing", "diagnostics"]>;
        readonly path: Schema.optional<Schema.String>;
        readonly line: Schema.optional<Schema.Int>;
        readonly character: Schema.optional<Schema.Int>;
        readonly query: Schema.optional<Schema.String>;
    }>;
    readonly output: Schema.Struct<{
        readonly result: Schema.Unknown;
    }>;
    readonly capabilities: string[];
    readonly effects: import("@smthrs/plan/Effects").Declaration;
};
/**
 * Runs the `lsp` flow: queries the configured language server.
 *
 * @category handlers
 * @since 1.0.0
 */
export declare const run: (input: {
    readonly operation: "callHierarchyIncoming" | "callHierarchyOutgoing" | "definition" | "diagnostics" | "documentSymbols" | "hover" | "implementation" | "prepareCallHierarchy" | "references" | "workspaceSymbols";
    readonly path?: string | undefined;
    readonly line?: number | undefined;
    readonly character?: number | undefined;
    readonly query?: string | undefined;
}) => Effect.Effect<typeof Output.Type, StdError.StdError, LanguageServer.LanguageServer | FileSystem.FileSystem>;
