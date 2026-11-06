/**
 * Write flow declaration and portable handler.
 *
 * @since 1.0.0
 */
import * as Path from "@smthrs/kernel/Path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as StdError from "./StdError.vibe";
/**
 * Registry name for the write flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const name = "write";
/**
 * Model-facing description of the write flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export declare const description = "Write UTF-8 text to a path, replacing any existing file; parent directories are created. Prefer edit for targeted changes.";
/**
 * Input schema for the write flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
    readonly path: Schema.String;
    readonly content: Schema.String;
}>;
/**
 * Decoded input accepted by the `write` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * Output schema for the write flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Output: Schema.Struct<{
    readonly path: Schema.String;
    readonly bytesWritten: Schema.Number;
    readonly created: Schema.Boolean;
}>;
/**
 * Decoded output returned by the `write` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type;
/**
 * Static conservative effect envelope for the write flow.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effects: import("@smthrs/plan/Effects").Declaration;
/**
 * Narrows the write effect envelope to one input path.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effectsFor: (input: typeof Input.Type) => import("@smthrs/plan/Effects").Declaration;
/**
 * Capabilities required by the write flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: string[];
/**
 * Declaration-only write flow.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
    readonly name: "write";
    readonly description: "Write UTF-8 text to a path, replacing any existing file; parent directories are created. Prefer edit for targeted changes.";
    readonly input: Schema.Struct<{
        readonly path: Schema.String;
        readonly content: Schema.String;
    }>;
    readonly output: Schema.Struct<{
        readonly path: Schema.String;
        readonly bytesWritten: Schema.Number;
        readonly created: Schema.Boolean;
    }>;
    readonly capabilities: string[];
    readonly effects: import("@smthrs/plan/Effects").Declaration;
};
/**
 * What a call to this flow does, for a reader of a run.
 *
 * Display metadata only. `@smthrs/registry` `Descriptor.FlowActivity` is the
 * governing vocabulary and `StandardFlows` binds this value onto the flow's
 * descriptor, where the binding site checks it. `declarationDigest` excludes
 * it, so declaring it cannot invalidate a call identity or a cached prompt.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export declare const activity: "writes";
/**
 * How one recorded call to this flow reads: the verb for each settlement, the
 * input field that is its subject, and the measured output fields a one-line
 * summary may count.
 *
 * Display metadata only, governed by `@smthrs/registry`
 * `Descriptor.CallPresentation` and checked where `StandardFlows` binds it.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export declare const presentation: {
    readonly verb: {
        readonly pending: "writing";
        readonly success: "wrote";
        readonly failure: "failed to write";
    };
    readonly subject: "path";
    readonly result: "write";
};
/**
 * Replaces a file's contents through the permission-aware kernel filesystem.
 *
 * @category handlers
 * @since 1.0.0
 */
export declare const run: (input: {
    readonly path: string;
    readonly content: string;
}) => Effect.Effect<typeof Output.Type, StdError.StdError, FileSystem.FileSystem | Path.Path>;
