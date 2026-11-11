/**
 * Identify a document's family, resolve the output schema for it at run time, and extract into that shape.
 *
 * Port of the 0.x `dynamic-schema-enricher.jsx`. A context agent names the
 * document's source, tenant and family. A resolver agent turns that into a
 * field specification with tenant overrides, an extractor agent fills those
 * fields from the raw content, and an output agent validates the extraction
 * into the typed record the flow settles with. The four steps run in order.
 *
 * 0.x declared the context and output steps with no agent, so each emitted its prompt element as a static value its schema could not accept; here both are agent steps, as their prompts and schemas intend.
 * 0.x's prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the resolver and extractor `read`, `bash` and `grep`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** The document families the context step chooses from. */
export const DocumentFamily = Schema.Literals([
  "invoice",
  "contract",
  "receipt",
  "onboarding",
  "support-ticket",
  "unknown"
])

/** Who sent the document, for whom, and what kind of document it is. */
export const Context = Schema.Struct({
  source: Schema.String,
  tenant: Schema.String,
  documentFamily: DocumentFamily,
  rawContent: Schema.String,
  detectedLanguage: Schema.String,
  summary: Schema.String
})

/** One field of a resolved schema. */
export const FieldSpec = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["string", "number", "boolean", "date", "array", "object"]),
  required: Schema.Boolean,
  description: Schema.String
})

/** A tenant's rule for one field. */
export const TenantOverride = Schema.Struct({ field: Schema.String, rule: Schema.String })

/** The output schema the resolver chose for this document. */
export const ResolvedSchema = Schema.Struct({
  schemaId: Schema.String,
  schemaFamily: Schema.String,
  fields: Schema.Array(FieldSpec),
  tenantOverrides: Schema.Array(TenantOverride),
  confidence: Fraction,
  summary: Schema.String
})

/** The fields the extractor filled. */
export const Extraction = Schema.Struct({
  schemaId: Schema.String,
  extractedFields: Schema.Record(Schema.String, Schema.Json),
  missingRequired: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  extractionConfidence: Fraction,
  summary: Schema.String
})

/** The validated record the flow settles with. */
export const TypedOutput = Schema.Struct({
  schemaId: Schema.String,
  tenant: Schema.String,
  documentFamily: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Json),
  valid: Schema.Boolean,
  validationErrors: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Names the document's source, tenant and family. */
export const ParseContext = AgentAction.make("examples/DynamicSchemaEnricher/Context", {
  payload: { rawInput: Schema.String, source: Schema.String, tenant: Schema.String },
  output: Context,
  seat,
  prompt: ({ rawInput, source, tenant }) =>
    `Identify this document's source, tenant, and document family, and detect its language.\n\nSource: ${source}\nTenant: ${tenant}\nDocument:\n${rawInput}`
})

/** Chooses the schema for the document's family and tenant. */
export const Resolve = AgentAction.make("examples/DynamicSchemaEnricher/Resolve", {
  payload: {
    documentFamily: Schema.String,
    tenant: Schema.String,
    source: Schema.String,
    detectedLanguage: Schema.String,
    schemaRegistry: Schema.String
  },
  output: ResolvedSchema,
  seat,
  system: [
    `You are a schema resolution specialist. Given a document's source, tenant, and family,
determine the correct output schema to use. Look up tenant-specific field overrides, select the
appropriate schema family, and return the full field specification with types and requirements.`
  ],
  prompt: ({ detectedLanguage, documentFamily, schemaRegistry, source, tenant }) =>
    `Resolve the output schema for this document.\n\nDocument family: ${documentFamily}\nTenant: ${tenant}\nSource: ${source}\nLanguage: ${detectedLanguage}\nSchema registry: ${schemaRegistry}`
})

/** Fills the resolved schema's fields from the raw content. */
export const Extract = AgentAction.make("examples/DynamicSchemaEnricher/Extract", {
  payload: {
    rawContent: Schema.String,
    schemaId: Schema.String,
    fields: Schema.Array(FieldSpec),
    tenantOverrides: Schema.Array(TenantOverride)
  },
  output: Extraction,
  seat,
  system: [
    `You are a structured data extractor. Given raw document content and a target schema
specification, extract every field defined in the schema. Flag any required fields that are missing
and note confidence levels. Handle ambiguous values by choosing the most likely interpretation.`
  ],
  prompt: ({ fields, rawContent, schemaId, tenantOverrides }) =>
    `Extract the fields of schema ${schemaId}.\n\nFields: ${JSON.stringify(fields)}\nTenant overrides: ${
      JSON.stringify(tenantOverrides)
    }\nContent:\n${rawContent}`
})

/** Validates the extraction into the final typed record. */
export const Output = AgentAction.make("examples/DynamicSchemaEnricher/Output", {
  payload: {
    schemaId: Schema.String,
    tenant: Schema.String,
    documentFamily: Schema.String,
    extractedFields: Schema.Record(Schema.String, Schema.Json),
    missingRequired: Schema.Array(Schema.String),
    warnings: Schema.Array(Schema.String),
    confidence: Schema.Number
  },
  output: TypedOutput,
  seat,
  prompt: ({ confidence, documentFamily, extractedFields, missingRequired, schemaId, tenant, warnings }) =>
    `Validate this extraction and produce the final typed output.\n\nSchema: ${schemaId}\nTenant: ${tenant}\nDocument family: ${documentFamily}\nExtracted fields: ${
      JSON.stringify(extractedFields)
    }\nMissing required: ${JSON.stringify(missingRequired)}\nWarnings: ${
      JSON.stringify(warnings)
    }\nConfidence: ${confidence}`
})

/** The flow: context, resolve, extract, output. */
export const DynamicSchemaEnricher = Flow.make("examples/DynamicSchemaEnricher", {
  payload: {
    document: Schema.optional(Schema.String),
    source: Schema.optional(Schema.String),
    tenant: Schema.optional(Schema.String),
    schemaRegistry: Schema.optional(Schema.String)
  },
  success: TypedOutput,
  error: AgentAction.AgentFailure,
  body: ({ document = "", schemaRegistry = "default", source = "unknown", tenant = "default" }) =>
    Node.bindPlanned(
      ParseContext.call({ rawInput: document, source, tenant }),
      (context: Planned.Planned<typeof Context.Type>) =>
        Node.bindPlanned(
          Resolve.call({
            documentFamily: context.documentFamily,
            tenant: context.tenant,
            source: context.source,
            detectedLanguage: context.detectedLanguage,
            schemaRegistry
          }),
          (resolved: Planned.Planned<typeof ResolvedSchema.Type>) =>
            Node.bindPlanned(
              Extract.call({
                rawContent: context.rawContent,
                schemaId: resolved.schemaId,
                fields: resolved.fields,
                tenantOverrides: resolved.tenantOverrides
              }),
              (extraction: Planned.Planned<typeof Extraction.Type>) =>
                Output.call({
                  schemaId: resolved.schemaId,
                  tenant: context.tenant,
                  documentFamily: context.documentFamily,
                  extractedFields: extraction.extractedFields,
                  missingRequired: extraction.missingRequired,
                  warnings: extraction.warnings,
                  confidence: extraction.extractionConfidence
                })
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(ParseContext.layer, Resolve.layer, Extract.layer, Output.layer)
