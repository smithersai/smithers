/**
 * Answer a questionnaire from source material with typed, cited answers, then audit them for consistency.
 *
 * Port of the 0.x `survey-answerer-agent.jsx`. A gatherer agent indexes the
 * sources against the questions, an answer agent answers every question from
 * that context or marks it unanswered, and an auditor agent checks the answers
 * for contradictions and unsupported claims and proposes revisions. It is one
 * pass with no loop: the audit's revisions are reported, not applied.
 *
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts written from the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The sources, indexed by topic with provenance. */
export declare const SourceContext: Schema.Struct<{
    readonly documentSummaries: Schema.$Array<Schema.Struct<{
        readonly sourceId: Schema.String;
        readonly title: Schema.String;
        readonly relevantExcerpts: Schema.$Array<Schema.String>;
        readonly topics: Schema.$Array<Schema.String>;
    }>>;
    readonly keyFacts: Schema.$Record<Schema.String, Schema.String>;
    readonly summary: Schema.String;
}>;
/** Every answered question with its sources, and every question left unanswered. */
export declare const SurveyAnswers: Schema.Struct<{
    readonly answers: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly questionText: Schema.String;
        readonly answer: Schema.String;
        readonly confidence: Schema.Literals<readonly ["high", "medium", "low"]>;
        readonly sourceRefs: Schema.$Array<Schema.String>;
        readonly reasoning: Schema.String;
    }>>;
    readonly unanswered: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly questionText: Schema.String;
        readonly reason: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>;
