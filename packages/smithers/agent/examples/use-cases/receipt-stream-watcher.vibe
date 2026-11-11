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
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The confidence at which a field counts as high-confidence. */
export const confidenceThreshold = 0.85

/** How many high-confidence fields a receipt needs before it is routed. */
export const minFieldsForRouting = 3

/** One extracted field and how sure the extractor is of it. */
export const FieldConfidence = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})

/** The extractor's answer. */
export const PartialExtraction = Schema.Struct({
  merchant: FieldConfidence,
  total: FieldConfidence,
  date: FieldConfidence,
  currency: FieldConfidence,
  lineItems: Schema.optional(Schema.Array(Schema.Struct({ description: Schema.String, amount: Schema.Number }))),
  iterationsUsed: Schema.Number,
  complete: Schema.Boolean
})

/** The consumer's verdict on the extraction. */
export const ConsumeResult = Schema.Struct({
  merchant: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.Number),
  date: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  highConfidenceCount: Schema.Number,
  readyForRouting: Schema.Boolean,
  summary: Schema.String
})

/** Where the receipt goes. */
export const RoutingDecision = Schema.Struct({
  destination: Schema.Literals(["expense-report", "reimbursement", "audit-review", "manual-review"]),
  merchant: Schema.String,
  total: Schema.Number,
  currency: Schema.String,
  date: Schema.String,
  reasoning: Schema.String,
  summary: Schema.String
})

/** What the flow settles with. `routing` is null when the receipt was not ready. */
export const Output = Schema.Struct({ consumed: ConsumeResult, routing: Schema.NullOr(RoutingDecision) })

/** Reads the receipt into fields with confidences. */
export const Extract = AgentAction.make("examples/ReceiptStreamWatcher/Extract", {
  payload: {
    file: Schema.NullOr(Schema.String),
    text: Schema.NullOr(Schema.String),
    confidenceThreshold: Schema.Number
  },
  output: PartialExtraction,
  seat,
  system: [
    `You are a receipt extraction agent. Read the provided receipt file or
text and extract structured fields (merchant, total, date, currency, line items).
For each field, assign a confidence score between 0 and 1. Stream partial results
as you identify each field — you do not need every field to produce output.`
  ],
  prompt: ({ confidenceThreshold, file, text }) =>
    `Extract the receipt's fields, each with a confidence.\n\nFile: ${JSON.stringify(file)}\nText: ${
      JSON.stringify(text)
    }\nConfidence threshold: ${confidenceThreshold}`
})

/** Decides whether enough fields are confident to route. */
export const Consume = AgentAction.make("examples/ReceiptStreamWatcher/Consume", {
  payload: { extraction: PartialExtraction, threshold: Schema.Number, minFields: Schema.Number },
  output: ConsumeResult,
  seat,
  system: [
    `You are a partial-state consumer. Evaluate the extracted fields and
their confidence scores. Determine whether enough high-confidence fields are present
to route the receipt downstream. A field is "high confidence" if its score is >= ${confidenceThreshold}.
At least ${minFieldsForRouting} high-confidence fields are needed for routing.`
  ],
  prompt: ({ extraction, minFields, threshold }) =>
    `Decide whether this receipt is ready for routing.\n\nThreshold: ${threshold}\nMinimum fields: ${minFields}\nExtraction: ${
      JSON.stringify(extraction)
    }`
})

/** Picks the downstream process for a ready receipt. */
export const Route = AgentAction.make("examples/ReceiptStreamWatcher/Route", {
  payload: {
    merchant: Schema.NullOr(Schema.String),
    total: Schema.NullOr(Schema.String),
    currency: Schema.NullOr(Schema.String),
    date: Schema.NullOr(Schema.String),
    highConfidenceCount: Schema.Number
  },
  output: RoutingDecision,
  seat,
  system: [
    `You are a receipt routing agent. Based on the extracted and validated
fields, decide which downstream process should handle this receipt: expense-report
(standard business expense), reimbursement (employee out-of-pocket), audit-review
(high-value or flagged), or manual-review (insufficient data).`
  ],
  prompt: ({ currency, date, highConfidenceCount, merchant, total }) =>
    `Route this receipt.\n\nFields: ${
      JSON.stringify({ merchant, total, currency, date })
    }\nHigh-confidence fields: ${highConfidenceCount}`
})

/** The flow: extract, judge readiness, and route only a ready receipt. */
export const ReceiptStreamWatcher = Flow.make("examples/ReceiptStreamWatcher", {
  payload: { file: Schema.optional(Schema.NullOr(Schema.String)), text: Schema.optional(Schema.NullOr(Schema.String)) },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({ file = null, text = null }) =>
    Node.bindPlanned(
      Extract.call({ file, text, confidenceThreshold }),
      (extraction: Planned.Planned<typeof PartialExtraction.Type>) =>
        Node.branch(Consume.call({ extraction, threshold: confidenceThreshold, minFields: minFieldsForRouting }), {
          if: (consumed) => consumed.readyForRouting,
          then: (consumed) =>
            Node.bindPlanned(
              Route.call({
                merchant: extraction.merchant.value,
                total: extraction.total.value,
                currency: extraction.currency.value,
                date: extraction.date.value,
                highConfidenceCount: consumed.highConfidenceCount
              }),
              (routing: Planned.Planned<typeof RoutingDecision.Type>) => Node.succeed({ consumed, routing })
            ),
          else: (consumed) => Node.succeed({ consumed, routing: null })
        })
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Extract.layer, Consume.layer, Route.layer)
