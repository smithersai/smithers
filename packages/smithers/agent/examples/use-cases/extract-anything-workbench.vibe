/**
 * Run candidate extractors over one input in parallel, validate each candidate, and pick the one to adopt.
 *
 * Port of the 0.x `extract-anything-workbench.jsx`. One extractor agent call
 * per named extractor (default `["auto"]`) runs over the same input and
 * target schema, all at once. Once every candidate is in, a validator agent
 * checks each one against the target schema, all at once. A preview agent
 * then compares the validated candidates, picks one, and recommends whether to
 * use, refine or discard it.
 *
 * 0.x's extract, validate and preview prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the extractor `read`, `bash` and `grep`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** One extractor's attempt. */
export const Candidate = Schema.Struct({
  extractorName: Schema.String,
  fields: Schema.Array(Schema.Struct({
    key: Schema.String,
    value: Schema.String,
    confidence: Fraction
  })),
  rawOutput: Schema.String,
  overallConfidence: Fraction
})

/** The validator's verdict on one candidate. */
export const Validation = Schema.Struct({
  extractorName: Schema.String,
  isValid: Schema.Boolean,
  errors: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  fieldCount: Schema.Number,
  confidenceScore: Fraction
})

/** The pick the flow settles with. */
export const Preview = Schema.Struct({
  selectedExtractor: Schema.NullOr(Schema.String),
  extractedData: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  summary: Schema.String,
  recommendation: Schema.Literals(["use", "refine", "discard"])
})

type Candidate = typeof Candidate.Type
type Validation = typeof Validation.Type

/** One extractor's run over the input. */
export const Extract = AgentAction.make("examples/ExtractAnythingWorkbench/Extract", {
  payload: { extractorName: Schema.String, input: Schema.Json, targetSchema: Schema.Json },
  output: Candidate,
  seat,
  system: [
    `You are a typed extractor. Given arbitrary input and a target schema,
extract structured fields with confidence scores. Be precise and honest about confidence.`
  ],
  prompt: ({ extractorName, input, targetSchema }) =>
    `Extract with the "${extractorName}" extractor.\n\nTarget schema: ${JSON.stringify(targetSchema)}\nInput: ${
      JSON.stringify(input)
    }`
})

/** Checks one candidate against the target schema. */
export const Validate = AgentAction.make("examples/ExtractAnythingWorkbench/Validate", {
  payload: { candidate: Candidate, targetSchema: Schema.Json },
  output: Validation,
  seat,
  system: [
    `You are a schema validator. Check extracted data against the target schema.
Flag missing fields, type mismatches, and low-confidence values. Be strict.`
  ],
  prompt: ({ candidate, targetSchema }) =>
    `Validate this candidate.\n\nTarget schema: ${JSON.stringify(targetSchema)}\nCandidate: ${
      JSON.stringify(candidate)
    }`
})

/** Compares the validated candidates and picks one. */
export const PreviewStep = AgentAction.make("examples/ExtractAnythingWorkbench/Preview", {
  payload: { validations: Schema.Array(Validation), candidates: Schema.Array(Candidate), input: Schema.Json },
  output: Preview,
  seat,
  system: [
    `You are an extraction reviewer. Compare validated candidates and pick the
best extractor. Summarise what was extracted and whether the pipeline should adopt it.`
  ],
  prompt: ({ candidates, input, validations }) =>
    `Pick the best extractor.\n\nInput: ${JSON.stringify(input)}\nValidations: ${
      JSON.stringify(validations)
    }\nCandidates: ${JSON.stringify(candidates)}`
})

/** A record of per-extractor results as a list in the payload's order. Pure, so it runs in a `Node.map`. */
const inOrder = <A>(names: ReadonlyArray<string>, byName: Readonly<Record<string, A>>): Array<A> =>
  names.map((name) => byName[name]!)

/**
 * The flow. `extractors` is real at plan time, so it sets how many extractor
 * and validator calls the plan holds.
 */
export const ExtractAnythingWorkbench = Flow.make("examples/ExtractAnythingWorkbench", {
  payload: {
    input: Schema.Json,
    targetSchema: Schema.Json,
    extractors: Schema.optional(Schema.Array(Schema.String))
  },
  success: Preview,
  error: AgentAction.AgentFailure,
  body: ({ extractors = ["auto"], input, targetSchema }) =>
    Node.bindPlanned(
      Node.all(Object.fromEntries(extractors.map((extractorName) => [
        extractorName,
        Extract.call({ extractorName, input, targetSchema })
      ]))),
      (candidates: Planned.Planned<Readonly<Record<string, Candidate>>>) =>
        Node.bindPlanned(
          Node.all(Object.fromEntries(extractors.map((extractorName) => [
            extractorName,
            Validate.call({ candidate: candidates[extractorName]!, targetSchema })
          ]))),
          (validations: Planned.Planned<Readonly<Record<string, Validation>>>) =>
            Node.bindPlanned(
              Node.map(Node.succeed({ names: extractors, candidates, validations }), (byName) => ({
                candidates: inOrder(byName.names, byName.candidates),
                validations: inOrder(byName.names, byName.validations)
              })),
              (lists) => PreviewStep.call({ input, validations: lists.validations, candidates: lists.candidates })
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Extract.layer, Validate.layer, PreviewStep.layer)
