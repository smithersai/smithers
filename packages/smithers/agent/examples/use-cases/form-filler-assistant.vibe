/**
 * Extract known form fields, collect the missing required ones over bounded rounds, validate, and submit.
 *
 * Port of the 0.x `form-filler-assistant.jsx`. An extractor agent reads the
 * documents and user input into known and missing fields. When a required
 * field is missing, a clarification agent works through the user responses
 * the payload supplies, one round at a time, until it reports every required
 * field collected or `maxClarifications` rounds (default 5) have run. A
 * validator agent then normalizes the full field set, and only a valid
 * payload goes to the submission agent (target `stdout`, method `dry-run` by
 * default).
 *
 * As in 0.x, the clarification rounds read `userResponses` from the payload; no step waits on a person.
 * 0.x declared `validate` with a prompt but no agent, so it could not produce its schema; here it is an agent step.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts written from the same props.
 * 0.x gave the agents `read`, `grep`, `bash` and `write` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One field value and where it came from. */
export const FieldEntry = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  source: Schema.Literals(["document", "user-input", "inferred"]),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})

/** A field the sources did not fill. */
export const MissingField = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  required: Schema.Boolean
})

/** The extractor's answer. */
export const Extraction = Schema.Struct({
  knownFields: Schema.Array(FieldEntry),
  missingFields: Schema.Array(MissingField),
  documentType: Schema.String,
  summary: Schema.String
})

/** One clarification round's answer. */
export const Clarification = Schema.Struct({
  answeredFields: Schema.Array(FieldEntry),
  stillMissing: Schema.Array(MissingField),
  allRequiredCollected: Schema.Boolean,
  summary: Schema.String
})

/** The validated, normalized field set. */
export const Validation = Schema.Struct({
  valid: Schema.Boolean,
  fields: Schema.Array(Schema.Struct({
    name: Schema.String,
    value: Schema.String,
    valid: Schema.Boolean,
    error: Schema.optional(Schema.String)
  })),
  normalizedPayload: Schema.Record(Schema.String, Schema.String),
  summary: Schema.String
})

/** What the submission did. */
export const Submission = Schema.Struct({
  target: Schema.String,
  status: Schema.Literals(["submitted", "dry-run", "failed"]),
  responseCode: Schema.optional(Schema.Number),
  confirmationId: Schema.optional(Schema.String),
  fieldCount: Schema.Number,
  summary: Schema.String
})

/** What the flow settles with. `submission` is null when validation failed. */
export const Output = Schema.Struct({ validation: Validation, submission: Schema.NullOr(Submission) })

/** Reads the documents and user input into known and missing fields. */
export const Extract = AgentAction.make("examples/FormFillerAssistant/Extract", {
  payload: { documents: Schema.Array(Schema.Json), userInput: Schema.String, formSchema: Schema.Json },
  output: Extraction,
  seat,
  system: [
    `You are a document field extractor. Given source documents and user input,
identify all form-relevant fields you can extract with high confidence. Flag any required
fields that are missing or ambiguous. Be precise about confidence scores.`
  ],
  prompt: ({ documents, formSchema, userInput }) =>
    `Extract the form fields from these sources.\n\nDocuments: ${JSON.stringify(documents)}\nUser input: ${
      JSON.stringify(userInput)
    }\nForm schema: ${JSON.stringify(formSchema)}`
})

/** One round of collecting the missing fields. */
export const Clarify = AgentAction.make("examples/FormFillerAssistant/Clarify", {
  payload: {
    knownFields: Schema.Array(FieldEntry),
    missingFields: Schema.Array(MissingField),
    previousAnswers: Schema.Array(FieldEntry),
    userResponses: Schema.Array(Schema.Json)
  },
  output: Clarification,
  seat,
  system: [
    `You are a form-filling assistant that asks clear, concise follow-up questions
to collect missing required fields. When the user provides answers, validate them against
the expected format and merge them into the known field set.`
  ],
  prompt: ({ knownFields, missingFields, previousAnswers, userResponses }) =>
    `Collect the missing form fields.\n\nMissing fields: ${JSON.stringify(missingFields)}\nKnown fields: ${
      JSON.stringify(knownFields)
    }\nPrevious answers: ${JSON.stringify(previousAnswers)}\nUser responses: ${JSON.stringify(userResponses)}`
})

/** Validates and normalizes the complete field set. */
export const Validate = AgentAction.make("examples/FormFillerAssistant/Validate", {
  payload: {
    knownFields: Schema.Array(FieldEntry),
    collectedFields: Schema.Array(FieldEntry),
    formSchema: Schema.Json
  },
  output: Validation,
  seat,
  prompt: ({ collectedFields, formSchema, knownFields }) =>
    `Validate and normalize the complete field set.\n\nKnown fields: ${
      JSON.stringify(knownFields)
    }\nCollected fields: ${JSON.stringify(collectedFields)}\nForm schema: ${JSON.stringify(formSchema)}`
})

