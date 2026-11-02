import * as Schema from "effect/Schema";
/**
 * One file the fan-out will review, carrying the diff and the built prompt so
 * a later round never re-reads a working tree that may have moved.
 *
 * @since 1.0.0
 * @category schemas
 */
export declare const NativeReviewFile: Schema.Struct<{
    readonly id: Schema.String;
    readonly path: Schema.String;
    readonly status: Schema.String;
    readonly insertions: Schema.Number;
    readonly deletions: Schema.Number;
    readonly diff: Schema.String;
    readonly prompt: Schema.String;
}>;
/**
 * A decoded reviewable file.
 *
 * @since 1.0.0
 * @category models
 */
export type NativeReviewFile = typeof NativeReviewFile.Type;
