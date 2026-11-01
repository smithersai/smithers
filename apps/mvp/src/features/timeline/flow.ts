import { Action, Flow } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { MARK_LENGTH, PHASES_FLOW, SEGMENT_SPANS, SEGMENT_WINDOW, SUMMARIZE_FLOW, SUMMARY_REASONS } from "./contract"

export const SummaryPayload = {
  /** The message summarized: the claim and the recorded summary are its. */
  id: Schema.String,
  revision: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(8000)),
  /** For an answer, the question it answers; for a question, the answer before it, which resolves "it" and "those". */
  question: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  /** What the claim is for ({@link SUMMARY_REASONS}): recorded with it, never content. */
  reason: Schema.optional(Schema.Literals(SUMMARY_REASONS)),
}
export type SummaryPayload = Schema.Struct<typeof SummaryPayload>["Type"]
/**
 * A safe reason: outage, rejected output, provider policy, an unconfigured summary role, another tab, device or person
 * already summarizing this answer (`taken`, retained for recorded failures), the person's daily summaries spent
 * (`capped`), a model out of credit (`credit`), or our own route not answering (`server`), no fault of the model.
 */
export class SummaryFailed extends Schema.TaggedError<SummaryFailed>()("timeline/SummaryFailed", {
  code: Schema.Literals(["unavailable", "invalid", "unconfigured", "refused", "taken", "capped", "credit", "server"]),
}) {}
export const SummaryValue = Schema.Union([
  Schema.Struct({ summary: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("taken") }),
])
export const SummarizeEntry = Action.make("timeline/SummarizeEntry", {
  payload: SummaryPayload, success: SummaryValue, error: SummaryFailed, tier: "sealed",
})
export const Summarize = Flow.make(SUMMARIZE_FLOW, {
  description: "Summarize one settled message, once for every device.",
  modelInvocable: false,
  payload: SummaryPayload, success: SummaryValue, error: SummaryFailed,
  body: Node.capture({ step: SummarizeEntry.name }, (payload: SummaryPayload) => SummarizeEntry.call(payload)),
}).annotate(Flow.Placement, Placement.client())

export const SegmentPayload = {
  level: Schema.Literals([1, 2]),
  /** The message the segmentation starts at: its claim's and its record's. */
  anchorId: Schema.String,
  revision: Schema.String,
  items: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String.check(Schema.isMaxLength(MARK_LENGTH)), covered: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))) }))
    .check(Schema.isMinLength(1), Schema.isMaxLength(SEGMENT_WINDOW[1])),
  full: Schema.Boolean,
}
export type SegmentPayload = Schema.Struct<typeof SegmentPayload>["Type"]
export const SegmentValue = Schema.Union([
  Schema.Struct({ spans: Schema.Number.check(Schema.isLessThanOrEqualTo(SEGMENT_SPANS)) }),
  Schema.Struct({ outcome: Schema.Literal("taken") }),
])
export const SegmentSpans = Action.make("timeline/SegmentSpans", {
  payload: SegmentPayload, success: SegmentValue, error: SummaryFailed, tier: "sealed",
})
export const Phases = Flow.make(PHASES_FLOW, {
  description: "Divide a conversation's latest stretch into logical phases or arcs, once for every device.",
  modelInvocable: false,
  payload: SegmentPayload, success: SegmentValue, error: SummaryFailed,
  body: Node.capture({ step: SegmentSpans.name }, (payload: SegmentPayload) => SegmentSpans.call(payload)),
}).annotate(Flow.Placement, Placement.client())
