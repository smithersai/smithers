import * as Schema from "effect/Schema";
/**
 * Schema for an input file path paired with its measured content digest.
 *
 * The path is workspace-relative like every other declared path in a
 * {@link FileBoundary}: the engine measures reads through the workspace
 * sandbox, which refuses absolute and upward spellings, so a boundary that
 * admitted them here would only be refused later, at prepare or replay.
 * Checking here keeps the boundary this package admits the boundary the
 * engine accepts.
 *
 * @category models
 * @since 0.1.0
 */
export declare const FileInput: Schema.Struct<{
    /** Workspace-relative path of the input file. */
    readonly path: Schema.NonEmptyString;
    /** Non-empty digest observed for the file contents. */
    readonly digest: Schema.NonEmptyString;
}>;
/**
 * An input file path paired with its measured content digest.
 *
 * @category models
 * @since 0.1.0
 */
export type FileInput = typeof FileInput.Type;
