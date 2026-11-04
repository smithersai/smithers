/**
 * Faithful port of the Codex CLI apply_patch engine.
 *
 * Mirrors `codex-rs/apply-patch/src/{parser,streaming_parser,seek_sequence}.rs`
 * and the applier in `lib.rs`: the V4A patch grammar, the lenient heredoc
 * boundary handling, the fuzzy context-matching ladder, and every error
 * string, so ChatGPT-family models see exactly the behavior they were
 * posttrained on. Pure module: no host access.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
declare const ParseError_base: Schema.Class<ParseError, Schema.TaggedStruct<"@smthrs/std/ParseError", {
    readonly kind: Schema.Literals<readonly ["invalid_patch", "invalid_hunk"]>;
    readonly detail: Schema.String;
    readonly lineNumber: Schema.UndefinedOr<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/**
 * Parse failure with Codex-identical message text.
 *
 * `invalid patch: {message}` for patch-level failures and
 * `invalid hunk at line {line}, {message}` for hunk-level failures.
 *
 * @since 1.0.0
 * @private
 */
export declare class ParseError extends ParseError_base {
    get message(): string;
}
/**
 * One replaced region of an update hunk.
 *
 * @since 1.0.0
 * @private
 */
export interface UpdateFileChunk {
    changeContext: string | undefined;
    oldLines: Array<string>;
    newLines: Array<string>;
    isEndOfFile: boolean;
}
/**
 * A parsed patch hunk.
 *
 * @since 1.0.0
 * @private
 */
export type Hunk = {
    readonly kind: "add";
    readonly path: string;
    contents: string;
} | {
    readonly kind: "delete";
    readonly path: string;
} | {
    readonly kind: "update";
    readonly path: string;
    movePath: string | undefined;
    readonly chunks: Array<UpdateFileChunk>;
};
/**
 * Parsed patch: hunks plus the optional environment id preamble.
 *
 * @since 1.0.0
 * @private
 */
export interface ParsedPatch {
    readonly hunks: ReadonlyArray<Hunk>;
    readonly environmentId: string | undefined;
}
/**
 * Streaming line state machine for the V4A patch grammar; a faithful port of
 * `StreamingPatchParser`.
 *
 * @since 1.0.0
 * @private
 */
export declare class StreamingPatchParser {
    private lineBuffer;
    private mode;
    private hunks;
    private lineNumber;
    private _environmentId;
    environmentId(): string | undefined;
    private ensureUpdateHunkIsNotEmpty;
    private handleHunkHeadersAndEndPatch;
    pushDelta(delta: string): ReadonlyArray<Hunk>;
    finish(): ReadonlyArray<Hunk>;
    private processLine;
}
/**
 * Parse a complete patch text; lenient mode (heredoc unwrapping) is always
 * on, matching Codex.
 *
 * @since 1.0.0
 * @private
 */
export declare const parsePatch: (patch: string) => ParsedPatch;
/**
 * Fuzzy sequence search with the Codex leniency ladder: exact, rstrip, trim,
 * then unicode-normalised comparison; end-of-file patterns anchor at the end
 * first.
 *
 * @since 1.0.0
 * @private
 */
export declare const seekSequence: (lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, start: number, eof: boolean) => number | undefined;
declare const ComputeReplacementsError_base: Schema.Class<ComputeReplacementsError, Schema.TaggedStruct<"@smthrs/std/ComputeReplacementsError", {
    readonly reason: Schema.Literals<readonly ["context_not_found", "lines_not_found"]>;
    readonly path: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Applier failure carrying the Codex message text verbatim.
 *
 * `context_not_found` is an `@@` context line absent from the file;
 * `lines_not_found` is a chunk whose expected lines are absent.
 *
 * @since 1.0.0
 * @private
 */
export declare class ComputeReplacementsError extends ComputeReplacementsError_base {
}
/**
 * Derive the new file contents for an update hunk from the original
 * contents, matching Codex `derive_new_contents_from_chunks`.
 *
 * @since 1.0.0
 * @private
 */
export declare const deriveNewContents: (originalContents: string, path: string, chunks: ReadonlyArray<UpdateFileChunk>) => string;
/**
 * Render the Codex success summary: `Success. Updated the following files:`
 * with `A`/`M`/`D` lines for adds, updates, and deletes in that order.
 *
 * @since 1.0.0
 * @private
 */
export declare const printSummary: (affected: {
    readonly added: ReadonlyArray<string>;
    readonly modified: ReadonlyArray<string>;
    readonly deleted: ReadonlyArray<string>;
}) => string;
export {};
