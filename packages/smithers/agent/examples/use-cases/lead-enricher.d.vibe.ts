/**
 * Normalize an inbound lead, enrich it, profile it, and write one CRM record.
 *
 * Port of the 0.x `lead-enricher.jsx`. Four steps run in sequence: an intake
 * step normalizes the raw lead, an enrichment agent researches the company, a
 * profiler agent scores the segment and ICP fit from both, and a CRM step
 * writes the record. There is no branch or loop.
 *
 * 0.x's `intake` and `crm-output` tasks had a prompt but no agent, so they settled with the prompt element and only passed under mocks; here they are agent steps over the same props.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The normalized lead. */
export declare const Intake: Schema.Struct<{
    readonly leadId: Schema.String;
    readonly company: Schema.String;
    readonly contactName: Schema.String;
    readonly contactEmail: Schema.String;
    readonly source: Schema.Literals<readonly ["inbound-form", "webinar", "referral", "cold-outbound", "marketplace", "other"]>;
    readonly rawNotes: Schema.String;
    readonly summary: Schema.String;
}>;
/** What the enrichment agent found about the company. */
export declare const Enrichment: Schema.Struct<{
    readonly firmographics: Schema.Struct<{
        readonly industry: Schema.String;
        readonly employeeCount: Schema.Number;
        readonly annualRevenue: Schema.optional<Schema.String>;
        readonly hqLocation: Schema.String;
        readonly fundingStage: Schema.optional<Schema.String>;
    }>;
    readonly techStack: Schema.$Array<Schema.String>;
    readonly recentNews: Schema.$Array<Schema.Struct<{
        readonly headline: Schema.String;
        readonly relevance: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    readonly competitors: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** The profiler's scored profile. */
export declare const Profile: Schema.Struct<{
    readonly segment: Schema.Literals<readonly ["startup", "smb", "mid-market", "enterprise"]>;
    readonly icpFit: Schema.Number;
    readonly buyerPersona: Schema.String;
    readonly painPoints: Schema.$Array<Schema.String>;
    readonly recommendedPlaybook: Schema.String;
    readonly talkingPoints: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** The CRM record the flow settles with. */
export declare const CrmRecord: Schema.Struct<{
    readonly leadId: Schema.String;
    readonly company: Schema.String;
    readonly segment: Schema.Literals<readonly ["startup", "smb", "mid-market", "enterprise"]>;
    readonly icpFit: Schema.Number;
    readonly owner: Schema.String;
    readonly nextAction: Schema.String;
    readonly status: Schema.Literals<readonly ["new", "enriched", "qualified", "disqualified", "routed"]>;
    readonly profileSummary: Schema.String;
    readonly summary: Schema.String;
}>;
/** Normalizes the raw lead. */
export declare const NormalizeLead: AgentAction.AgentAction<"examples/LeadEnricher/Intake", Schema.Struct<{
    lead: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    source: Schema.String;
}>, Schema.Struct<{
    readonly leadId: Schema.String;
    readonly company: Schema.String;
    readonly contactName: Schema.String;
    readonly contactEmail: Schema.String;
    readonly source: Schema.Literals<readonly ["inbound-form", "webinar", "referral", "cold-outbound", "marketplace", "other"]>;
    readonly rawNotes: Schema.String;
    readonly summary: Schema.String;
}>>;
/** Researches the lead's company. */
export declare const Enrich: AgentAction.AgentAction<"examples/LeadEnricher/Enrich", Schema.Struct<{
    company: Schema.String;
    contactEmail: Schema.String;
    rawNotes: Schema.String;
}>, Schema.Struct<{
    readonly firmographics: Schema.Struct<{
        readonly industry: Schema.String;
        readonly employeeCount: Schema.Number;
        readonly annualRevenue: Schema.optional<Schema.String>;
        readonly hqLocation: Schema.String;
        readonly fundingStage: Schema.optional<Schema.String>;
    }>;
    readonly techStack: Schema.$Array<Schema.String>;
    readonly recentNews: Schema.$Array<Schema.Struct<{
        readonly headline: Schema.String;
        readonly relevance: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    readonly competitors: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Scores the lead from its intake and enrichment. */
export declare const ProfileLead: AgentAction.AgentAction<"examples/LeadEnricher/Profile", Schema.Struct<{
    intake: Schema.Struct<{
        readonly leadId: Schema.String;
        readonly company: Schema.String;
        readonly contactName: Schema.String;
        readonly contactEmail: Schema.String;
        readonly source: Schema.Literals<readonly ["inbound-form", "webinar", "referral", "cold-outbound", "marketplace", "other"]>;
        readonly rawNotes: Schema.String;
        readonly summary: Schema.String;
    }>;
    firmographics: Schema.Struct<{
        readonly industry: Schema.String;
        readonly employeeCount: Schema.Number;
        readonly annualRevenue: Schema.optional<Schema.String>;
        readonly hqLocation: Schema.String;
        readonly fundingStage: Schema.optional<Schema.String>;
    }>;
    techStack: Schema.$Array<Schema.String>;
    recentNews: Schema.$Array<Schema.Struct<{
        readonly headline: Schema.String;
        readonly relevance: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
}>, Schema.Struct<{
    readonly segment: Schema.Literals<readonly ["startup", "smb", "mid-market", "enterprise"]>;
    readonly icpFit: Schema.Number;
    readonly buyerPersona: Schema.String;
    readonly painPoints: Schema.$Array<Schema.String>;
    readonly recommendedPlaybook: Schema.String;
    readonly talkingPoints: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Writes the CRM record from the profile. */
export declare const WriteCrmRecord: AgentAction.AgentAction<"examples/LeadEnricher/CrmOutput", Schema.Struct<{
    leadId: Schema.String;
    company: Schema.String;
    segment: Schema.Literals<readonly ["startup", "smb", "mid-market", "enterprise"]>;
    icpFit: Schema.Number;
    recommendedPlaybook: Schema.String;
    painPoints: Schema.$Array<Schema.String>;
    talkingPoints: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly leadId: Schema.String;
    readonly company: Schema.String;
    readonly segment: Schema.Literals<readonly ["startup", "smb", "mid-market", "enterprise"]>;
    readonly icpFit: Schema.Number;
    readonly owner: Schema.String;
    readonly nextAction: Schema.String;
    readonly status: Schema.Literals<readonly ["new", "enriched", "qualified", "disqualified", "routed"]>;
    readonly profileSummary: Schema.String;
    readonly summary: Schema.String;
}>>;
/** The flow: intake, enrich, profile, CRM record. */
export declare const LeadEnricher: Flow.Flow<"examples/LeadEnricher", Schema.Struct<{
    lead: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    source: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly leadId: Schema.String;
    readonly company: Schema.String;
    readonly segment: Schema.Literals<readonly ["startup", "smb", "mid-market", "enterprise"]>;
    readonly icpFit: Schema.Number;
    readonly owner: Schema.String;
    readonly nextAction: Schema.String;
    readonly status: Schema.Literals<readonly ["new", "enriched", "qualified", "disqualified", "routed"]>;
    readonly profileSummary: Schema.String;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/LeadEnricher/CrmOutput"> | import("@smthrs/flow/Action").Requirement<"examples/LeadEnricher/Enrich"> | import("@smthrs/flow/Action").Requirement<"examples/LeadEnricher/Intake"> | import("@smthrs/flow/Action").Requirement<"examples/LeadEnricher/Profile">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/LeadEnricher/CrmOutput"> | import("@smthrs/flow/Action").Requirement<"examples/LeadEnricher/Enrich"> | import("@smthrs/flow/Action").Requirement<"examples/LeadEnricher/Intake"> | import("@smthrs/flow/Action").Requirement<"examples/LeadEnricher/Profile">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
