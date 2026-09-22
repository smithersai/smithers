import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"

const Research = Schema.Struct({
  summary: Schema.String,
  keyPoints: Schema.Array(Schema.String)
})

const Article = Schema.Struct({
  article: Schema.String,
  wordCount: Schema.Number
})

/** The research step: a model call whose answer must be a `Research`. */
export const ResearchStep = AgentAction.make("simple-workflow/Research", {
  payload: { topic: Schema.String },
  output: Research,
  seat: "anthropic:claude-sonnet-5",
  system: ["You are a research assistant. Provide concise summaries and key points."],
  prompt: ({ topic }) => `Research this topic and provide a summary with 3-5 key points: ${topic}`
})

/** The writing step, which consumes the research step's typed fields. */
export const WriteStep = AgentAction.make("simple-workflow/Write", {
  payload: {
    summary: Schema.String,
    keyPoints: Schema.Array(Schema.String)
  },
  output: Article,
  seat: "anthropic:claude-sonnet-5",
  system: ["You are a technical writer. Write clear, engaging content."],
  prompt: ({ keyPoints, summary }) =>
    `Write a short article based on this research:\n\nSummary: ${summary}\nKey Points: ${JSON.stringify(keyPoints)}`
})

/**
 * The flow the registry discovers and the engine runs. Discovery tokenizes
 * `export default Flow.make(` and reads the `description`, `capabilities` and
 * `effects` literals without evaluating the module; the loader hands this same
 * value to the engine, so the contract the control plane admits is the one
 * that executes. The old `<Sequence>` is one `Node.bindPlanned`.
 */
export default Flow.make("simple-workflow", {
  description: "Researches a topic and writes a short article about it.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: Schema.Struct({ topic: Schema.String }),
  success: Article,
  error: AgentAction.AgentFailure,
  body: ({ topic }) =>
    ResearchStep.call({ topic }).pipe(
      Node.bindPlanned((research) => WriteStep.call({ summary: research.summary, keyPoints: research.keyPoints }))
    )
})
