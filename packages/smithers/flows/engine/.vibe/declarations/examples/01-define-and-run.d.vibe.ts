import { Action, Flow } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
export declare const Greet: Action.Declared<"examples/Greet", Schema.Struct<{
    name: Schema.String;
}>, Schema.String, Schema.Never, Action.Requirement<"examples/Greet">>;
export declare const Greeting: Flow.Flow<"examples/Greeting", Schema.Struct<{
    name: Schema.String;
}>, Schema.String, Schema.Never, Action.Requirement<"examples/Greet">>;
/**
 * Runs the flow under a caller-selected execution ID. Without this option or
 * an `idempotencyKey`, the default source mints a fresh UUID for each call.
 * Retain the id to reattach to the same execution.
 */
export declare const main: Effect.Effect<string>;
