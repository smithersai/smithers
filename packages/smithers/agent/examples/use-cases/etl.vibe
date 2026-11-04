/**
 * Extract records from a source, transform them, and load them to a destination.
 *
 * Port of the 0.x `etl.jsx`. An extractor agent reads the source into
 * records, a transformer agent applies the transformation rules, and a loader
 * agent writes the result to the destination. The transform and load prompts
 * show the first five records and count the rest, and the flow settles with
 * the loader's report.
 *
 * 0.x gave the extractor `read`, `bash` and `grep` and the loader `write` and `bash`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** How many records a transform or load prompt shows before it counts the rest. */
export const previewSize = 5

/** One record as the source holds it. */
export const RawRecord = Schema.Struct({
  id: Schema.String,
  raw: Schema.String,
  source: Schema.String
})

/** What the extractor read. */
export const Extracted = Schema.Struct({
  records: Schema.Array(RawRecord),
  totalExtracted: Schema.Number
})

/** One record after the transformation rules. */
export const TransformedRecord = Schema.Struct({
  id: Schema.String,
  transformed: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.String)
})

/** What the transformer produced, and the records it could not process. */
export const Transformed = Schema.Struct({
  records: Schema.Array(TransformedRecord),
  totalTransformed: Schema.Number,
  errors: Schema.Array(Schema.String)
})

/** The loader's report, and what the flow settles with. */
export const Loaded = Schema.Struct({
  totalLoaded: Schema.Number,
  destination: Schema.String,
  errors: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Reads the source into records. */
export const Extract = AgentAction.make("examples/Etl/Extract", {
  payload: { source: Schema.String, pattern: Schema.String, sourceFormat: Schema.String },
  output: Extracted,
  seat,
  system: [
    `You are a data extractor. Read data from the specified source and output
structured records. Handle encoding issues, pagination, and partial failures gracefully.`
  ],
  prompt: ({ pattern, source, sourceFormat }) =>
    `Extract data from: ${source}\nPattern: ${pattern}\nFormat: ${sourceFormat}`
})

/** The trailing line a prompt adds when it shows only the first records. */
const more = (remainingCount: number) => remainingCount > 0 ? `... and ${remainingCount} more` : ""

/** Applies the transformation rules to the extracted records. */
export const Transform = AgentAction.make("examples/Etl/Transform", {
  payload: {
    totalExtracted: Schema.Number,
    records: Schema.Array(RawRecord),
    remainingCount: Schema.Number,
    transformRules: Schema.String,
    targetFormat: Schema.String
  },
  output: Transformed,
  seat,
  system: [
    `You are a data transformer. Apply the specified transformations to each record.
Enrich with metadata, normalize formats, and flag any records that can't be processed.`
  ],
  prompt: ({ records, remainingCount, targetFormat, totalExtracted, transformRules }) =>
    `Transform these ${totalExtracted} records:\n\n${JSON.stringify(records)}\n${
      more(remainingCount)
    }\n\nTransformation rules:\n${transformRules}\n\nOutput format: ${targetFormat}`
})

/** Writes the transformed records to the destination. */
export const Load = AgentAction.make("examples/Etl/Load", {
  payload: {
    totalTransformed: Schema.Number,
    destination: Schema.String,
    records: Schema.Array(TransformedRecord),
    remainingCount: Schema.Number,
    onDuplicate: Schema.String
  },
  output: Loaded,
  seat,
  system: [
    `You are a data loader. Write the transformed records to the specified destination.
Handle conflicts, deduplication, and report any failures.`
  ],
  prompt: ({ destination, onDuplicate, records, remainingCount, totalTransformed }) =>
    `Load ${totalTransformed} transformed records to: ${destination}\n\nRecords:\n${JSON.stringify(records)}\n${
      more(remainingCount)
    }\n\nHandle duplicates: ${onDuplicate}`
})

/**
 * The first records a prompt shows and how many it leaves out. Pure, so it is
 * a `Node.map`, not a step.
 */
const preview = <A>({ records, total }: { readonly records: ReadonlyArray<A>; readonly total: number }) => ({
  records: records.slice(0, previewSize),
  remainingCount: Math.max(total - previewSize, 0)
})

/** The flow: extract, transform, load. */
export const Etl = Flow.make("examples/Etl", {
  payload: {
    source: Schema.String,
    destination: Schema.String,
    pattern: Schema.optional(Schema.String),
    sourceFormat: Schema.optional(Schema.String),
    transformRules: Schema.optional(Schema.String),
    targetFormat: Schema.optional(Schema.String),
    onDuplicate: Schema.optional(Schema.String)
  },
  success: Loaded,
  error: AgentAction.AgentFailure,
  body: ({
    destination,
    onDuplicate = "skip",
    pattern = "*",
    source,
    sourceFormat = "auto-detect",
    targetFormat = "JSON",
    transformRules = "Normalize and clean the data"
  }) =>
    Node.bindPlanned(
      Extract.call({ source, pattern, sourceFormat }),
      (extracted: Planned.Planned<typeof Extracted.Type>) =>
        Node.bindPlanned(
          Node.map(Node.succeed({ records: extracted.records, total: extracted.totalExtracted }), preview),
          (shown) =>
            Node.bindPlanned(
              Transform.call({
                totalExtracted: extracted.totalExtracted,
                records: shown.records,
                remainingCount: shown.remainingCount,
                transformRules,
                targetFormat
              }),
              (transformed: Planned.Planned<typeof Transformed.Type>) =>
                Node.bindPlanned(
                  Node.map(
                    Node.succeed({ records: transformed.records, total: transformed.totalTransformed }),
                    preview
                  ),
                  (loading) =>
                    Load.call({
                      totalTransformed: transformed.totalTransformed,
                      destination,
                      records: loading.records,
                      remainingCount: loading.remainingCount,
                      onDuplicate
                    })
                )
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Extract.layer, Transform.layer, Load.layer)
