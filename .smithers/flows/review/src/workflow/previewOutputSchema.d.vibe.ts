import * as Schema from "effect/Schema";
/**
 * The whole change set before any seat is asked: every file, with the totals
 * the walkthrough header and the run summary both read.
 *
 * @since 1.0.0
 * @category schemas
 */
export declare const PreviewOutput: Schema.Struct<{
    readonly entries: Schema.mutable<Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly status: Schema.String;
        readonly insertions: Schema.Number;
        readonly deletions: Schema.Number;
        readonly willReview: Schema.Boolean;
        readonly excludeReason: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.String>, never>;
    }>>>;
    readonly totalInsertions: Schema.Number;
    readonly totalDeletions: Schema.Number;
    readonly totalFiles: Schema.Number;
    readonly reviewableCount: Schema.Number;
    readonly excludedCount: Schema.Number;
}>;
/**
 * A decoded preview.
 *
 * @since 1.0.0
 * @category models
 */
export type PreviewOutput = typeof PreviewOutput.Type;
