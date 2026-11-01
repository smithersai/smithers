/**
 * Compress build and deploy logs into root-cause hypotheses, a likely owner, and next commands to run.
 *
 * Port of the 0.x `log-digest.jsx`. A collector agent gathers the logs at the
 * given paths and from the given commands and extracts the error lines, the
 * warning lines and the last `tailLines` lines (default 100). A root-cause
 * analyst agent reads that collection and returns ranked hypotheses, the
 * likely owning team and the next commands to run. Nothing branches or loops.
 *
 * 0.x's two prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** What the collector gathered. */
export declare const CollectedLogs: Schema.Struct<{
    readonly source: Schema.String;
    readonly lineCount: Schema.Number;
    readonly errorLines: Schema.$Array<Schema.String>;
    readonly warningLines: Schema.$Array<Schema.String>;
    readonly rawTail: Schema.String;
}>;
/** The digest the flow settles with. */
export declare const Digest: Schema.Struct<{
    readonly rootCauseHypotheses: Schema.$Array<Schema.Struct<{
        readonly hypothesis: Schema.String;
        readonly confidence: Schema.Literals<readonly ["high", "medium", "low"]>;
        readonly evidence: Schema.$Array<Schema.String>;
    }>>;
    readonly likelyOwner: Schema.Struct<{
        readonly team: Schema.String;
        readonly reasoning: Schema.String;
    }>;
    readonly nextCommands: Schema.$Array<Schema.Struct<{
        readonly command: Schema.String;
        readonly purpose: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>;
/** Gathers the logs and pulls out the lines that matter. */
export declare const Collect: AgentAction.AgentAction<"examples/LogDigest/Collect", Schema.Struct<{
    logPaths: Schema.$Array<Schema.String>;
    commands: Schema.$Array<Schema.String>;
    tailLines: Schema.Number;
}>, Schema.Struct<{
    readonly source: Schema.String;
    readonly lineCount: Schema.Number;
    readonly errorLines: Schema.$Array<Schema.String>;
    readonly warningLines: Schema.$Array<Schema.String>;
    readonly rawTail: Schema.String;
}>>;
/** Turns the collection into hypotheses, an owner and next commands. */
export declare const Summarize: AgentAction.AgentAction<"examples/LogDigest/Summarize", Schema.Struct<{
    readonly source: Schema.String;
    readonly lineCount: Schema.Number;
    readonly errorLines: Schema.$Array<Schema.String>;
    readonly warningLines: Schema.$Array<Schema.String>;
    readonly rawTail: Schema.String;
}>, Schema.Struct<{
    readonly rootCauseHypotheses: Schema.$Array<Schema.Struct<{
        readonly hypothesis: Schema.String;
        readonly confidence: Schema.Literals<readonly ["high", "medium", "low"]>;
        readonly evidence: Schema.$Array<Schema.String>;
    }>>;
    readonly likelyOwner: Schema.Struct<{
        readonly team: Schema.String;
        readonly reasoning: Schema.String;
    }>;
    readonly nextCommands: Schema.$Array<Schema.Struct<{
        readonly command: Schema.String;
        readonly purpose: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>>;
/** The flow: collect, then summarize. */
export declare const LogDigest: Flow.Flow<"examples/LogDigest", Schema.Struct<{
    logPaths: Schema.optional<Schema.$Array<Schema.String>>;
    commands: Schema.optional<Schema.$Array<Schema.String>>;
    tailLines: Schema.optional<Schema.Int>;
}>, Schema.Struct<{
    readonly rootCauseHypotheses: Schema.$Array<Schema.Struct<{
        readonly hypothesis: Schema.String;
        readonly confidence: Schema.Literals<readonly ["high", "medium", "low"]>;
        readonly evidence: Schema.$Array<Schema.String>;
    }>>;
    readonly likelyOwner: Schema.Struct<{
        readonly team: Schema.String;
        readonly reasoning: Schema.String;
    }>;
    readonly nextCommands: Schema.$Array<Schema.Struct<{
        readonly command: Schema.String;
        readonly purpose: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/LogDigest/Collect"> | import("@smthrs/flow/Action").Requirement<"examples/LogDigest/Summarize">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/LogDigest/Collect"> | import("@smthrs/flow/Action").Requirement<"examples/LogDigest/Summarize">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
