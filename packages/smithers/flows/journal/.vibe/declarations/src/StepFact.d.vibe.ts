/** Durable observations owned by an agent checkpoint action.
 * @since 1.0.0
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
/** Invocation and retry coordinates remain distinct across replay.
 * @category schemas
 * @since 1.0.0
 */
export declare const Step: Schema.Struct<{
    readonly stepId: Schema.String;
    readonly executionId: Schema.String;
    readonly action: Schema.String;
    readonly attempt: Schema.Int;
    readonly ask: Schema.Union<readonly [Schema.Int, Schema.Literal<"repair">]>;
    readonly retry: Schema.Int;
    readonly scope: Schema.String;
}>;
/** Decoded invocation coordinates.
 * @category models
 * @since 1.0.0
 */
export type Step = typeof Step.Type;
/** The first recorded observation, including its original generation and time.
 * @category schemas
 * @since 1.0.0
 */
export declare const Fact: Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly step: Schema.Struct<{
        readonly stepId: Schema.String;
        readonly executionId: Schema.String;
        readonly action: Schema.String;
        readonly attempt: Schema.Int;
        readonly ask: Schema.Union<readonly [Schema.Int, Schema.Literal<"repair">]>;
        readonly retry: Schema.Int;
        readonly scope: Schema.String;
    }>;
    readonly generation: Schema.Int;
    readonly frame: Schema.Int;
    readonly ordinal: Schema.Int;
    readonly cell: Schema.String;
    readonly at: Schema.Number;
    readonly eventType: Schema.String;
    readonly sourceSequence: Schema.Int;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>;
/** Decoded checkpoint observation.
 * @category models
 * @since 1.0.0
 */
export type Fact = typeof Fact.Type;
declare const Annotation_base: Context.ServiceClass<Annotation, "@smthrs/journal/StepFact/Annotation", {}>;
/** Marks a checkpoint whose saved success is the fact to publish.
 * @category services
 * @since 1.0.0
 */
export declare class Annotation extends Annotation_base {
}
/** Native outbox event, committed with its owning checkpoint.
 * @category events
 * @since 1.0.0
 */
export declare const eventType = "flows.harness.step-fact.v1";
export {};