/** The audit of the answers. */
export declare const Validation: Schema.Struct<{
    readonly overallConsistency: Schema.Literals<readonly ["pass", "warn", "fail"]>;
    readonly contradictions: Schema.$Array<Schema.Struct<{
        readonly questionIds: Schema.$Array<Schema.String>;
        readonly description: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    readonly unsupportedClaims: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly claim: Schema.String;
        readonly issue: Schema.String;
    }>>;
    readonly revisedAnswers: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly originalAnswer: Schema.String;
        readonly revisedAnswer: Schema.String;
        readonly reason: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>;
/** What the flow settles with: the answers and their audit. */
export declare const Output: Schema.Struct<{
    readonly answers: Schema.Struct<{
        readonly answers: Schema.$Array<Schema.Struct<{
            readonly questionId: Schema.String;
            readonly questionText: Schema.String;
            readonly answer: Schema.String;
            readonly confidence: Schema.Literals<readonly ["high", "medium", "low"]>;
            readonly sourceRefs: Schema.$Array<Schema.String>;
            readonly reasoning: Schema.String;
        }>>;
        readonly unanswered: Schema.$Array<Schema.Struct<{
            readonly questionId: Schema.String;
            readonly questionText: Schema.String;
            readonly reason: Schema.String;
        }>>;
        readonly summary: Schema.String;
    }>;
    readonly validation: Schema.Struct<{
        readonly overallConsistency: Schema.Literals<readonly ["pass", "warn", "fail"]>;
        readonly contradictions: Schema.$Array<Schema.Struct<{
            readonly questionIds: Schema.$Array<Schema.String>;
            readonly description: Schema.String;
            readonly severity: Schema.Literals<readonly ["low", "medium", "high"]>;
        }>>;
        readonly unsupportedClaims: Schema.$Array<Schema.Struct<{
            readonly questionId: Schema.String;
            readonly claim: Schema.String;
            readonly issue: Schema.String;
        }>>;
        readonly revisedAnswers: Schema.$Array<Schema.Struct<{
            readonly questionId: Schema.String;
            readonly originalAnswer: Schema.String;
            readonly revisedAnswer: Schema.String;
            readonly reason: Schema.String;
        }>>;
        readonly summary: Schema.String;
    }>;
}>;
/** Indexes the sources against the questions. */
export declare const GatherContext: AgentAction.AgentAction<"examples/SurveyAnswererAgent/GatherContext", Schema.Struct<{
    sources: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    questions: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly documentSummaries: Schema.$Array<Schema.Struct<{
        readonly sourceId: Schema.String;
        readonly title: Schema.String;
        readonly relevantExcerpts: Schema.$Array<Schema.String>;
        readonly topics: Schema.$Array<Schema.String>;
    }>>;
    readonly keyFacts: Schema.$Record<Schema.String, Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Answers every question from the gathered context. */
export declare const GenerateAnswers: AgentAction.AgentAction<"examples/SurveyAnswererAgent/GenerateAnswers", Schema.Struct<{
    questions: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    documentSummaries: Schema.$Array<Schema.Struct<{
        readonly sourceId: Schema.String;
        readonly title: Schema.String;
        readonly relevantExcerpts: Schema.$Array<Schema.String>;
        readonly topics: Schema.$Array<Schema.String>;
    }>>;
    keyFacts: Schema.$Record<Schema.String, Schema.String>;
}>, Schema.Struct<{
    readonly answers: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly questionText: Schema.String;
        readonly answer: Schema.String;
        readonly confidence: Schema.Literals<readonly ["high", "medium", "low"]>;
        readonly sourceRefs: Schema.$Array<Schema.String>;
        readonly reasoning: Schema.String;
    }>>;
    readonly unanswered: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly questionText: Schema.String;
        readonly reason: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>>;
/** Audits the answers against each other and the sources. */
export declare const Validate: AgentAction.AgentAction<"examples/SurveyAnswererAgent/Validate", Schema.Struct<{
    answers: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly questionText: Schema.String;
        readonly answer: Schema.String;
        readonly confidence: Schema.Literals<readonly ["high", "medium", "low"]>;
        readonly sourceRefs: Schema.$Array<Schema.String>;
        readonly reasoning: Schema.String;
    }>>;
    unanswered: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly questionText: Schema.String;
        readonly reason: Schema.String;
    }>>;
    keyFacts: Schema.$Record<Schema.String, Schema.String>;
    documentSummaries: Schema.$Array<Schema.Struct<{
        readonly sourceId: Schema.String;
        readonly title: Schema.String;
        readonly relevantExcerpts: Schema.$Array<Schema.String>;
        readonly topics: Schema.$Array<Schema.String>;
    }>>;
}>, Schema.Struct<{
    readonly overallConsistency: Schema.Literals<readonly ["pass", "warn", "fail"]>;
    readonly contradictions: Schema.$Array<Schema.Struct<{
        readonly questionIds: Schema.$Array<Schema.String>;
        readonly description: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    readonly unsupportedClaims: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly claim: Schema.String;
        readonly issue: Schema.String;
    }>>;
    readonly revisedAnswers: Schema.$Array<Schema.Struct<{
        readonly questionId: Schema.String;
        readonly originalAnswer: Schema.String;
        readonly revisedAnswer: Schema.String;
        readonly reason: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>>;
/** The flow: gather, answer, audit. */
export declare const SurveyAnswererAgent: Flow.Flow<"examples/SurveyAnswererAgent", Schema.Struct<{
    sources: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    questions: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
}>, Schema.Struct<{
    readonly answers: Schema.Struct<{
        readonly answers: Schema.$Array<Schema.Struct<{
            readonly questionId: Schema.String;
            readonly questionText: Schema.String;
            readonly answer: Schema.String;
            readonly confidence: Schema.Literals<readonly ["high", "medium", "low"]>;
            readonly sourceRefs: Schema.$Array<Schema.String>;
            readonly reasoning: Schema.String;
        }>>;
        readonly unanswered: Schema.$Array<Schema.Struct<{
            readonly questionId: Schema.String;
            readonly questionText: Schema.String;
            readonly reason: Schema.String;
        }>>;
        readonly summary: Schema.String;
    }>;
    readonly validation: Schema.Struct<{
        readonly overallConsistency: Schema.Literals<readonly ["pass", "warn", "fail"]>;
        readonly contradictions: Schema.$Array<Schema.Struct<{
            readonly questionIds: Schema.$Array<Schema.String>;
            readonly description: Schema.String;
            readonly severity: Schema.Literals<readonly ["low", "medium", "high"]>;
        }>>;
        readonly unsupportedClaims: Schema.$Array<Schema.Struct<{
            readonly questionId: Schema.String;
            readonly claim: Schema.String;
            readonly issue: Schema.String;
        }>>;
        readonly revisedAnswers: Schema.$Array<Schema.Struct<{
            readonly questionId: Schema.String;
            readonly originalAnswer: Schema.String;
            readonly revisedAnswer: Schema.String;
            readonly reason: Schema.String;
        }>>;
        readonly summary: Schema.String;
    }>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/SurveyAnswererAgent/GatherContext"> | import("@smthrs/flow/Action").Requirement<"examples/SurveyAnswererAgent/GenerateAnswers"> | import("@smthrs/flow/Action").Requirement<"examples/SurveyAnswererAgent/Validate">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/SurveyAnswererAgent/GatherContext"> | import("@smthrs/flow/Action").Requirement<"examples/SurveyAnswererAgent/GenerateAnswers"> | import("@smthrs/flow/Action").Requirement<"examples/SurveyAnswererAgent/Validate">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