/** Submits a validated payload to the target. */
export const Submit = AgentAction.make("examples/FormFillerAssistant/Submit", {
  payload: {
    payload: Validation.fields.normalizedPayload,
    target: Schema.String,
    method: Schema.String,
    dryRun: Schema.Boolean
  },
  output: Submission,
  seat,
  system: [
    `You are a form submission agent. Given a validated payload and a target
form or API endpoint, submit the data using the appropriate method. For APIs, use curl
or equivalent. For file-based forms, write the structured output. Always confirm success.`
  ],
  prompt: ({ dryRun, method, payload, target }) =>
    `Submit this form payload.\n\nTarget: ${target}\nMethod: ${method}\nDry run: ${dryRun}\nPayload: ${
      JSON.stringify(payload)
    }`
})

type Extraction = typeof Extraction.Type
type Clarification = typeof Clarification.Type

type Requirements = Action.Requirement<
  | "examples/FormFillerAssistant/Extract"
  | "examples/FormFillerAssistant/Clarify"
  | "examples/FormFillerAssistant/Validate"
  | "examples/FormFillerAssistant/Submit"
>

type Step = Node.Node<typeof Output.Type, AgentAction.AgentFailure, Requirements>

/** What the rounds after extraction read from the payload. */
interface Settings {
  readonly formSchema: typeof Schema.Json.Type
  readonly userResponses: ReadonlyArray<typeof Schema.Json.Type>
  readonly maxClarifications: number
  readonly target: string
  readonly method: string
  readonly dryRun: boolean
}

/** Validates what was collected, and submits only a valid payload. */
const finish = (
  settings: Settings,
  extraction: Planned.Planned<Extraction>,
  latest: Planned.Planned<Clarification> | undefined
): Step =>
  Node.branch(
    Validate.call({
      knownFields: extraction.knownFields,
      collectedFields: latest === undefined ? [] : latest.answeredFields,
      formSchema: settings.formSchema
    }),
    {
      if: (validation) => validation.valid,
      then: (validation) =>
        Node.bindPlanned(
          Submit.call({
            payload: validation.normalizedPayload,
            target: settings.target,
            method: settings.method,
            dryRun: settings.dryRun
          }),
          (submission: Planned.Planned<typeof Submission.Type>) => Node.succeed({ validation, submission })
        ),
      else: (validation) => Node.succeed({ validation, submission: null })
    }
  )

/**
 * Clarification round `round`: settle once every required field is
 * collected, otherwise go again until the last planned round. Each round is
 * told what the previous one left missing and what it had answered.
 */
const clarify = (
  settings: Settings,
  extraction: Planned.Planned<Extraction>,
  round: number,
  latest: Planned.Planned<Clarification> | undefined
): Step =>
  Node.branch(
    Clarify.call({
      knownFields: extraction.knownFields,
      missingFields: latest === undefined ? extraction.missingFields : latest.stillMissing,
      previousAnswers: latest === undefined ? [] : latest.answeredFields,
      userResponses: settings.userResponses
    }),
    {
      if: (clarification) => clarification.allRequiredCollected,
      then: (clarification) => finish(settings, extraction, clarification),
      else: (clarification) =>
        round >= settings.maxClarifications
          ? finish(settings, extraction, clarification)
          : clarify(settings, extraction, round + 1, clarification)
    }
  )

/** The flow: extract, clarify while required fields are missing, validate, submit. */
export const FormFillerAssistant = Flow.make("examples/FormFillerAssistant", {
  payload: {
    documents: Schema.optional(Schema.Array(Schema.Json)),
    userInput: Schema.optional(Schema.String),
    formSchema: Schema.optional(Schema.Json),
    userResponses: Schema.optional(Schema.Array(Schema.Json)),
    maxClarifications: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    target: Schema.optional(Schema.String),
    method: Schema.optional(Schema.String),
    dryRun: Schema.optional(Schema.Boolean)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({
    documents = [],
    dryRun = true,
    formSchema = {},
    maxClarifications = 5,
    method = "dry-run",
    target = "stdout",
    userInput = "",
    userResponses = []
  }) => {
    const settings: Settings = { formSchema, userResponses, maxClarifications, target, method, dryRun }
    return Node.branch(Extract.call({ documents, userInput, formSchema }), {
      // 0.x's loop `until` held from the start when nothing required was missing, so no round ran.
      if: (extraction) => extraction.missingFields.every((field) => !field.required),
      then: (extraction) => finish(settings, extraction, undefined),
      else: (extraction) => clarify(settings, extraction, 1, undefined)
    })
  }
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Extract.layer, Clarify.layer, Validate.layer, Submit.layer)
