import { Schema } from "effect"

// What the browser's agent and ChatApi's answer routes exchange (docs/features/agent.md#the-answer-routes). Only what a
// person sees crosses: a question, its history, the answer's text and its parts. Never a cell's code, a flow's input
// or raw result, or a provider's error text.

/** One finished exchange of the conversation. */
export const Exchange = Schema.Struct({ question: Schema.String, answer: Schema.String })
export type Exchange = typeof Exchange.Type

/** An answer's turn: its question and the finished exchanges before it, oldest first. */
export const Turn = Schema.Struct({ question: Schema.String, history: Schema.Array(Exchange) })
export type Turn = typeof Turn.Type

/**
 * One step the agent took, as the answer shows it: the flow it called and how the call went. `id` is the call's place
 * in the run, `<frame>.<ordinal>`, so a replayed step keeps its id.
 */
export const Part = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("step"),
  flow: Schema.String,
  status: Schema.Literals(["running", "done", "failed"]),
})
export type Part = typeof Part.Type

/**
 * Why an answer failed: model credit or quota was spent (`quota`), the model was rate limited (`rate_limited`) or broke (`model_error`), answered nothing
 * (`empty`), or the agent ran out of frames before it answered (`unfinished`).
 */
export const AnswerFailure = Schema.Literals(["quota", "rate_limited", "model_error", "empty", "unfinished"])
export type AnswerFailure = typeof AnswerFailure.Type

/**
 * What the agent writes to an answer: its parts and the text it has written so far while it streams, then its text
 * when it settles as `done`, or its failure as `failed`. A settle without `parts` keeps the parts the answer has: a
 * run resumed after its agent step sealed doesn't see that step's events again. Token counts are what the model
 * reported for the whole answer.
 */
export const AnswerWrite = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("streaming"),
    parts: Schema.Array(Part),
    text: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("done"),
    text: Schema.String.check(Schema.isMinLength(1)),
    parts: Schema.optional(Schema.Array(Part)),
    inputTokens: Schema.optional(Schema.Int),
    outputTokens: Schema.optional(Schema.Int),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    failure: AnswerFailure,
    parts: Schema.optional(Schema.Array(Part)),
  }),
])
export type AnswerWrite = typeof AnswerWrite.Type
