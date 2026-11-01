/**
 * Extract receipt fields with per-field confidence and route the receipt only when enough fields are confident.
 *
 * Port of the 0.x `receipt-stream-watcher.jsx`. An extractor agent reads the
 * receipt file or text into merchant, total, date and currency, each with a
 * confidence. A consumer agent decides whether at least 3 fields reach 0.85
 * confidence. Only a receipt it calls ready goes to the routing agent, which
 * picks expense report, reimbursement, audit or manual review; otherwise the
 * flow settles with no routing.
 *
 * 0.x's name promises streaming, but its extractor returned one whole answer and its consumer read that; so does this port.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts written from the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The confidence at which a field counts as high-confidence. */
export declare const confidenceThreshold = 0.85;
/** How many high-confidence fields a receipt needs before it is routed. */
export declare const minFieldsForRouting = 3;
/** One extracted field and how sure the extractor is of it. */
export declare const FieldConfidence: Schema.Struct<{
    readonly value: Schema.NullOr<Schema.String>;
    readonly confidence: Schema.Number;
}>;
/** The extractor's answer. */
export declare const PartialExtraction: Schema.Struct<{
    readonly merchant: Schema.Struct<{
        readonly value: Schema.NullOr<Schema.String>;
        readonly confidence: Schema.Number;
    }>;
    readonly total: Schema.Struct<{
        readonly value: Schema.NullOr<Schema.String>;
        readonly confidence: Schema.Number;
    }>;
    readonly date: Schema.Struct<{
        readonly value: Schema.NullOr<Schema.String>;
        readonly confidence: Schema.Number;
    }>;
    readonly currency: Schema.Struct<{
        readonly value: Schema.NullOr<Schema.String>;
        readonly confidence: Schema.Number;
    }>;
    readonly lineItems: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly description: Schema.String;
        readonly amount: Schema.Number;
    }>>>;
    readonly iterationsUsed: Schema.Number;
    readonly complete: Schema.Boolean;
}>;
/** The consumer's verdict on the extraction. */
export declare const ConsumeResult: Schema.Struct<{
    readonly merchant: Schema.NullOr<Schema.String>;
    readonly total: Schema.NullOr<Schema.Number>;
    readonly date: Schema.NullOr<Schema.String>;
    readonly currency: Schema.NullOr<Schema.String>;
    readonly highConfidenceCount: Schema.Number;
    readonly readyForRouting: Schema.Boolean;
    readonly summary: Schema.String;
}>;
/** Where the receipt goes. */
export declare const RoutingDecision: Schema.Struct<{
    readonly destination: Schema.Literals<readonly ["expense-report", "reimbursement", "audit-review", "manual-review"]>;
    readonly merchant: Schema.String;
    readonly total: Schema.Number;
    readonly currency: Schema.String;
    readonly date: Schema.String;
    readonly reasoning: Schema.String;
    readonly summary: Schema.String;
}>;
/** What the flow settles with. `routing` is null when the receipt was not ready. */
export declare const Output: Schema.Struct<{
    readonly consumed: Schema.Struct<{
        readonly merchant: Schema.NullOr<Schema.String>;
        readonly total: Schema.NullOr<Schema.Number>;
        readonly date: Schema.NullOr<Schema.String>;
        readonly currency: Schema.NullOr<Schema.String>;
        readonly highConfidenceCount: Schema.Number;
        readonly readyForRouting: Schema.Boolean;
        readonly summary: Schema.String;
    }>;
    readonly routing: Schema.NullOr<Schema.Struct<{
        readonly destination: Schema.Literals<readonly ["expense-report", "reimbursement", "audit-review", "manual-review"]>;
        readonly merchant: Schema.String;
        readonly total: Schema.Number;
        readonly currency: Schema.String;
        readonly date: Schema.String;
        readonly reasoning: Schema.String;
        readonly summary: Schema.String;
    }>>;
}>;
/** Reads the receipt into fields with confidences. */
export declare const Extract: AgentAction.AgentAction<"examples/ReceiptStreamWatcher/Extract", Schema.Struct<{
    file: Schema.NullOr<Schema.String>;
    text: Schema.NullOr<Schema.String>;
    confidenceThreshold: Schema.Number;
}>, Schema.Struct<{
    readonly merchant: Schema.Struct<{
        readonly value: Schema.NullOr<Schema.String>;
        readonly confidence: Schema.Number;
    }>;
    readonly total: Schema.Struct<{
        readonly value: Schema.NullOr<Schema.String>;
        readonly confidence: Schema.Number;
    }>;
    readonly date: Schema.Struct<{
        readonly value: Schema.NullOr<Schema.String>;
        readonly confidence: Schema.Number;
    }>;
    readonly currency: Schema.Struct<{
        readonly value: Schema.NullOr<Schema.String>;
        readonly confidence: Schema.Number;
    }>;
    readonly lineItems: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly description: Schema.String;
        readonly amount: Schema.Number;
    }>>>;
    readonly iterationsUsed: Schema.Number;
    readonly complete: Schema.Boolean;
}>>;
/** Decides whether enough fields are confident to route. */
export declare const Consume: AgentAction.AgentAction<"examples/ReceiptStreamWatcher/Consume", Schema.Struct<{
    extraction: Schema.Struct<{
        readonly merchant: Schema.Struct<{
            readonly value: Schema.NullOr<Schema.String>;
            readonly confidence: Schema.Number;
        }>;
        readonly total: Schema.Struct<{
            readonly value: Schema.NullOr<Schema.String>;
            readonly confidence: Schema.Number;
        }>;
        readonly date: Schema.Struct<{
            readonly value: Schema.NullOr<Schema.String>;
            readonly confidence: Schema.Number;
        }>;
        readonly currency: Schema.Struct<{
            readonly value: Schema.NullOr<Schema.String>;
            readonly confidence: Schema.Number;
        }>;
        readonly lineItems: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly description: Schema.String;
            readonly amount: Schema.Number;
        }>>>;
        readonly iterationsUsed: Schema.Number;
        readonly complete: Schema.Boolean;
    }>;
    threshold: Schema.Number;
    minFields: Schema.Number;
}>, Schema.Struct<{
    readonly merchant: Schema.NullOr<Schema.String>;
    readonly total: Schema.NullOr<Schema.Number>;
    readonly date: Schema.NullOr<Schema.String>;
    readonly currency: Schema.NullOr<Schema.String>;
    readonly highConfidenceCount: Schema.Number;
    readonly readyForRouting: Schema.Boolean;
    readonly summary: Schema.String;
}>>;
/** Picks the downstream process for a ready receipt. */
export declare const Route: AgentAction.AgentAction<"examples/ReceiptStreamWatcher/Route", Schema.Struct<{
    merchant: Schema.NullOr<Schema.String>;
    total: Schema.NullOr<Schema.String>;
    currency: Schema.NullOr<Schema.String>;
    date: Schema.NullOr<Schema.String>;
    highConfidenceCount: Schema.Number;
}>, Schema.Struct<{
    readonly destination: Schema.Literals<readonly ["expense-report", "reimbursement", "audit-review", "manual-review"]>;
    readonly merchant: Schema.String;
    readonly total: Schema.Number;
    readonly currency: Schema.String;
    readonly date: Schema.String;
    readonly reasoning: Schema.String;
    readonly summary: Schema.String;
}>>;
/** The flow: extract, judge readiness, and route only a ready receipt. */
export declare const ReceiptStreamWatcher: Flow.Flow<"examples/ReceiptStreamWatcher", Schema.Struct<{
    file: Schema.optional<Schema.NullOr<Schema.String>>;
    text: Schema.optional<Schema.NullOr<Schema.String>>;
}>, Schema.Struct<{
    readonly consumed: Schema.Struct<{
        readonly merchant: Schema.NullOr<Schema.String>;
        readonly total: Schema.NullOr<Schema.Number>;
        readonly date: Schema.NullOr<Schema.String>;
        readonly currency: Schema.NullOr<Schema.String>;
        readonly highConfidenceCount: Schema.Number;
        readonly readyForRouting: Schema.Boolean;
        readonly summary: Schema.String;
    }>;
    readonly routing: Schema.NullOr<Schema.Struct<{
        readonly destination: Schema.Literals<readonly ["expense-report", "reimbursement", "audit-review", "manual-review"]>;
        readonly merchant: Schema.String;
        readonly total: Schema.Number;
        readonly currency: Schema.String;
        readonly date: Schema.String;
        readonly reasoning: Schema.String;
        readonly summary: Schema.String;
    }>>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/ReceiptStreamWatcher/Consume"> | import("@smthrs/flow/Action").Requirement<"examples/ReceiptStreamWatcher/Extract"> | import("@smthrs/flow/Action").Requirement<"examples/ReceiptStreamWatcher/Route">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/ReceiptStreamWatcher/Consume"> | import("@smthrs/flow/Action").Requirement<"examples/ReceiptStreamWatcher/Extract"> | import("@smthrs/flow/Action").Requirement<"examples/ReceiptStreamWatcher/Route">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
