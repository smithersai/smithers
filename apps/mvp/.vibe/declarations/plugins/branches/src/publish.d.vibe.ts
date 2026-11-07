import { Action, Flow } from "@smthrs/flow";
import { Schema } from "effect";
declare const _default: Flow.Flow<"branches/publish", Schema.Struct<{
    title: Schema.String;
    body: Schema.String;
}>, Schema.Unknown, Schema.Never, Action.Requirement<"branches/github-publish">>;
export default _default;
