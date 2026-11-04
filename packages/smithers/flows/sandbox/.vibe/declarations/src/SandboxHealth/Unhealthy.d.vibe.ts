/**
 * Defines the unhealthy sandbox state.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const Unhealthy_base: Schema.Class<Unhealthy, Schema.Struct<{
    readonly _tag: Schema.tag<"Unhealthy">;
    readonly component: Schema.Literal<"sandbox">;
    readonly reason: Schema.Literals<readonly ["unresponsive", "ping_failed"]>;
    readonly message: Schema.optional<Schema.String>;
}>, {}>;
/**
 * The sandbox did not prove liveness because its ping failed or never
 * answered.
 *
 * @category models
 * @since 0.1.0
 */
export declare class Unhealthy extends Unhealthy_base {
}
export {};
