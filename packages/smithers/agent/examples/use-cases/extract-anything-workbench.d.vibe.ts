/**
 * Run candidate extractors over one input in parallel, validate each candidate, and pick the one to adopt.
 *
 * Port of the 0.x `extract-anything-workbench.jsx`. One extractor agent call
 * per named extractor (default `["auto"]`) runs over the same input and
 * target schema, all at once. Once every candidate is in, a validator agent
 * checks each one against the target schema, all at once. A preview agent
 * then compares the validated candidates, picks one, and recommends whether to
 * use, refine or discard it.
 *
 * 0.x's extract, validate and preview prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the extractor `read`, `bash` and `grep`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One extractor's attempt. */
export declare const Candidate: Schema.Struct<{
    readonly extractorName: Schema.String;
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly value: Schema.String;
        readonly confidence: Schema.Number;
    }>>;
    readonly rawOutput: Schema.String;
    readonly overallConfidence: Schema.Number;
}>;
/** The validator's verdict on one candidate. */
export declare const Validation: Schema.Struct<{
    readonly extractorName: Schema.String;
    readonly isValid: Schema.Boolean;
    readonly errors: Schema.$Array<Schema.String>;
    readonly warnings: Schema.$Array<Schema.String>;
    readonly fieldCount: Schema.Number;
    readonly confidenceScore: Schema.Number;
}>;
/** The pick the flow settles with. */
export declare const Preview: Schema.Struct<{
    readonly selectedExtractor: Schema.NullOr<Schema.String>;
    readonly extractedData: Schema.NullOr<Schema.$Record<Schema.String, Schema.String>>;
    readonly summary: Schema.String;
    readonly recommendation: Schema.Literals<readonly ["use", "refine", "discard"]>;
}>;
/** One extractor's run over the input. */
export declare const Extract: AgentAction.AgentAction<"examples/ExtractAnythingWorkbench/Extract", Schema.Struct<{
    extractorName: Schema.String;
    input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    targetSchema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.Struct<{
    readonly extractorName: Schema.String;
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly value: Schema.String;
        readonly confidence: Schema.Number;
    }>>;
    readonly rawOutput: Schema.String;
    readonly overallConfidence: Schema.Number;
}>>;
/** Checks one candidate against the target schema. */
export declare const Validate: AgentAction.AgentAction<"examples/ExtractAnythingWorkbench/Validate", Schema.Struct<{
    candidate: Schema.Struct<{
        readonly extractorName: Schema.String;
        readonly fields: Schema.$Array<Schema.Struct<{
            readonly key: Schema.String;
            readonly value: Schema.String;
            readonly confidence: Schema.Number;
        }>>;
        readonly rawOutput: Schema.String;
        readonly overallConfidence: Schema.Number;
    }>;
    targetSchema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.Struct<{
    readonly extractorName: Schema.String;
    readonly isValid: Schema.Boolean;
    readonly errors: Schema.$Array<Schema.String>;
    readonly warnings: Schema.$Array<Schema.String>;
    readonly fieldCount: Schema.Number;
    readonly confidenceScore: Schema.Number;
}>>;
/** Compares the validated candidates and picks one. */
export declare const PreviewStep: AgentAction.AgentAction<"examples/ExtractAnythingWorkbench/Preview", Schema.Struct<{
    validations: Schema.$Array<Schema.Struct<{
        readonly extractorName: Schema.String;
        readonly isValid: Schema.Boolean;
        readonly errors: Schema.$Array<Schema.String>;
        readonly warnings: Schema.$Array<Schema.String>;
        readonly fieldCount: Schema.Number;
        readonly confidenceScore: Schema.Number;
    }>>;
    candidates: Schema.$Array<Schema.Struct<{
        readonly extractorName: Schema.String;
        readonly fields: Schema.$Array<Schema.Struct<{
            readonly key: Schema.String;
            readonly value: Schema.String;
            readonly confidence: Schema.Number;
        }>>;
        readonly rawOutput: Schema.String;
        readonly overallConfidence: Schema.Number;
    }>>;
    input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.Struct<{
    readonly selectedExtractor: Schema.NullOr<Schema.String>;
    readonly extractedData: Schema.NullOr<Schema.$Record<Schema.String, Schema.String>>;
    readonly summary: Schema.String;
    readonly recommendation: Schema.Literals<readonly ["use", "refine", "discard"]>;
}>>;
/**
 * The flow. `extractors` is real at plan time, so it sets how many extractor
 * and validator calls the plan holds.
 */
export declare const ExtractAnythingWorkbench: Flow.Flow<"examples/ExtractAnythingWorkbench", Schema.Struct<{
    input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    targetSchema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    extractors: Schema.optional<Schema.$Array<Schema.String>>;
}>, Schema.Struct<{
    readonly selectedExtractor: Schema.NullOr<Schema.String>;
    readonly extractedData: Schema.NullOr<Schema.$Record<Schema.String, Schema.String>>;
    readonly summary: Schema.String;
    readonly recommendation: Schema.Literals<readonly ["use", "refine", "discard"]>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/ExtractAnythingWorkbench/Extract"> | import("@smthrs/flow/Action").Requirement<"examples/ExtractAnythingWorkbench/Preview"> | import("@smthrs/flow/Action").Requirement<"examples/ExtractAnythingWorkbench/Validate">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/ExtractAnythingWorkbench/Extract"> | import("@smthrs/flow/Action").Requirement<"examples/ExtractAnythingWorkbench/Preview"> | import("@smthrs/flow/Action").Requirement<"examples/ExtractAnythingWorkbench/Validate">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
