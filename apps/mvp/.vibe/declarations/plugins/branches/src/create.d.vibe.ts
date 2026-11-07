import { Action, Flow } from "@smthrs/flow";
import { Schema } from "effect";
declare const _default: Flow.Flow<"branches/create", Schema.Struct<{
    ref: Schema.String;
}>, Schema.Unknown, Schema.Never, Action.Requirement<"branches/ephemeral">>;
export default _default;
