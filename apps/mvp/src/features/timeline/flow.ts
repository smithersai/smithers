import { Action, Flow } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { SUMMARIZE_FLOW, SUMMARY_REASONS } from "./contract"

export const SummaryPayload = {
  /** The answer summarized: the claim and the recorded summary are its. */
  id: Schema.String,
  revision: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(8000)),
  /** The question it answers, which the summary names. Runs journaled before it came have none. */
  question: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  /** Why the answer needs the model ({@link SUMMARY_REASONS}): recorded with the claim, never content. */
  reason: Schema.optional(Schema.Literals(SUMMARY_REASONS)),
}
export type SummaryPayload = Schema.Struct<typeof SummaryPayload>["Type"]
/**
 * A safe reason: outage, rejected output, provider policy, an unconfigured summary role, another tab, device or person
 * already summarizing this answer (`taken`, retained for recorded failures), or the person's daily summaries spent (`capped`).
 */
export class SummaryFailed extends Schema.TaggedError<SummaryFailed>()("timeline/SummaryFailed", {
  code: Schema.Literals(["unavailable", "invalid", "unconfigured", "refused", "taken", "capped"]),
}) {}
export const SummaryValue = Schema.Union([
  Schema.Struct({ summary: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("taken") }),
])
export const SummarizeEntry = Action.make("timeline/SummarizeEntry", {
  payload: SummaryPayload, success: SummaryValue, error: SummaryFailed, tier: "sealed",
})
export const Summarize = Flow.make(SUMMARIZE_FLOW, {
  description: "Summarize one finished answer, once for every device.",
  modelInvocable: false,
  payload: SummaryPayload, success: SummaryValue, error: SummaryFailed,
  body: Node.capture({ step: SummarizeEntry.name }, (payload: SummaryPayload) => SummarizeEntry.call(payload)),
}).annotate(Flow.Placement, Placement.client())
