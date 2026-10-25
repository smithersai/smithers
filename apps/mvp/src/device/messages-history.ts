import { Schema } from "effect"

const Part = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("step"),
  flow: Schema.String,
  status: Schema.Literals(["running", "done", "failed"]),
})

/** Deployed messages v3, before terminal model quota refusals (decision 0021). */
export const MessageV3 = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  status: Schema.Literals(["done", "streaming", "failed"]),
  questionId: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.Literals(["rate_limited", "model_error", "empty", "abandoned", "unfinished"])),
  modelId: Schema.NullOr(Schema.String),
  stopReason: Schema.NullOr(Schema.String),
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  position: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** The branch's conversation the row belongs to (decision 0013 §1); a row synced before it existed has none. */
  conversationId: Schema.optional(Schema.String),
  /**
   * An answer's steps, as the agent took them (docs/features/agent.md#parts), which the notifications panel shows. A
   * row the device kept from before the app read them has none until it changes.
   */
  parts: Schema.optional(Schema.Array(Part)),
})
