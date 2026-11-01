/**
 * Read one finance-mailbox email, classify it, check it for fraud signals, and decide the action and alert for it.
 *
 * Port of the 0.x `financial-inbox-guard.jsx`. An ingest agent normalizes the
 * raw email. A classifier agent (invoice, exception, urgent approval, risky
 * language, informational) and a risk agent (social engineering, spoofing,
 * bank-detail changes) read it in parallel. An extractor agent then pulls
 * invoice fields, told the category, and a routing agent picks the action,
 * assignee, priority and channels to notify from all three answers.
 *
 * The invoice extractor runs for every category, told the category, as it did in 0.x.
 * 0.x declared `ingest` and `route` with prompts but no agent, so they could not produce their schemas; here each is an agent step.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts written from the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The normalized email. */
export declare const Email: Schema.Struct<{
    readonly messageId: Schema.String;
    readonly from: Schema.String;
    readonly subject: Schema.String;
    readonly bodyPreview: Schema.String;
    readonly attachments: Schema.$Array<Schema.String>;
    readonly receivedAt: Schema.String;
}>;
/** What kind of finance email it is. `confidence` is 0 to 100. */
export declare const Classification: Schema.Struct<{
    readonly messageId: Schema.String;
    readonly category: Schema.Literals<readonly ["invoice", "exception", "urgent-approval", "risky-language", "informational"]>;
    readonly confidence: Schema.Number;
    readonly flags: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** The invoice fields the email carries. */
export declare const InvoiceExtract: Schema.Struct<{
    readonly messageId: Schema.String;
    readonly invoiceNumber: Schema.String;
    readonly vendorName: Schema.String;
    readonly amount: Schema.Number;
    readonly currency: Schema.String;
    readonly dueDate: Schema.String;
    readonly lineItems: Schema.$Array<Schema.Struct<{
        readonly description: Schema.String;
        readonly amount: Schema.Number;
    }>>;
    readonly poMatch: Schema.Boolean;
}>;
/** The fraud and risk signals in the email. */
export declare const RiskAssessment: Schema.Struct<{
    readonly messageId: Schema.String;
    readonly riskLevel: Schema.Literals<readonly ["critical", "high", "medium", "low", "none"]>;
    readonly signals: Schema.$Array<Schema.Struct<{
        readonly type: Schema.String;
        readonly evidence: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    }>>;
    readonly recommendation: Schema.String;
}>;
/** The action and alert the flow settles with. */
export declare const RoutingDecision: Schema.Struct<{
    readonly messageId: Schema.String;
    readonly action: Schema.Literals<readonly ["auto-process", "queue-approval", "escalate", "quarantine", "archive"]>;
    readonly assignee: Schema.String;
    readonly priority: Schema.Literals<readonly ["critical", "high", "normal", "low"]>;
    readonly notifyChannels: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Normalizes the raw email. */
export declare const Ingest: AgentAction.AgentAction<"examples/FinancialInboxGuard/Ingest", Schema.Struct<{
    rawEmail: Schema.String;
    mailbox: Schema.String;
}>, Schema.Struct<{
    readonly messageId: Schema.String;
    readonly from: Schema.String;
    readonly subject: Schema.String;
    readonly bodyPreview: Schema.String;
    readonly attachments: Schema.$Array<Schema.String>;
    readonly receivedAt: Schema.String;
}>>;
/** Classifies the email. */
export declare const Classify: AgentAction.AgentAction<"examples/FinancialInboxGuard/Classify", Schema.Struct<{
    email: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly from: Schema.String;
        readonly subject: Schema.String;
        readonly bodyPreview: Schema.String;
        readonly attachments: Schema.$Array<Schema.String>;
        readonly receivedAt: Schema.String;
    }>;
    knownVendors: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    recentExceptions: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly messageId: Schema.String;
    readonly category: Schema.Literals<readonly ["invoice", "exception", "urgent-approval", "risky-language", "informational"]>;
    readonly confidence: Schema.Number;
    readonly flags: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Scans the email for fraud and risk signals. */
export declare const DetectRisk: AgentAction.AgentAction<"examples/FinancialInboxGuard/DetectRisk", Schema.Struct<{
    email: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly from: Schema.String;
        readonly subject: Schema.String;
        readonly bodyPreview: Schema.String;
        readonly attachments: Schema.$Array<Schema.String>;
        readonly receivedAt: Schema.String;
    }>;
    knownDomains: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    recentBankChanges: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly messageId: Schema.String;
    readonly riskLevel: Schema.Literals<readonly ["critical", "high", "medium", "low", "none"]>;
    readonly signals: Schema.$Array<Schema.Struct<{
        readonly type: Schema.String;
        readonly evidence: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    }>>;
    readonly recommendation: Schema.String;
}>>;
/** Pulls the invoice fields, told the email's category. */
export declare const ExtractInvoice: AgentAction.AgentAction<"examples/FinancialInboxGuard/ExtractInvoice", Schema.Struct<{
    email: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly from: Schema.String;
        readonly subject: Schema.String;
        readonly bodyPreview: Schema.String;
        readonly attachments: Schema.$Array<Schema.String>;
        readonly receivedAt: Schema.String;
    }>;
    category: Schema.Literals<readonly ["invoice", "exception", "urgent-approval", "risky-language", "informational"]>;
    openPOs: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly messageId: Schema.String;
    readonly invoiceNumber: Schema.String;
    readonly vendorName: Schema.String;
    readonly amount: Schema.Number;
    readonly currency: Schema.String;
    readonly dueDate: Schema.String;
    readonly lineItems: Schema.$Array<Schema.Struct<{
        readonly description: Schema.String;
        readonly amount: Schema.Number;
    }>>;
    readonly poMatch: Schema.Boolean;
}>>;
/** Picks the action, assignee, priority and channels. */
export declare const Route: AgentAction.AgentAction<"examples/FinancialInboxGuard/Route", Schema.Struct<{
    messageId: Schema.String;
    classification: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly category: Schema.Literals<readonly ["invoice", "exception", "urgent-approval", "risky-language", "informational"]>;
        readonly confidence: Schema.Number;
        readonly flags: Schema.$Array<Schema.String>;
        readonly summary: Schema.String;
    }>;
    risk: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly riskLevel: Schema.Literals<readonly ["critical", "high", "medium", "low", "none"]>;
        readonly signals: Schema.$Array<Schema.Struct<{
            readonly type: Schema.String;
            readonly evidence: Schema.String;
            readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        }>>;
        readonly recommendation: Schema.String;
    }>;
    invoice: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly invoiceNumber: Schema.String;
        readonly vendorName: Schema.String;
        readonly amount: Schema.Number;
        readonly currency: Schema.String;
        readonly dueDate: Schema.String;
        readonly lineItems: Schema.$Array<Schema.Struct<{
            readonly description: Schema.String;
            readonly amount: Schema.Number;
        }>>;
        readonly poMatch: Schema.Boolean;
    }>;
    approvalThreshold: Schema.Number;
    escalationTeam: Schema.String;
    notifyChannels: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly messageId: Schema.String;
    readonly action: Schema.Literals<readonly ["auto-process", "queue-approval", "escalate", "quarantine", "archive"]>;
    readonly assignee: Schema.String;
    readonly priority: Schema.Literals<readonly ["critical", "high", "normal", "low"]>;
    readonly notifyChannels: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** The flow: ingest, classify and assess risk in parallel, extract, route. */
export declare const FinancialInboxGuard: Flow.Flow<"examples/FinancialInboxGuard", Schema.Struct<{
    rawEmail: Schema.String;
    mailbox: Schema.optional<Schema.String>;
    knownVendors: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    recentExceptions: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    knownDomains: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    recentBankChanges: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    openPOs: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    approvalThreshold: Schema.optional<Schema.Number>;
    escalationTeam: Schema.optional<Schema.String>;
    notifyChannels: Schema.optional<Schema.$Array<Schema.String>>;
}>, Schema.Struct<{
    readonly messageId: Schema.String;
    readonly action: Schema.Literals<readonly ["auto-process", "queue-approval", "escalate", "quarantine", "archive"]>;
    readonly assignee: Schema.String;
    readonly priority: Schema.Literals<readonly ["critical", "high", "normal", "low"]>;
    readonly notifyChannels: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/Classify"> | import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/DetectRisk"> | import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/ExtractInvoice"> | import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/Ingest"> | import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/Route">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/Classify"> | import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/DetectRisk"> | import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/ExtractInvoice"> | import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/Ingest"> | import("@smthrs/flow/Action").Requirement<"examples/FinancialInboxGuard/Route">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
