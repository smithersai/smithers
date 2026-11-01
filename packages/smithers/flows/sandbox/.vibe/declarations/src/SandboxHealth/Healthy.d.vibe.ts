/**
 * Defines the healthy sandbox state.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const Healthy_base: Schema.Class<Healthy, Schema.Struct<{
    readonly _tag: Schema.tag<"Healthy">;
}>, {}>;
/**
 * The sandbox answered its ping within the deadline.
 *
 * @category models
 * @since 0.1.0
 */
export declare class Healthy extends Healthy_base {
}
export {};
