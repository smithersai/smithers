/**
 * One ordered policy rule: a capability pattern and the decision it applies.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import { CapabilityPattern } from "./Capability.ts";
declare const Rule_base: Schema.Class<Rule, Schema.Struct<{
    readonly effect: Schema.Literals<readonly ["allow", "deny", "ask"]>;
    readonly pattern: Schema.compose<Schema.declare<CapabilityPattern, CapabilityPattern>, typeof CapabilityPattern>;
}>, {}>;
/**
 * A capability pattern and the decision it applies.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare class Rule extends Rule_base {
}
export {};
