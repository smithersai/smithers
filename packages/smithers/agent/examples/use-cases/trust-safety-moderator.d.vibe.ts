/**
 * Screen content against policy and approve, modify, reject, or escalate it for human review.
 *
 * Port of the 0.x `trust-safety-moderator.jsx`. An intake step normalizes the
 * content and its metadata, a moderator agent classifies its risk level and
 * policy class and flags violating segments, and an action agent decides what
 * happens to it. The three steps run in sequence with no branch; escalating an
 * edge case to people is one of the action agent's four decisions.
 *
 * 0.x gave `intake` no agent, so it persisted its prompt element as a static output that fails its schema; here it is a model step with no system prompt.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The content, normalized. */
export declare const Intake: Schema.Struct<{
    readonly contentId: Schema.String;
    readonly contentType: Schema.Literals<readonly ["text", "image_url", "structured", "mixed"]>;
    readonly rawText: Schema.String;
    readonly metadata: Schema.Struct<{
        readonly source: Schema.String;
        readonly authorId: Schema.optional<Schema.String>;
        readonly timestamp: Schema.optional<Schema.String>;
    }>;
}>;
/** The moderator's classification. */
export declare const Moderation: Schema.Struct<{
    readonly contentId: Schema.String;
    readonly riskLevel: Schema.Literals<readonly ["allow", "low", "medium", "high", "block"]>;
    readonly policyClass: Schema.Literals<readonly ["safe", "harassment", "hate_speech", "violence", "sexual_content", "self_harm", "pii_leak", "misinformation", "spam", "copyright", "other"]>;
    readonly confidence: Schema.Number;
    readonly reasoning: Schema.String;
    readonly flaggedSegments: Schema.$Array<Schema.Struct<{
        readonly text: Schema.String;
        readonly policy: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    readonly needsHumanReview: Schema.Boolean;
}>;
/** The decision the flow settles with. */
export declare const Decision: Schema.Struct<{
    readonly contentId: Schema.String;
    readonly decision: Schema.Literals<readonly ["approved", "modified", "rejected", "escalated"]>;
    readonly action: Schema.String;
    readonly moderatedContent: Schema.optional<Schema.String>;
    readonly escalationReason: Schema.optional<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Normalizes the content and extracts its metadata. */
export declare const IntakeContent: AgentAction.AgentAction<"examples/TrustSafetyModerator/Intake", Schema.Struct<{
    content: Schema.String;
    source: Schema.String;
    authorId: Schema.String;
}>, Schema.Struct<{
    readonly contentId: Schema.String;
    readonly contentType: Schema.Literals<readonly ["text", "image_url", "structured", "mixed"]>;
    readonly rawText: Schema.String;
    readonly metadata: Schema.Struct<{
        readonly source: Schema.String;
        readonly authorId: Schema.optional<Schema.String>;
        readonly timestamp: Schema.optional<Schema.String>;
    }>;
}>>;
/** Classifies risk and policy. */
export declare const Moderate: AgentAction.AgentAction<"examples/TrustSafetyModerator/Moderate", Schema.Struct<{
    contentId: Schema.String;
    contentType: Schema.Literals<readonly ["text", "image_url", "structured", "mixed"]>;
    rawText: Schema.String;
    policies: Schema.String;
}>, Schema.Struct<{
    readonly contentId: Schema.String;
    readonly riskLevel: Schema.Literals<readonly ["allow", "low", "medium", "high", "block"]>;
    readonly policyClass: Schema.Literals<readonly ["safe", "harassment", "hate_speech", "violence", "sexual_content", "self_harm", "pii_leak", "misinformation", "spam", "copyright", "other"]>;
    readonly confidence: Schema.Number;
    readonly reasoning: Schema.String;
    readonly flaggedSegments: Schema.$Array<Schema.Struct<{
        readonly text: Schema.String;
        readonly policy: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    readonly needsHumanReview: Schema.Boolean;
}>>;
/** Applies the policy action or escalates. */
export declare const Act: AgentAction.AgentAction<"examples/TrustSafetyModerator/Action", Schema.Struct<{
    contentId: Schema.String;
    riskLevel: Schema.Literals<readonly ["allow", "low", "medium", "high", "block"]>;
    policyClass: Schema.Literals<readonly ["safe", "harassment", "hate_speech", "violence", "sexual_content", "self_harm", "pii_leak", "misinformation", "spam", "copyright", "other"]>;
    confidence: Schema.Number;
    reasoning: Schema.String;
    flaggedSegments: Schema.$Array<Schema.Struct<{
        readonly text: Schema.String;
        readonly policy: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    needsHumanReview: Schema.Boolean;
    rawText: Schema.String;
}>, Schema.Struct<{
    readonly contentId: Schema.String;
    readonly decision: Schema.Literals<readonly ["approved", "modified", "rejected", "escalated"]>;
    readonly action: Schema.String;
    readonly moderatedContent: Schema.optional<Schema.String>;
    readonly escalationReason: Schema.optional<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** The flow: intake, moderate, act. */
export declare const TrustSafetyModerator: Flow.Flow<"examples/TrustSafetyModerator", Schema.Struct<{
    content: Schema.optional<Schema.String>;
    source: Schema.optional<Schema.String>;
    authorId: Schema.optional<Schema.String>;
    policies: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly contentId: Schema.String;
    readonly decision: Schema.Literals<readonly ["approved", "modified", "rejected", "escalated"]>;
    readonly action: Schema.String;
    readonly moderatedContent: Schema.optional<Schema.String>;
    readonly escalationReason: Schema.optional<Schema.String>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/TrustSafetyModerator/Action"> | import("@smthrs/flow/Action").Requirement<"examples/TrustSafetyModerator/Intake"> | import("@smthrs/flow/Action").Requirement<"examples/TrustSafetyModerator/Moderate">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/TrustSafetyModerator/Action"> | import("@smthrs/flow/Action").Requirement<"examples/TrustSafetyModerator/Intake"> | import("@smthrs/flow/Action").Requirement<"examples/TrustSafetyModerator/Moderate">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
